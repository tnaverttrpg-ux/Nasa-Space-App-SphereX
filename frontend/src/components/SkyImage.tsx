import { useEffect, useRef, useState } from 'react'
import type { Candidate, GaiaSource } from '../api'
import { FIT, panBy, zoomAt, type View } from '../view'

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
  view?: View            // shared zoom/pan (client-side only); absent = fixed fit
  onView?: (v: View) => void
  underlay?: string      // image drawn beneath `src` (difference-over-A blending)
  opacity?: number       // opacity of `src` over the underlay (visual aid only)
  onInspect?: (x: number, y: number) => void   // click-to-inspect: grid pixel in display coords (x right, y down)
  marker?: { x: number; y: number } | null      // selected pixel (same grid for every panel)
}

// Overlays are drawn on the image (always on a black well), so they use fixed colours in both themes.
const OV = { pick: '#ffd27a', cross: '#e8e2d6', gaia: '#4ade80', candA: '#f0566c', candB: '#5b8cf0', sel: '#ffffff', label: '#d8d4ca', halo: '#000000' }

const kindStyle: Record<ImageKind, [string, string]> = {
  measured: ['Measured', 'text-ink'],
  derived: ['Derived', 'text-ink'],
  demo: ['Synthetic demo · not SPHEREx', 'text-warn'],
}

/** Square sky image. SVG overlays share the image pixel grid (viewBox = native size). Labels sit outside the pixels. */
export default function SkyImage({ src, alt, kind, label, caption, gaia, year, candidates, selected, onPick, crosshair = true, compact = false, className = '',
  view = FIT, onView, underlay, opacity = 1, onInspect, marker }: Props) {
  const [n, setN] = useState(0)
  const [failed, setFailed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const c = n / 2
  const [kindText, kindColor] = kindStyle[kind]
  const k = 1 / view.s                       // overlay stroke/text widths stay constant on screen while zoomed
  const box = useRef<HTMLDivElement>(null)
  const viewRef = useRef(view); viewRef.current = view
  const onViewRef = useRef(onView); onViewRef.current = onView
  const ptrs = useRef(new Map<number, { x: number; y: number }>())
  const moved = useRef(false)
  const downAt = useRef({ x: 0, y: 0 })
  const interactive = !!onView

  // Wheel must be a native non-passive listener so the page does not scroll while zooming.
  useEffect(() => {
    const el = box.current
    if (!el || !interactive) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      onViewRef.current?.(zoomAt(viewRef.current, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, Math.exp(-e.deltaY * 0.0015)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [interactive])

  const pointer = onView ? {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      // No pointer capture yet: a plain click must still reach candidate markers. Capture starts with a real drag.
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      moved.current = false; downAt.current = { x: e.clientX, y: e.clientY }; setDragging(true)
    },
    onPointerMove: (e: React.PointerEvent) => {
      const prev = ptrs.current.get(e.pointerId)
      if (!prev) return
      const r = box.current!.getBoundingClientRect()
      if (ptrs.current.size === 1) {
        if (!moved.current && Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) > 3) {
          moved.current = true
          box.current!.setPointerCapture(e.pointerId)   // keep panning even if the pointer leaves the box
        }
        onView(panBy(viewRef.current, (e.clientX - prev.x) / r.width, (e.clientY - prev.y) / r.height))
      } else if (ptrs.current.size === 2) {  // pinch: zoom about the midpoint by the change in finger distance
        if (!box.current!.hasPointerCapture(e.pointerId)) box.current!.setPointerCapture(e.pointerId)
        const [pa, pb] = [...ptrs.current.values()]
        const other = [...ptrs.current.entries()].find(([id]) => id !== e.pointerId)![1]
        const d0 = Math.hypot(pa.x - pb.x, pa.y - pb.y), d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y)
        const mu = ((e.clientX + other.x) / 2 - r.left) / r.width, mw = ((e.clientY + other.y) / 2 - r.top) / r.height
        if (d0 > 0) onView(zoomAt(viewRef.current, mu, mw, d1 / d0))
        moved.current = true
      }
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    },
    onPointerUp: (e: React.PointerEvent) => { ptrs.current.delete(e.pointerId); if (!ptrs.current.size) setDragging(false) },
    onPointerCancel: (e: React.PointerEvent) => { ptrs.current.delete(e.pointerId); if (!ptrs.current.size) setDragging(false) },
    // A drag that moved more than ~3 px is not a click (keeps candidate markers from being picked by panning).
    onClickCapture: (e: React.MouseEvent) => { if (moved.current) { e.stopPropagation(); e.preventDefault(); moved.current = false } },
    onDoubleClick: () => onView(FIT),
    // A click (not a drag: drags are cancelled in onClickCapture) selects the grid pixel under the cursor, accounting
    // for zoom/pan: image fraction = (box fraction - offset) / scale.
    onClick: (e: React.MouseEvent) => {
      if (!onInspect || !n) return
      const r = box.current!.getBoundingClientRect(), v = viewRef.current
      const gx = Math.floor((((e.clientX - r.left) / r.width - v.x) / v.s) * n), gy = Math.floor((((e.clientY - r.top) / r.height - v.y) / v.s) * n)
      if (gx >= 0 && gy >= 0 && gx < n && gy < n) onInspect(gx, gy)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      const v = viewRef.current, step = 0.1 / v.s
      const act: Record<string, () => View> = {
        '+': () => zoomAt(v, 0.5, 0.5, 1.25), '=': () => zoomAt(v, 0.5, 0.5, 1.25), '-': () => zoomAt(v, 0.5, 0.5, 0.8), '0': () => FIT,
        ArrowLeft: () => panBy(v, step, 0), ArrowRight: () => panBy(v, -step, 0), ArrowUp: () => panBy(v, 0, step), ArrowDown: () => panBy(v, 0, -step),
      }
      // Inside the focused viewport these keys navigate the image; they do not step frames.
      if (act[e.key]) { e.preventDefault(); e.stopPropagation(); onView(act[e.key]()) }
    },
  } : {}
  return (
    <figure className={`mx-auto w-full ${className}`}>
      <div ref={box} data-viewport={onView ? '' : undefined} tabIndex={onView ? 0 : undefined} role={onView ? 'application' : undefined}
        aria-label={onView ? `${alt}. Zoom ×${view.s.toFixed(1)}: wheel or +/− to zoom, drag or arrow keys to pan, 0 or double-click to fit` : undefined}
        className={`relative aspect-square w-full touch-none select-none overflow-hidden bg-black ring-1 ${kind === 'demo' ? 'ring-warn/60' : 'ring-line-strong'} ${onView ? (dragging ? 'cursor-grabbing' : view.s > 1 ? 'cursor-grab' : 'cursor-zoom-in') : ''}`}
        {...pointer}>
        {/* image + overlays share one transform, so they can never misalign */}
        <div data-testid="view-layer" className="absolute inset-0" style={{ transform: `translate(${view.x * 100}%, ${view.y * 100}%) scale(${view.s})`, transformOrigin: '0 0', transition: dragging ? 'none' : 'transform 90ms ease-out' }}>
        {underlay && <img src={underlay} alt="" aria-hidden className="pixelated absolute inset-0 h-full w-full" draggable={false} />}
        {failed ? (
          <div className="flex h-full items-center justify-center text-xs text-[#e0b45a]">Image failed to load</div>
        ) : (
          <img src={src} alt={alt} className="pixelated absolute inset-0 h-full w-full" draggable={false}
            style={{ opacity }} onLoad={e => { setN(e.currentTarget.naturalWidth); setFailed(false) }} onError={() => setFailed(true)} />
        )}
        {n > 0 && (
          <svg viewBox={`0 0 ${n} ${n}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            {crosshair && (
              <g stroke={OV.cross} strokeWidth={(n / 320) * k} opacity={0.8}>
                <line x1={c} y1={c - n * 0.08} x2={c} y2={c - n * 0.03} />
                <line x1={c} y1={c + n * 0.03} x2={c} y2={c + n * 0.08} />
                <line x1={c - n * 0.08} y1={c} x2={c - n * 0.03} y2={c} />
                <line x1={c + n * 0.03} y1={c} x2={c + n * 0.08} y2={c} />
              </g>
            )}
            {gaia && year != null && gaia.map(s => (
              <circle key={s.source_id} cx={s.x + 0.5 + s.dx_per_yr * (year - 2016)} cy={s.y + 0.5 + s.dy_per_yr * (year - 2016)}
                r={Math.max(0.9, 2.4 - (s.g - 10) * 0.12)} fill="none" stroke={OV.gaia} strokeWidth={(n / 450) * k} opacity={0.8} />
            ))}
            {candidates?.map((cd, i) => (
              // Mouse shortcut only; the keyboard-accessible control is the candidate table.
              <g key={i} className="pointer-events-auto cursor-pointer" onClick={e => { e.stopPropagation(); onPick?.(i) }}>
                <rect x={cd.x - 1.5} y={cd.y - 1.5} width={4} height={4} fill="transparent"
                  stroke={selected === i ? OV.sel : cd.sign === 'brighter_in_A' ? OV.candA : OV.candB}
                  strokeWidth={(n / (selected === i ? 110 : 260)) * k} strokeDasharray={selected === i ? undefined : `${0.6 * k} ${0.4 * k}`} />
                <text x={cd.x + 3 * k} y={cd.y - 1.5 * k} fontSize={(n / 30) * k} fontFamily="JetBrains Mono, monospace"
                  fill={selected === i ? OV.sel : OV.label} paintOrder="stroke" stroke={OV.halo} strokeWidth={(n / 220) * k}>{i + 1}</text>
              </g>
            ))}
            {marker && (
              <g data-testid="pixel-marker" data-x={marker.x} data-y={marker.y} fill="none">
                <rect x={marker.x} y={marker.y} width={1} height={1} stroke={OV.halo} strokeWidth={3 * (n / 400) * k} />
                <rect x={marker.x} y={marker.y} width={1} height={1} stroke={OV.pick} strokeWidth={1.4 * (n / 400) * k} />
                {[[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => (
                  <line key={`${dx}${dy}`} x1={marker.x + 0.5 + dx * (0.5 + 1.2 * k)} y1={marker.y + 0.5 + dy * (0.5 + 1.2 * k)}
                    x2={marker.x + 0.5 + dx * (0.5 + 4 * k)} y2={marker.y + 0.5 + dy * (0.5 + 4 * k)} stroke={OV.pick} strokeWidth={1.2 * (n / 400) * k} />
                ))}
              </g>
            )}
          </svg>
        )}
        </div>
        <span className="pointer-events-none absolute bottom-1 right-1.5 font-mono text-[10px] text-[#d8d4ca]/80">N↑ E←</span>
        {view.s > 1 && <span data-testid="zoom-badge" className="pointer-events-none absolute left-1.5 top-1 font-mono text-[10px] text-[#d8d4ca]/80">×{view.s.toFixed(1)}</span>}
      </div>
      <figcaption className="flex items-baseline gap-2 border-x border-b border-line bg-panel px-2 py-1 text-[11px]">
        {!compact && <span className={`shrink-0 font-medium ${kindColor}`}>{kindText}</span>}
        <span className="shrink-0 text-ink-3">{label}</span>
        {caption && <span className="ml-auto truncate font-mono text-ink">{caption}</span>}
      </figcaption>
    </figure>
  )
}
