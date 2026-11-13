import { useState } from 'react'
import type { Candidate, GaiaSource } from '../api'

interface Props {
  src: string
  alt: string
  badge: { text: string; tone: 'cyan' | 'violet' | 'amber' }
  caption?: string
  gaia?: GaiaSource[] | null
  year?: number | null
  candidates?: Candidate[]
  crosshair?: boolean
}

const tones = {
  cyan: 'bg-cyan-glow/15 text-cyan-glow ring-cyan-glow/40',
  violet: 'bg-violet-glow/15 text-violet-glow ring-violet-glow/40',
  amber: 'bg-amber-400/15 text-amber-300 ring-amber-400/50',
}

/** Square sky image; SVG overlays share the image's pixel grid (viewBox = native size). */
export default function SkyImage({ src, alt, badge, caption, gaia, year, candidates, crosshair = true }: Props) {
  const [n, setN] = useState(0)
  const [failed, setFailed] = useState(false)
  const c = n / 2
  return (
    <figure className="relative w-full">
      <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-space-950 ring-1 ring-space-700">
        {failed ? (
          <div className="flex h-full items-center justify-center text-sm text-red-300">Image failed to load</div>
        ) : (
          <img src={src} alt={alt} className="pixelated absolute inset-0 h-full w-full" draggable={false}
            onLoad={e => { setN(e.currentTarget.naturalWidth); setFailed(false) }} onError={() => setFailed(true)} />
        )}
        {n > 0 && (
          <svg viewBox={`0 0 ${n} ${n}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            {crosshair && (
              <g stroke="#22d3ee" strokeWidth={n / 300} opacity={0.85}>
                <line x1={c} y1={c - n * 0.09} x2={c} y2={c - n * 0.03} />
                <line x1={c} y1={c + n * 0.03} x2={c} y2={c + n * 0.09} />
                <line x1={c - n * 0.09} y1={c} x2={c - n * 0.03} y2={c} />
                <line x1={c + n * 0.03} y1={c} x2={c + n * 0.09} y2={c} />
              </g>
            )}
            {gaia && year != null && gaia.map(s => (
              <circle key={s.source_id} cx={s.x + 0.5 + s.dx_per_yr * (year - 2016)} cy={s.y + 0.5 + s.dy_per_yr * (year - 2016)}
                r={Math.max(0.9, 2.4 - (s.g - 10) * 0.12)} fill="none" stroke="#4ade80" strokeWidth={n / 400} opacity={0.75} />
            ))}
            {candidates?.map((k, i) => (
              <g key={i}>
                <rect x={k.x - 1.5} y={k.y - 1.5} width={4} height={4} fill="none"
                  stroke={k.sign === 'brighter_in_A' ? '#f472b6' : '#a78bfa'} strokeWidth={n / 250} strokeDasharray="0.6 0.4" />
                <text x={k.x + 3} y={k.y - 1.5} fontSize={n / 28} fill="#e9d5ff">{i + 1}</text>
              </g>
            ))}
          </svg>
        )}
        <span className={`absolute left-2 top-2 rounded-md px-2 py-0.5 text-[10px] font-semibold tracking-wider ring-1 ${tones[badge.tone]}`}>
          {badge.text}
        </span>
        <span className="absolute bottom-2 right-2 rounded bg-space-950/70 px-1.5 text-[10px] text-slate-400">N↑ E←</span>
      </div>
      {caption && <figcaption className="mt-1.5 truncate text-center font-mono text-xs text-slate-400">{caption}</figcaption>}
    </figure>
  )
}
