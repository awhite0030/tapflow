export function isInteractive(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true
}
