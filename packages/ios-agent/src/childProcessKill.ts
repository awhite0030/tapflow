import type { ChildProcess } from 'child_process'

// SIGKILL fallback if SIGTERM did not take — shared by TouchHelper and KeyboardHelperDaemon,
// which spawn non-detached helper processes (plain kill(), not a process group).
// ScreenCaptureStreamer / XCUITreeReader use their own variant (different timeout, and
// XCUITreeReader kills a process group) and are intentionally not folded into this helper.
export function killWithSigkillFallback(proc: ChildProcess | null, timeoutMs = 1000): void {
  if (!proc) return
  proc.kill('SIGTERM')
  const killTimer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
  killTimer.unref?.()
  proc.once('exit', () => clearTimeout(killTimer))
}
