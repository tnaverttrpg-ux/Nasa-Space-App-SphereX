import { X } from 'lucide-react'

export const GUIDE_KEY = 'spheretrack-guide-dismissed'

const STEPS = [
  ['Choose a target', 'Pick one of the challenge targets, type RA/Dec in degrees, or look up an object by name.'],
  ['Load observations', 'Press Search SPHEREx archive. A new target downloads each observation once (10–20 s each); after that it opens instantly.'],
  ['Compare dates', 'Play the sequence, or switch to Side-by-side, Blink or Difference to compare two dates.'],
  ['Inspect a source', 'Click any pixel for its original FITS value and quality flags. The Dashboard and Sky map tabs summarise quality and coverage.'],
] as const

/** First-use steps. Inline (never an overlay), so it cannot cover controls; dismissal is remembered by the caller. */
export default function Guide({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section id="guide" aria-labelledby="guide-title" className="mb-2 border border-line border-l-2 border-l-accent bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <h2 id="guide-title" className="text-[12px] font-semibold text-ink">Quick guide</h2>
        <span className="text-[11px] text-ink-3">four steps</span>
        <button type="button" onClick={onDismiss} className="ml-auto inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[11px] text-ink-2 hover:bg-hover hover:text-ink">
          <X size={12} aria-hidden />Got it
        </button>
      </div>
      <ol className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-4">
        {STEPS.map(([t, d], i) => (
          <li key={t} className="bg-panel px-3 py-2">
            <div className="flex items-baseline gap-1.5 text-[12px] font-medium text-ink"><span className="font-mono text-accent-ink">{i + 1}</span>{t}</div>
            <p className="mt-0.5 text-[11px] leading-snug text-ink-2">{d}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}
