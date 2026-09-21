import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  /**
   * The input's accessible name. A placeholder is not one: it disappears the moment someone types,
   * and axe's label rule counts a non-empty placeholder as a pass, so nothing static reports the
   * gap. Required rather than documented as expected: an optional prop with a comment asking for
   * it is a rule the compiler does not hold, and the next caller to leave it out ships an input
   * named by its placeholder alone.
   */
  'aria-label': string
}

export function SearchInput({ value, onChange, placeholder, className, 'aria-label': ariaLabel }: Props) {
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-8 pl-8 ${className ?? 'w-48'}`}
      />
    </div>
  )
}
