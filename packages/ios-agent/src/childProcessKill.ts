import type { ChildProcess } from 'child_process'

// SIGKILL fallback if SIGTERM did not take — shared by TouchHelper and KeyboardHelperDaemon,
// which spawn non-detached helper processes (plain kill(), not a process group).
// ScreenCaptureStreamer / XCUITreeReader use their own variant (different timeout, and
// XCUITreeReader kills a process group) and are intentionally not folded into this helper.
export function killWithSigkillFallback(proc: ChildProcess | null, timeoutMs = 1000): void {
  if (!proc) return
  // kill() returns false when the signal can't be delivered (e.g. already exited) — don't
  // arm the fallback in that case, or it fires later against a possibly-reused pid: 'exit'
  // already happened, so a once('exit', ...) attached now would never see it and clear it.
  if (!proc.kill('SIGTERM')) return
  const killTimer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
  killTimer.unref?.()
  const clear = () => clearTimeout(killTimer)
  proc.once('exit', clear)
  proc.once('error', clear)
}
