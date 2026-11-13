import { IconPlus } from './Icons'

interface FABProps {
  label: string
  onClick: () => void
  disabled?: boolean
}

/** Floating action button for creating new items. */
export default function FAB({ label, onClick, disabled }: FABProps) {
  return (
    <button type="button" className="fab" aria-label={label} disabled={disabled} onClick={onClick}>
      <IconPlus size={26} />
    </button>
  )
}
