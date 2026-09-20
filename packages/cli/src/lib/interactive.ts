/**
 * Whether this process may ask a question.
 *
 * **Both ends, not only the one that prints.** A guard on `stdout.isTTY` alone passes whenever the
 * output is a terminal, including when stdin is not — `tapflow setup ios </dev/null`, or a wrapper
 * that leaves stdin closed. clack then draws the prompt, the promise never settles, and node falls
 * out of the event loop and exits **0** with nothing after it: no results list, no
 * `SETUP INCOMPLETE` banner, and every step past the one that asked never runs. An exit 0 that
 * silently skipped half the setup is worse than not asking at all.
 *
 * Measured under a pty with stdin at `/dev/null`, on clack 1.7.0 and 1.8.1 alike: the prompt draws,
 * `confirm()` never settles, exit 0.
 *
 * **What it does not catch, and no descriptor test can.** A pty on *both* ends whose other end
 * nobody is holding looks exactly like a person who has not typed yet — `ssh -tt host 'tapflow
 * setup ios' </dev/null`, `docker run -t` without `-i`. Measured the same way: both `isTTY` read
 * `true`, the prompt draws, and the same exit 0 follows once the master closes. Ending that one
 * needs the prompt itself to give up when stdin reaches EOF, which is a different shape of fix.
 * This rule is the half the file descriptors can already answer.
 *
 * **A pipe carrying answers is refused, and it never worked anyway.** clack settles on a piped
 * stdin, so `yes | tapflow setup android` looks like it should work — and measured over three
 * questions in a row it answers the **first** and then never settles again, which is this bug with
 * one step's head start. The idiom is undocumented and was never whole; refusing it up front trades
 * a run that dies silently after one answer for one that reports every step and says
 * `SETUP INCOMPLETE`.
 *
 * Every prompt in `setup`, `init`, `admin init` and the net-filter approval reads this, so the
 * answer is one answer.
 */
export function isInteractive(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true
}
