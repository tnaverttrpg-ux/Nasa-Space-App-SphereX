import { Info } from 'lucide-react'
import { useId, useState } from 'react'

/** Small accessible tooltip: opens on hover and keyboard focus, closes on Escape/blur. */
const aligns = { center: 'left-1/2 -translate-x-1/2', start: '-left-16', end: '-right-2' }

export default function InfoTip({ label, children, side = 'top', align = 'center' }: {
  label: string; children: React.ReactNode; side?: 'top' | 'bottom'; align?: keyof typeof aligns
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-flex align-middle" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={`About ${label}`} aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(o => !o)}
        onKeyDown={e => e.key === 'Escape' && setOpen(false)}
        className="ml-1 rounded-full text-ink-3 hover:text-accent-ink focus-visible:text-accent-ink">
        <Info size={13} aria-hidden />
      </button>
      {open && (
        <span role="tooltip" id={id}
          className={`absolute ${aligns[align]} z-50 w-60 max-w-[80vw] rounded-md border border-line-strong bg-raised px-2.5 py-2 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-ink ${side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}>
          <b className="text-accent-ink">{label}.</b> {children}
        </span>
      )}
    </span>
  )
}
