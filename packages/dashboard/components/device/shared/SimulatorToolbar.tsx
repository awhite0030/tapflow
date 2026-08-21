'use client';

import { Camera, Link2, Loader2, Radio, RadioOff, RotateCw, Square, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useId } from 'react';
import type { ReactNode } from 'react';
import { Kbd, KbdGroup } from '@/components/ui/kbd';

/**
 * Every button this file renders carries an `aria-label` as well as a tooltip.
 *
 * They are icon-only — and lucide marks an icon with no a11y prop `aria-hidden`, in both the version
 * before this and after — while Radix attaches a tooltip's `aria-describedby` **only while it is
 * open**, which on touch is never. That is the same gap #447 named as the reason a disabled control
 * cannot explain itself, and until the network control needed a name to be found by, none of these
 * buttons had one: a screen reader read the whole toolbar as four unlabelled buttons.
 *
 * `platformSlot` and `launchSlot` arrive as `ReactNode` from the viewers, so their buttons are
 * labelled where they are built rather than here.
 */
function ShortcutTooltip({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="flex items-center gap-3">
      {label}
      <KbdGroup>
        {keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
      </KbdGroup>
    </span>
  );
}

interface SimulatorToolbarProps {
  joined: boolean;
  onScreenshot: () => void;
  onRecordToggle: () => void;
  recordState: 'idle' | 'recording' | 'uploading' | 'done';
  onRotate: () => void;
  onDeepLink: () => void;
  /** Platform-specific buttons rendered at the top (e.g. nav buttons, home, keyboard) */
  platformSlot?: ReactNode;
  /** Optional launch button rendered before platform buttons */
  launchSlot?: ReactNode;
  /** Network control (#607). Absent when the agent does not advertise `network-control`. */
  network?: NetworkControl;
}

export interface NetworkControl {
  position: 'waiting' | 'unknown' | 'online' | 'offline';
  /** Whether tapflow can still change it. Separate from where it is, because the protocol makes them
   *  separate — a device it can no longer steer still has a network state, and still shows it. */
  steerable: boolean;
  pending: boolean;
  onToggle: () => void;
}

/**
 * Four positions, and **none of them disables the button**.
 *
 * #447 settled that a control nothing acts on should be absent rather than disabled, because a
 * disabled control owes a reason and the only channel here is a tooltip, which never opens on touch.
 * That reasoning holds for a gate known before the control renders and fixed for the session — which
 * is what `full-reset` is, and what this is not. An unreadable network state arrives *after* the
 * control is on screen and can change while it is there, and hiding it then would be a trap: the
 * click is the only thing that produces a fresh `network:state`, so a control that vanishes when the
 * state goes unreadable can never come back.
 *
 * So `waiting` and `unknown` stay clickable, and neither is drawn in a position. They differ from
 * each other because saying "could not read" about a device that is merely slow is a claim made
 * before anything was asked.
 */
function networkLook({ position, steerable }: Pick<NetworkControl, 'position' | 'steerable'>) {
  // Said after the position, never instead of it. A device tapflow cannot steer is still somewhere,
  // and an earlier draft that replaced the position with "could not be read" made the control a
  // one-way ratchet — from that rendering every click asked for offline again, so a device taken
  // offline on an unconfirmed write could not be brought back.
  const cannot = steerable ? '' : ' tapflow can no longer change it.';
  switch (position) {
    case 'offline':
      // The only position with colour. It is a state a tester deliberately put the device into and
      // will forget about, and forgetting is what makes the next hour of testing confusing.
      return {
        Icon: RadioOff,
        className: steerable ? 'text-amber-500 hover:text-amber-500' : 'text-amber-500/60 hover:text-amber-500/60',
        status: `Device is offline.${cannot}`,
      };
    case 'online':
      return { Icon: Radio, className: steerable ? '' : 'text-muted-foreground', status: `Device is on the network.${cannot}` };
    case 'waiting':
      return { Icon: Radio, className: 'text-muted-foreground animate-pulse', status: 'Checking the network state.' };
    case 'unknown':
      return { Icon: Radio, className: 'text-muted-foreground', status: 'No network state has been reported.' };
  }
}

/**
 * What activating the button does from here — which is the button's name.
 *
 * **`aria-pressed` was tried and dropped.** A toggle can carry its state either in a stable name plus
 * `aria-pressed`, or in a name that says the next action; saying both makes "Take device offline,
 * pressed" — two grammars for one fact, and the second of them wrong.
 *
 * **And the two unreadable positions get a name with no direction in it.** "Take device offline"
 * there would assert the device is currently online, which is the same claim-from-silence that
 * `aria-pressed={false}` was dropped for — it does not stop being that claim by moving from the state
 * into the name. The pulse and the muted colour say "we do not know" to everyone who can see them;
 * this is what says it to everyone else, and unlike the description beside it a name cannot be
 * turned off by a verbosity setting.
 */
function networkAction({ position, steerable }: Pick<NetworkControl, 'position' | 'steerable'>) {
  const action = position === 'offline' ? 'Bring device online'
    : position === 'online' ? 'Take device offline'
      : 'Toggle device network';
  // **The caveat goes in the name, not only in the description.** A device tapflow has just said it
  // cannot steer still gets a name that promises the action, and the correction lived in the
  // `aria-describedby` sentence — the very channel the paragraph above calls unreliable, since a
  // verbosity setting can drop it. "Retry" is honest in both directions: the last attempt did not
  // land, and clicking will try again, which is not futile while #618 leaves a transient failure
  // indistinguishable from a permanent one.
  return steerable ? action : `Retry: ${action.toLowerCase()}`;
}

export function SimulatorToolbar({
  joined,
  onScreenshot,
  onRecordToggle,
  recordState,
  onRotate,
  onDeepLink,
  platformSlot,
  launchSlot,
  network,
}: SimulatorToolbarProps) {
  // Per instance, not a literal: this component takes all its state through props and is rendered per
  // device viewer, so two toolbars on screen would point both buttons' `aria-describedby` at the first
  // span — one device's control described by another device's network state. The unit tests render one
  // toolbar at a time and cannot see that.
  const descId = useId();
  if (!joined) return null;

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-col items-center gap-0.5 rounded-2xl border bg-background/90 backdrop-blur-sm px-1.5 py-2.5 shrink-0 mt-3">
        {launchSlot}
        {platformSlot}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open a deeplink" onClick={onDeepLink}>
              <Link2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><ShortcutTooltip label="Deeplink" keys={['⌘', 'K']} /></TooltipContent>
        </Tooltip>

        <div className="w-4 h-px bg-border my-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Take a screenshot" onClick={onScreenshot}>
              <Camera className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><ShortcutTooltip label="Screenshot" keys={['⌘', 'S']} /></TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost" size="icon"
              className={cn('h-8 w-8', recordState === 'recording' && 'text-red-500 hover:text-red-500')}
              // The name carries the state, so `aria-pressed` would say it twice — "Stop recording,
              // pressed" states the same fact in two grammars and reads as a contradiction. Pick one:
              // this button flips its name, so it is a plain action button.
              //
              // **All four states, not just `recording`.** While disabled it announced "Start
              // recording, unavailable" — the wrong action and no reason — and the tooltip cannot
              // supply one, because a disabled button suppresses pointer events so Radix never opens
              // it. The same #447 gap the network control above is built around.
              aria-label={
                recordState === 'recording' ? 'Stop recording'
                  : recordState === 'uploading' ? 'Processing the recording'
                    : recordState === 'done' ? 'Recording saved'
                      : 'Start recording'
              }
              disabled={recordState === 'uploading' || recordState === 'done'}
              onClick={onRecordToggle}
            >
              {recordState === 'uploading'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : recordState === 'recording'
                ? <Square className="h-4 w-4 fill-current" />
                : <Video className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {recordState === 'idle'
              ? <ShortcutTooltip label="Start recording" keys={['⌘', '⇧', 'Y']} />
              : recordState === 'recording'
              ? <ShortcutTooltip label="Stop recording" keys={['⌘', '⇧', 'Y']} />
              // The same four branches as the name above. Collapsing `uploading` and `done` here left
              // the two channels disagreeing for `done` — "Recording saved" read out, "Processing…"
              // on screen — which is stale for a sighted user and a Label-in-Name mismatch the moment
              // this trigger becomes hoverable (#624).
              : recordState === 'done' ? 'Recording saved' : 'Processing…'}
          </TooltipContent>
        </Tooltip>

        <div className="w-4 h-px bg-border my-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Rotate the device" onClick={onRotate}>
              <RotateCw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><ShortcutTooltip label="Rotate" keys={['⌘', '⇧', 'O']} /></TooltipContent>
        </Tooltip>

        {network && (() => {
          const { Icon, className, status } = networkLook(network);
          const label = networkAction(network);
          // Whether the *visible* tooltip needs the sentence too. A settled, steerable position says
          // enough in the name; the two with no position and the ones tapflow cannot change do not,
          // and a tooltip carrying a sentence for every position would be noise on the common one.
          const unsettled = network.position === 'waiting' || network.position === 'unknown' || !network.steerable;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost" size="icon"
                  className={cn('h-8 w-8', className)}
                  aria-label={label}
                  // The icon is swapped for a spinner and the live region says so once — neither is a
                  // property AT can query on the control, and `toggle` refuses a click for as long as
                  // this lasts, which is up to `NETWORK_REQUEST_DEADLINE_MS`.
                  aria-busy={network.pending}
                  aria-describedby={descId}
                  onClick={network.onToggle}
                >
                  {network.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              {/* The two positions the button cannot draw say why, and say it **outside the tooltip**:
                  Radix attaches a tooltip's own `aria-describedby` only while it is open, and on touch
                  it never opens — the same gap #447 named as the reason a disabled control cannot
                  explain itself. The colour and the pulse say it to everyone else.
                  `role="status"` because the sentence *changes on screen* — `useNetworkControl` flips
                  `waiting` to `unknown` on a timer — and a description that changes on an element
                  nobody is focused on is announced by no AT at all.
                  **Every position has a sentence, including the settled ones.** Clearing this to empty
                  on success announced nothing, so a screen-reader user heard the request begin and
                  never heard it finish — the failure path was announced and success was the silent
                  one. A name change on an already-focused button is not reliably re-announced, so the
                  name could not carry it either. */}
              {/* **Mounted unconditionally, with only the text toggled.** A live region inserted in the
                  same commit as its first sentence is routinely dropped by NVDA, JAWS and VoiceOver —
                  which would have silenced exactly the one case that replaced `aria-busy`, since
                  `online → pending` is where the region would have appeared. */}
              <span id={descId} role="status" className="sr-only">
                {network.pending ? 'Changing the network state.' : status}
              </span>
              {/* The visible text contains the accessible name (WCAG 2.5.3): a voice-control user says
                  what the tooltip shows, and the status is appended rather than substituted. */}
              <TooltipContent side="left">{unsettled ? `${label} — ${status}` : label}</TooltipContent>
            </Tooltip>
          );
        })()}
      </div>
    </TooltipProvider>
  );
}
