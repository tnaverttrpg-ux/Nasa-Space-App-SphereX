import { useState } from 'react'
import type { Candidate, GaiaSource } from '../api'

export type ImageKind = 'measured' | 'derived' | 'demo'

interface Props {
  src: string
  alt: string
  kind: ImageKind
  label: string          // e.g. "SPHEREx D6" or "A − k·B"
  caption?: string       // date / wavelength, shown in the strip under the image
  gaia?: GaiaSource[] | null
  year?: number | null
  candidates?: Candidate[]
  selected?: number | null
  onPick?: (i: number) => void
  crosshair?: boolean
  compact?: boolean      // thumbnails: omit the measured/derived word in the caption strip
  className?: string     // size constraints from the parent
}

// Overlays are drawn on the image (always on a black well), so they use fixed colours in both themes.
const OV = { cross: '#e8e2d6', gaia: '#4ade80', candA: '#f0566c', candB: '#5b8cf0', sel: '#ffffff', label: '#d8d4ca', halo: '#000000' }

const kindStyle: Record<ImageKind, [string, string]> = {
  measured: ['Measured', 'text-ink'],
  derived: ['Derived', 'text-ink'],
  demo: ['Synthetic demo · not SPHEREx', 'text-warn'],
}

/** Square sky image. SVG overlays share the image pixel grid (viewBox = native size). Labels sit outside the pixels. */
export default function SkyImage({ src, alt, kind, label, caption, gaia, year, candidates, selected, onPick, crosshair = true, compact = false, className = '' }: Props) {
  const [n, setN] = useState(0)
  const [failed, setFailed] = useState(false)
  const c = n / 2
  const [kindText, kindColor] = kindStyle[kind]
  return (
    <figure className={`mx-auto w-full ${className}`}>
      <div className={`relative aspect-square w-full overflow-hidden bg-black ring-1 ${kind === 'demo' ? 'ring-warn/60' : 'ring-line-strong'}`}>
        {failed ? (
          <div className="flex h-full items-center justify-center text-xs text-[#e0b45a]">Image failed to load</div>
        ) : (
          <img src={src} alt={alt} className="pixelated absolute inset-0 h-full w-full" draggable={false}
            onLoad={e => { setN(e.currentTarget.naturalWidth); setFailed(false) }} onError={() => setFailed(true)} />
        )}
        {n > 0 && (
          <svg viewBox={`0 0 ${n} ${n}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            {crosshair && (
              <g stroke={OV.cross} strokeWidth={n / 320} opacity={0.8}>
                <line x1={c} y1={c - n * 0.08} x2={c} y2={c - n * 0.03} />
                <line x1={c} y1={c + n * 0.03} x2={c} y2={c + n * 0.08} />
                <line x1={c - n * 0.08} y1={c} x2={c - n * 0.03} y2={c} />
                <line x1={c + n * 0.03} y1={c} x2={c + n * 0.08} y2={c} />
              </g>
            )}
            {gaia && year != null && gaia.map(s => (
              <circle key={s.source_id} cx={s.x + 0.5 + s.dx_per_yr * (year - 2016)} cy={s.y + 0.5 + s.dy_per_yr * (year - 2016)}
                r={Math.max(0.9, 2.4 - (s.g - 10) * 0.12)} fill="none" stroke={OV.gaia} strokeWidth={n / 450} opacity={0.8} />
            ))}
            {candidates?.map((k, i) => (
              // Mouse shortcut only; the keyboard-accessible control is the candidate table.
              <g key={i} className="pointer-events-auto cursor-pointer" onClick={() => onPick?.(i)}>
                <rect x={k.x - 1.5} y={k.y - 1.5} width={4} height={4} fill="transparent"
                  stroke={selected === i ? OV.sel : k.sign === 'brighter_in_A' ? OV.candA : OV.candB}
                  strokeWidth={n / (selected === i ? 110 : 260)} strokeDasharray={selected === i ? undefined : '0.6 0.4'} />
                <text x={k.x + 3} y={k.y - 1.5} fontSize={n / 30} fontFamily="JetBrains Mono, monospace"
                  fill={selected === i ? OV.sel : OV.label} paintOrder="stroke" stroke={OV.halo} strokeWidth={n / 220}>{i + 1}</text>
              </g>
            ))}
          </svg>
        )}
        <span className="absolute bottom-1 right-1.5 font-mono text-[10px] text-[#d8d4ca]/80">N↑ E←</span>
      </div>
      <figcaption className="flex items-baseline gap-2 border-x border-b border-line bg-panel px-2 py-1 text-[11px]">
        {!compact && <span className={`shrink-0 font-medium ${kindColor}`}>{kindText}</span>}
        <span className="shrink-0 text-ink-3">{label}</span>
        {caption && <span className="ml-auto truncate font-mono text-ink">{caption}</span>}
      </figcaption>
    </figure>
  )
}
