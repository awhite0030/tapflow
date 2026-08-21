'use client';

import { Camera, Link2, Loader2, Radio, RadioOff, RotateCw, Square, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
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
function networkLook(position: NetworkControl['position']) {
  switch (position) {
    case 'offline':
      // The only position with colour. It is a state a tester deliberately put the device into and
      // will forget about, and forgetting is what makes the next hour of testing confusing.
      return { Icon: RadioOff, className: 'text-amber-500 hover:text-amber-500', status: undefined };
    case 'online':
      return { Icon: Radio, className: '', status: undefined };
    case 'waiting':
      return { Icon: Radio, className: 'text-muted-foreground animate-pulse', status: 'Checking the network state.' };
    case 'unknown':
      return { Icon: Radio, className: 'text-muted-foreground', status: 'The network state could not be read.' };
  }
}

/**
 * `aria-pressed` for a control that has four positions and only two of them are pressedness.
 *
 * **Absent, not `false`, when the state is unknown.** `false` asserts the device is on the network,
 * which is the claim this whole design refuses to make from silence — the same boolean collapse the
 * agent shipped on the other side of this wire, arriving here through ARIA instead of through state.
 * Absent is how the platform spells "this toggle has no state to report".
 */
function networkPressed(position: NetworkControl['position']): boolean | undefined {
  if (position === 'offline') return true;
  if (position === 'online') return false;
  return undefined;
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
              aria-label={recordState === 'recording' ? 'Stop recording' : 'Start recording'}
              aria-pressed={recordState === 'recording'}
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
              : 'Processing…'}
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
          const { Icon, className, status } = networkLook(network.position);
          // **The name does not change with the position**, which is the APG shape for a toggle: the
          // state rides on `aria-pressed`, and a name that flipped between "Device is offline" and
          // "Take device offline" would leave voice control with no stable phrase and, when offline,
          // never say what activating it does.
          const label = 'Take device offline';
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost" size="icon"
                  className={cn('h-8 w-8', className)}
                  aria-label={label}
                  aria-pressed={networkPressed(network.position)}
                  aria-busy={network.pending}
                  aria-describedby={status ? 'network-state-desc' : undefined}
                  onClick={network.onToggle}
                >
                  {network.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              {/* The two positions that carry no pressedness say why, and say it **outside the
                  tooltip**: Radix attaches a tooltip's own `aria-describedby` only while it is open,
                  and on touch it never opens — the same gap #447 named as the reason a disabled
                  control cannot explain itself. The colour and the pulse say it to everyone else. */}
              {status && <span id="network-state-desc" className="sr-only">{status}</span>}
              <TooltipContent side="left">{status ?? label}</TooltipContent>
            </Tooltip>
          );
        })()}
      </div>
    </TooltipProvider>
  );
}
