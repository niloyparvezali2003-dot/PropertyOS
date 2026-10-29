import { Search } from 'lucide-react'

type SearchInputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
}: SearchInputProps) {
  return (
    <label className="search-input">
      <Search size={18} aria-hidden="true" />

      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </label>
  )
}