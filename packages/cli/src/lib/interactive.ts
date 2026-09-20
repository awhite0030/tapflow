export function isInteractive(): boolean {
  if (process.env.TAPFLOW_NONINTERACTIVE !== undefined) return false
  return process.stdout.isTTY === true && process.stdin.isTTY === true
}
