import { IconPlus } from './Icons'

interface FABProps {
  label: string
  onClick: () => void
}

/** Floating action button for creating new items. */
export default function FAB({ label, onClick }: FABProps) {
  return (
    <button type="button" className="fab" aria-label={label} onClick={onClick}>
      <IconPlus size={26} />
    </button>
  )
}
