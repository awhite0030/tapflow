/**
 * A component whose only job is to give the compiler something worth memoising: a derived array
 * and a callback, both of which it will hoist into a cache. `reactCompilerOn.test.tsx` renders it
 * and watches whether that cache is ever read.
 *
 * **Keep it boring.** The compiler skips fourteen syntax shapes in this package already, nine of
 * them `try`/`catch` (see the package AGENTS.md), and a skipped probe fails that test with a
 * message saying the compiler is off when it is on.
 */
export function CompilerProbe({ items }: { items: string[] }) {
  const upper = items.map((i) => i.toUpperCase())
  const onPick = () => upper.join(',')
  return (
    <ul onClick={onPick}>
      {upper.map((i) => <li key={i}>{i}</li>)}
    </ul>
  )
}
