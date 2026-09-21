/**
 * A component whose only job is to give the compiler something worth memoising: a derived array
 * and a callback, both of which it will hoist into a cache. `reactCompilerOn.test.tsx` renders it
 * and watches whether that cache is ever read.
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
