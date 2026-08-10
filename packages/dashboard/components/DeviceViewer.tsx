'use client';

import type { BrowserToRelay, SessionTerminatedReason } from '@tapflowio/protocol'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRelay } from '@/hooks/useRelay';
import { usePerfMode } from '@/hooks/usePerfMode';
import { IOSViewer } from './device/IOSViewer';
import { AndroidViewer } from './device/AndroidViewer';
import { SimulatorInfoCard } from './device/shared/SimulatorInfoCard';
import type { AndroidChrome, ChromeData, BrowserInbound } from '@/lib/types';
import type { FrameTiming, PerfHook } from './perf/types';
import { parseEnvelopeHeader, HEADER_SIZE, CODEC_H264, CODEC_AUDIO, type BinaryFrameHandler } from '@/lib/envelope';
import { useAudioPlayback } from '@/hooks/useAudioPlayback';
import type { ClipboardMessageHandler } from '@/hooks/useClipboardBridge';
import { canDecodeH264 } from '@/lib/decoders/pickDecoder';
import { resolveInputError } from '@/lib/inputErrorNotice';
import { StatsOverlay } from './perf/StatsOverlay';
import { MetricsPanel } from './perf/MetricsPanel';
import { toast } from 'sonner';

interface Props {
  sessionId: string;
  deviceId: string;
  buildId?: number;
  resetMode?: 'app-only' | 'full-erase';
  onRecordingUploaded?: () => void;
  /** Why this viewer stopped. The viewer cannot recover from any of these on its own — it holds a
   *  socket it can make no further progress on — so it reports upward and the parent decides where to go.
   *
   *  A **superset** of why the *relay* terminated the session. `busy-elsewhere` is the dashboard's own:
   *  the session is alive and another socket holds it, so no protocol reason describes it, and widening
   *  `SessionTerminatedReason` would let `session:terminated` carry a reason it can never mean. */
  onSessionEnded?: (reason: SessionTerminatedReason | 'busy-elsewhere' | 'mac-overloaded') => void;
}

export function DeviceViewer({ sessionId, deviceId, buildId, resetMode, onRecordingUploaded, onSessionEnded }: Props) {
  const sendRef = useRef<(msg: BrowserToRelay) => void>(() => {});
  // One reset per mount; see the boot handler below.
  const resetSentRef = useRef(false);
  // How many rebind re-boots are still waiting for their `device:ready`, and whether the app was
  // actually on the device when the first of them started.
  //
  // A counter, not a flag: a crash-looping agent produces several rebinds, each with its own boot
  // and its own ready. A boolean is cleared by the first ready, and the second then reinstalls —
  // destroying the app state this exists to preserve.
  //
  // `appInstalled` is captured because a rebind can land *during* an install, which is if anything
  // the likelier moment for an agent to die. Then the app is genuinely absent and the re-boot has
  // to install it after all; assuming otherwise leaves a Launch button for an app that is not
  // there. It cannot be read from `installed` at ready-time either — `device:booting` clears that
  // flag and the agent sends it on every boot, so it is always false by then.
  const rebindRef = useRef<{ pending: number; appInstalled: boolean }>({ pending: 0, appInstalled: false });
  const { perfMode, visible: perfVisible } = usePerfMode();

  // statsRef is set by StatsOverlay; perfMetricsPushRef is set by MetricsPanel
  const statsRef = useRef<PerfHook | null>(null);
  const perfMetricsPushRef = useRef<((t: FrameTiming) => void) | null>(null);
  // FIFO queue: one entry pushed per incoming frame, shifted on paint completion.
  // Prevents mis-attribution when multiple frames are in-flight through async decoders.
  const envelopeQueueRef = useRef<Array<{ capturedAt: number; relayedAt: number } | null>>([]);

  // Viewers call these; both are no-ops when overlays are not mounted
  const perfHookRef = useRef<PerfHook>({
    onFrameBegin: () => statsRef.current?.onFrameBegin(),
    onFrameEnd: (t) => {
      const env = envelopeQueueRef.current.shift() ?? null;
      const timing: FrameTiming = env ? { ...t, capturedAt: env.capturedAt, relayedAt: env.relayedAt } : t;
      statsRef.current?.onFrameEnd(timing);
      perfMetricsPushRef.current?.(timing);
    },
  });

  const [joined, setJoined] = useState(false);
  // The relay told us it is holding this session while its agent is gone (#426). Cleared by
  // whichever answer follows — `session:rebound` if it came back, and `session:terminated` takes
  // the viewer away entirely.
  const [agentAway, setAgentAway] = useState(false);
  const [deviceReady, setDeviceReady] = useState(false);
  const [chrome, setChrome] = useState<ChromeData | AndroidChrome | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  // What the agent on the other end implements. Absent ⇒ an agent predating the capability,
  // so the viewer degrades on purpose rather than inferring anything from a timeout.
  const [agentCapabilities, setAgentCapabilities] = useState<string[]>([]);
  const [swKeyboardVisible, setSwKeyboardVisible] = useState(false);
  const [swKeyboardPending, setSwKeyboardPending] = useState(false);

  // Active viewer registers its binary frame decoder here.
  // SimulatorViewer routes incoming binary frames to whichever viewer is mounted.
  const binaryFrameHandlerRef = useRef<BinaryFrameHandler | undefined>(undefined);

  // The mounted viewer's clipboard bridge registers here; replies are correlated by
  // requestId on its side, so this only has to hand the message over.
  const clipboardHandlerRef = useRef<ClipboardMessageHandler | undefined>(undefined);

  // Opt-in audio output (Android emulator first). Audio frames are codec-tagged and routed
  // straight to Web Audio — they never enter the video FIFO/decoder path. Always-on playback;
  // muting is delegated to the emulator's own volume keys.
  const { pushFrame: pushAudioFrame } = useAudioPlayback();

  const handleMessage = useCallback((msg: BrowserInbound) => {
    // Anything addressed to another session is not ours to act on. Before #445 an
    // `app:install-error` arrived unattributed and was applied to whichever viewer was mounted.
    //
    // The union now declares `sessionId` on every message that carries one, so this reads as a normal
    // narrowing rather than the widening it used to be — it was `in msg` because the local copy of
    // this union omitted the field on messages the wire always stamped it on.
    //
    // `'sessionId' in msg` stays, because some members genuinely carry none — `agents:listed` and
    // `error`, whose whole point is a failure the relay could not attribute.
    //
    // There used to be a `&& msg.sessionId` truthiness check too, for three messages that arrived
    // without one: the relay *replayed* `device:ready`, `session:chrome` and `session:deviceInfo` to a
    // re-joining viewer from its own cache and did not stamp them, while both agents did. The relay
    // stamps them now, so the three are scoped by this gate like everything else.
    //
    // Dropping that check also closes what it opened: nothing validates inbound messages (#444), so
    // `sessionId: ''` reaches here — and a falsy sessionId used to *pass* the gate and be applied to
    // whichever viewer was mounted. That is the unattributed-message defect #445 exists to prevent,
    // reachable through the hole that let the replay in. Now it is simply a mismatch and ignored.
    if ('sessionId' in msg && msg.sessionId !== sessionId) return;

    if (msg.type === 'session:joined') {
      // A join starts a boot cycle of its own (socket blip, re-entry). Any rebind still waiting for
      // a `device:ready` will never get one, and leaving it pending would make this cycle's ready
      // look like a rebind — suppressing installs for the rest of the mount.
      rebindRef.current = { pending: 0, appInstalled: false };
      setJoined(true);
      setAgentAway(false);
      setAgentCapabilities(msg.capabilities ?? []);
      // Tell the agent up front whether this browser can decode H.264 so it picks the
      // codec accordingly; false (old/unsupported browser) → agent streams JPEG.
      // secureContext (localhost/HTTPS) → the agent can stream full res (WebCodecs hw-decodes it);
      // non-secure (LAN-HTTP) → it downscales for the WASM decoder. The relay adds `external`.
      // Only the first boot of this mount carries the reset. `session:joined` arrives again whenever
      // the socket reconnects (useRelay retries after 2s, and the effect below re-sends
      // `session:start` on `connected`), so a Wi-Fi blip or a sleeping laptop would otherwise
      // re-erase the device the user is currently looking at — with no click involved (#439).
      const reset = resetSentRef.current ? 'app-only' : resetMode;
      resetSentRef.current = true;
      sendRef.current({ type: 'device:boot', sessionId, payload: { deviceId, resetMode: reset, acceptH264: canDecodeH264(), secureContext: window.isSecureContext } });
    }
    if (msg.type === 'session:agent-away') {
      // Everything on screen describes an agent that is no longer there. Drop the frame so the
      // status card is what the tester sees — a picture that has simply stopped updating is the
      // thing #426 was opened about.
      setAgentAway(true);
      setChrome(null);
      setDeviceReady(false);
      return;
    }
    if (msg.type === 'session:terminated') {
      onSessionEnded?.(msg.reason);
      return;
    }
    if (msg.type === 'session:rebound') {
      // The agent restarted under us. Nothing is streaming, but until the new agent answers, every
      // flag here still describes the old one — and the relay cannot tell a viewer to stop, since
      // its own "agent offline" check sees a live socket (the new agent's). So tear down first,
      // then ask for the device back.
      //
      // `device:booting` clears most of this, but only once the new agent replies; these three it
      // never clears at all, and before rebinding existed a dead agent unmounted the viewer so they
      // could not outlive it. Now they can: a restart during a launch would leave the button
      // spinning on an `app:launch-done` that died with the old agent.
      setDeviceReady(false);
      setChrome(null);
      setInstalling(false);
      setInstallError(null);
      setBootError(null);
      setLaunching(false);
      setSwKeyboardPending(false);
      setSwKeyboardVisible(false);
      envelopeQueueRef.current = [];
      setAgentCapabilities(msg.capabilities);

      const wasAnnounced = agentAway;
      setAgentAway(false);
      rebindRef.current = {
        pending: rebindRef.current.pending + 1,
        appInstalled: rebindRef.current.pending > 0 ? rebindRef.current.appInstalled : installed,
      };
      // Always `app-only`: a restart is not a request to erase the device (#439). Deriving this
      // from `resetSentRef` the way the `session:joined` branch does would happen to agree today,
      // only because a rebind cannot precede a join on the same mount — and would silently become
      // a wipe the day that stops holding.
      resetSentRef.current = true;
      sendRef.current({ type: 'device:boot', sessionId, payload: { deviceId, resetMode: 'app-only', acceptH264: canDecodeH264(), secureContext: window.isSecureContext } });
      // Only when the status card has not been saying it already — otherwise the toast lands at the
      // exact moment that message is replaced by the reconnect, saying the same thing twice.
      if (!wasAnnounced) toast.info('The agent restarted — reconnecting to the device.');
      return;
    }
    if (msg.type === 'device:boot-error') {
      // Joining a session whose agent is away answers `session:joined`, and the branch above sends
      // `device:boot` on the strength of it — which the relay refuses with `agent offline`. The
      // waiting state already says what is happening, and recording a boot failure on top of it
      // only waits for a status-card reordering to start telling the tester a recovery failed.
      if (agentAway) return;
      // Release the rebind: without this a failed re-boot would suppress every later install for
      // the life of the mount.
      rebindRef.current = { pending: 0, appInstalled: false };
      setBootError(msg.message);
    }
    // An input the device never got. Deliberately no session-level state behind this: the acks are
    // per-input, unordered (a dispatch is awaited before its ack while a refusal is not) and do not
    // say which channel answered — on Android buttons always take the adb path while touch takes the
    // pointer channel on any streaming session. A latch built on them cleared itself on an unrelated
    // success, and no message carries evidence that input is working again, so it had no honest clear
    // edge either. The toast's own lifetime is the state: repeats reuse
    // `id`, which sonner refreshes rather than stacks, so it stays up while inputs keep failing and
    // fades on its own when they stop. See `.work/2026-08-08-dashboard-input-error-plan.md`.
    if (msg.type === 'input:error') {
      // Suppressed while the agent is away, matching what `device:boot-error` does two branches down
      // and for a sharper reason: an absent agent cannot send this, so in that state the *relay*
      // answers every terminal input itself (`RelayServer.ts`, `channel-unavailable`). A
      // tapping tester would refresh this toast indefinitely, and its advice would contradict the
      // status card — which already says the relay is holding the session open and waiting.
      if (agentAway) return;
      const { key, notice } = resolveInputError(msg.reason);
      // A reason this build does not know about is normalised away, and without this line it would
      // vanish with it: the tester correctly sees the conservative copy, but nobody can tell the
      // dashboard is behind its agents. That is the situation the growth of this union guarantees, so
      // it needs a trace. Absence is *not* logged — a pre-#490 agent omits the field on every input,
      // and that case is documented rather than surprising.
      if (msg.reason !== undefined && msg.reason !== key) {
        console.debug(`[tapflow] unrecognised input:error reason "${msg.reason}", treated as ${key}`);
      }
      if (notice) {
        // `sessionId` in the id so a toast still on screen from the session just left cannot be
        // refreshed by a failure in the next one.
        toast.error(notice.title, {
          id: `input:${sessionId}:${key}`,
          description: `${notice.action} (${msg.message})`,
          // The only "state" this design has. A finite lifetime is what makes the toast disappear
          // when inputs stop failing, with no clear signal — set explicitly and above sonner's
          // 4000ms default, which is short enough to lapse between two unhurried taps.
          duration: 6000,
        });
      } else {
        console.debug(`[tapflow] input refused, shown nowhere: ${key} — ${msg.message}`);
      }
    }
    // `input:done` is deliberately not handled. It was only ever needed to release the latch above,
    // and there is no latch.

    if (msg.type === 'device:booting') {
      setDeviceReady(false);
      setInstalling(false);
      setInstalled(false);
      setInstallError(null);
      setBootError(null);
      setChrome(null); // causes active viewer to unmount → cleanup
    }
    if (msg.type === 'device:ready') {
      setDeviceReady(true);
      if (rebindRef.current.pending > 0) {
        const { appInstalled } = rebindRef.current;
        rebindRef.current = { pending: rebindRef.current.pending - 1, appInstalled };
        if (appInstalled) {
          // Skipping the install means `app:install-done` never arrives, and `installed` gates the
          // Launch control — so restore it here or the tester silently loses that button.
          setInstalled(true);
          return;
        }
        // The install had not finished when the agent went away, so the app really is missing.
        // Fall through and install it.
      }
      if (buildId) { setInstalling(true); sendRef.current({ type: 'app:install', sessionId, buildId }); }
    }
    if (msg.type === 'app:install-done') { setInstalling(false); setInstalled(true); }
    if (msg.type === 'app:install-error') { setInstalling(false); setInstallError(msg.message); }
    if (msg.type === 'app:launch-done') { setLaunching(false); }
    if (msg.type === 'app:launch-error') { setLaunching(false); }
    if (msg.type === 'session:chrome') { setChrome(msg.payload); }
    if (msg.type === 'keyboard:toggled') {
      const { visible } = msg.payload;
      setSwKeyboardVisible(visible);
      setSwKeyboardPending(false);
    }
    if (msg.type === 'clipboard:data' || msg.type === 'clipboard:write-done' || msg.type === 'clipboard:error') {
      clipboardHandlerRef.current?.(msg);
    }
    if (msg.type === 'open-url:done') { toast.success('Deeplink opened'); }
    if (msg.type === 'open-url:error') { toast.error(msg.message); }
    // Branch on `reason`, never on `message`. The prose version handled two of the three wordings the
    // relay sends, so `Session busy` arrived and did nothing — and nothing reported it, because from
    // the outside `error` *was* a handled type. The switch is exhaustive, so a fourth reason is a
    // compile error rather than another silent case.
    if (msg.type === 'error') {
      switch (msg.reason) {
        case 'session-not-found':
          // Nothing else is ever coming for it. Reached when a browser blip outlasts the hold the relay
          // keeps after an agent goes away (#426): the re-join lands after the window closed, and
          // `session:terminated` went to a socket that no longer existed. Without this the tab waits on
          // a message that cannot arrive.
          onSessionEnded?.('agent-disconnected');
          return;
        case 'session-busy':
          // The session is alive and someone else holds it — so this is not `agent-disconnected`, and
          // saying so would send the tester to re-pick a Mac that is working fine.
          onSessionEnded?.('busy-elsewhere');
          return;
        case 'agent-resources-exhausted':
          // Exit, not just a toast. The relay `return`s after sending this, so no `session:joined` and no
          // `session:terminated` follows — a toast alone left the tab sitting on "Starting device…"
          // forever, which is the state this whole layer is about. Making `reason` required stopped a
          // case from being unhandled; it did not make the three handled cases *end* the same way, and
          // this was the one that did not.
          onSessionEnded?.('mac-overloaded');
          return;
      }
    }
  }, [sessionId, deviceId, buildId, onSessionEnded, resetMode, installed, agentAway]);

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    const envelope = parseEnvelopeHeader(data);
    // Audio is a separate pipeline: hand the PCM to Web Audio and return before touching the
    // video FIFO/decoder. (It must not enter envelopeQueueRef — that's video-frame correlation.)
    if (envelope && envelope.codec === CODEC_AUDIO) {
      pushAudioFrame(data.slice(HEADER_SIZE));
      return;
    }
    // iOS H.264 presents asynchronously through a decoder surface; its viewer's
    // FrameLatencyTracker owns capturedAt/relayedAt correlation (via meta), so it
    // must not also go through this FIFO — a dropped frame would desync it forever.
    // JPEG (iOS) and Android stay synchronous/FIFO-matched here.
    if (!(envelope && envelope.codec === CODEC_H264)) {
      envelopeQueueRef.current.push(envelope);
    }
    const payload = envelope ? data.slice(HEADER_SIZE) : data;
    const meta = envelope
      ? { codec: envelope.codec, keyframe: envelope.keyframe, capturedAt: envelope.capturedAt, relayedAt: envelope.relayedAt }
      : undefined;
    binaryFrameHandlerRef.current?.(payload, meta);
  }, [pushAudioFrame]);

  const { send, connected } = useRelay(handleMessage, handleBinaryFrame);
  useLayoutEffect(() => { sendRef.current = send; });

  useEffect(() => {
    if (connected) send({ type: 'session:start', sessionId });
  }, [connected, send, sessionId]);

  // Derive platform from chrome payload shape
  const iosChrome = chrome !== null && 'framePng' in chrome ? chrome as ChromeData : null;
  const androidChrome = chrome !== null && !('framePng' in chrome) ? chrome as AndroidChrome : null;

  const onKbdToggle = () => {
    setSwKeyboardPending(true);
    send({ type: 'input:keyboard:toggle', sessionId });
  };

  const commonProps = {
    sessionId, buildId, send, connected, joined,
    deviceReady, installing, installed, installError, bootError,
    launching, setLaunching,
    binaryFrameHandlerRef,
    clipboardHandlerRef,
    clipboardSupported: agentCapabilities.includes('clipboard'),
    onRecordingUploaded,
    swKeyboardVisible, swKeyboardPending, onKbdToggle,
  };

  // Before chrome arrives, show a phone skeleton + status card so the layout isn't empty
  if (!iosChrome && !androidChrome) {
    return (
      <div className="flex items-start justify-center gap-16">
        {/* toolbar placeholder */}
        <div className="flex flex-col items-center gap-0.5 rounded-2xl border bg-background/90 px-1.5 py-2.5 shrink-0 mt-3 opacity-40">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 w-8 rounded-md bg-muted animate-pulse" />
          ))}
        </div>
        <div className="flex items-start gap-8">
          {/* phone body skeleton */}
          <div style={{ background: '#1c1c1e', borderRadius: '34px', padding: '12px', flexShrink: 0 }}>
            <div className="animate-pulse bg-zinc-700" style={{ width: 324, height: 720, borderRadius: '22px' }} />
          </div>
          <SimulatorInfoCard
            joined={joined} fps={0} connected={connected}
            deviceReady={deviceReady} bootError={bootError}
            installing={installing} installError={installError}
            keyboardActive={false} agentAway={agentAway}
          />
        </div>
      </div>
    );
  }

  const devPerfHookRef = import.meta.env.DEV ? perfHookRef : undefined;

  return (
    <>
      {iosChrome && <IOSViewer {...commonProps} chrome={iosChrome} perfHookRef={devPerfHookRef} />}
      {androidChrome && <AndroidViewer {...commonProps} androidButtons={androidChrome.buttons} screenWidth={androidChrome.screenWidth} screenHeight={androidChrome.screenHeight} cornerRadius={androidChrome.cornerRadius} perfHookRef={devPerfHookRef} />}
      {import.meta.env.DEV && perfMode && perfVisible && (
        <>
          <StatsOverlay perfHookRef={statsRef} />
          <MetricsPanel pushRef={perfMetricsPushRef} />
        </>
      )}
    </>
  );
}
