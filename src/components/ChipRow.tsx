interface ChipItem<T extends string | number> {
  key: T
  label: string
}

interface ChipRowProps<T extends string | number> {
  items: ChipItem<T>[]
  value: T
  onChange: (value: T) => void
  /** Extra class for the chips container (e.g. `modal` for in-form rows). */
  className?: string
}

/** Horizontal filter chips row; highlights the active value. */
export default function ChipRow<T extends string | number>({
  items,
  value,
  onChange,
  className,
}: ChipRowProps<T>) {
  return (
    <div className={className ? `chips ${className}` : 'chips'}>
      {items.map((item) => (
        <button
          key={String(item.key)}
          type="button"
          className={`chip ${value === item.key ? 'active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
