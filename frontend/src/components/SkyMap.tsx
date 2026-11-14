import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Crosshair, Focus, Maximize, Minus, MousePointerClick, Plus, ScanSearch, X } from 'lucide-react'
import type { Observation, ObsResponse } from '../api'
import { contains, coverageRuns, DENSITY_LABELS, densityBin, normalizeWinding, screenToSky, tanProject, toScreen } from '../sky'
import InfoTip from './InfoTip'
import type { Slot } from './Viewer'

/* Sky coverage map. Geometry comes ONLY from the archive's s_region (whole-detector footprints) and from SPHERE TRACK's
   own grid definition (the displayed field: a north-up square of side FOV centred on the target, i.e. exactly the
   grid_wcs tangent plane). Native cutout outlines are not stored, so they are not drawn. Nothing is approximated. */

type Pt = [number, number]
type Fp = { o: Observation; pts: Pt[] | null; why: string | null; bb: [number, number, number, number] | null }
type MapView = { cx: number; cy: number; w: number }      // centre + width of the visible window, screen-plane degrees
type Filter = 'all' | 'loaded' | 'unloaded' | 'selected'
type SortKey = 'date' | 'detector' | 'wave'
const MIN_W = 0.05, MAX_W = 40
const ROW_PX = 2                                           // density shading: one exact scanline per 2 screen px
const DENSITY_FILL = ['fill-accent/[0.10]', 'fill-accent/[0.20]', 'fill-accent/[0.32]', 'fill-accent/[0.46]', 'fill-accent/[0.62]']
const DENSITY_SWATCH = ['bg-accent/[0.10]', 'bg-accent/[0.20]', 'bg-accent/[0.32]', 'bg-accent/[0.46]', 'bg-accent/[0.62]']
const mjdDate = (mjd: number) => new Date((mjd - 40587) * 864e5).toISOString().replace('T', ' ').slice(0, 16)
const sexa = (deg: number, hours: boolean) => {
  const v = hours ? deg / 15 : Math.abs(deg), a = Math.floor(v), b = Math.floor((v - a) * 60), c = ((v - a) * 60 - b) * 60
  return `${hours ? '' : deg < 0 ? '−' : '+'}${String(a).padStart(2, '0')}${hours ? 'h' : '°'}${String(b).padStart(2, '0')}${hours ? 'm' : '′'}${c.toFixed(hours ? 1 : 0).padStart(hours ? 4 : 2, '0')}${hours ? 's' : '″'}`
}
const fmtDec = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(5)}`
const covers = (f: Fp, [x, y]: Pt) => f.bb![0] <= x && x <= f.bb![2] && f.bb![1] <= y && y <= f.bb![3] && contains(f.pts!, [x, y])
const GRID = 'md:grid-cols-[9.5rem_8.5rem_3.5rem_6rem_5rem_minmax(6.5rem,1fr)]'   // overlap-inspector table columns (≥768 px)
const wave = (o: Observation) => (o.em_min_um + o.em_max_um) / 2
const SORTS: Record<SortKey, (a: Observation, b: Observation) => number> = {
  date: (a, b) => a.mjd_start - b.mjd_start,
  detector: (a, b) => a.band.localeCompare(b.band) || a.mjd_start - b.mjd_start,
  wave: (a, b) => wave(a) - wave(b) || a.mjd_start - b.mjd_start,
}

export default function SkyMap({ obsInfo, slots, band, fov, demo, selectedUrl, requestedUrl, onPick }: {
  obsInfo: ObsResponse | null; slots: Slot[]; band?: string; fov?: number; demo: boolean
  selectedUrl?: string; requestedUrl?: string | null; onPick: (o: Observation) => void
}) {
  const target = obsInfo?.target
  const rows = useMemo(() => obsInfo?.all_observations ?? obsInfo?.observations ?? [], [obsInfo])
  // projected once per search; hover, pan and zoom only reuse these
  const fps: Fp[] = useMemo(() => !target ? [] : rows.map(o => {
    const f = o.footprint
    if (!f || f.status !== 'ok' || !f.vertices) return { o, pts: null, bb: null, why: f ? `${f.status}${f.reason ? `: ${f.reason}` : ''}` : 'no footprint field' }
    const proj = f.vertices.map(([ra, dec]) => tanProject(target.ra, target.dec, ra, dec))
    if (proj.some(p => p == null)) return { o, pts: null, bb: null, why: 'invalid: vertex ≥90° from the target cannot be projected' }
    const pts = normalizeWinding(proj.map(p => toScreen(p!)))
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    return { o, pts, why: null, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }
  }), [rows, target])
  const drawn = useMemo(() => fps.filter(f => f.pts).sort((a, b) => a.o.mjd_start - b.o.mjd_start), [fps])
  const stMap = useMemo(() => new Map(slots.map(s => [s.id, s.status])), [slots])
  const status = (o: Observation) => stMap.get(o.access_url) ?? 'not loaded'
  const bad = fps.filter(f => !f.pts)

  // ---- presentation filter + isolation (they never change the underlying rows)
  const [filter, setFilter] = useState<Filter>('all')
  const [isolate, setIsolate] = useState(false)
  const loadedF = (f: Fp) => stMap.get(f.o.access_url) === 'ok'
  const counts: Record<Filter, number> = { all: drawn.length, loaded: drawn.filter(loadedF).length, unloaded: drawn.filter(f => !loadedF(f)).length,
    selected: drawn.filter(f => f.o.access_url === selectedUrl).length }
  const visible = useMemo(() => drawn.filter(f => filter === 'all' || (filter === 'selected' ? f.o.access_url === selectedUrl : (stMap.get(f.o.access_url) === 'ok') === (filter === 'loaded'))),
    [drawn, filter, stMap, selectedUrl])
  const selVis = visible.find(f => f.o.access_url === selectedUrl)
  const isolated = isolate && !!selVis

  // ---- view (screen-plane degrees), size from the container
  const box = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 600, h: 380 })
  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver(([e]) => { const w = Math.max(240, e.contentRect.width); setSize({ w, h: Math.round(Math.min(460, Math.max(280, w * 0.62))) }) })
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])
  // extent of every valid footprint + target + displayed field (Fit all, and the minimap's frame)
  const ext = useMemo(() => {
    const half = (fov ?? 0) / 2
    const xs = [0, -half, half, ...drawn.flatMap(f => [f.bb![0], f.bb![2]])], ys = [0, -half, half, ...drawn.flatMap(f => [f.bb![1], f.bb![3]])]
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }, [drawn, fov])
  const fitAll = (): MapView => ({ cx: ext.x + ext.w / 2, cy: ext.y + ext.h / 2, w: Math.min(MAX_W, Math.max(MIN_W, Math.max(ext.w, ext.h * size.w / size.h) * 1.12)) })
  const toTarget = (): MapView => ({ cx: 0, cy: 0, w: Math.max(1, (fov ?? 0.1) * 12) })
  const [view, setView] = useState<MapView>({ cx: 0, cy: 0, w: 8 })
  const [probe, setProbe] = useState<Pt | null>(null)          // inspected sky position [RA, Dec]
  const sig = `${target?.ra}|${target?.dec}|${band}|${rows.length}`
  useEffect(() => { setView(fitAll()); setProbe(null) }, [sig, size.w > 0]) // eslint-disable-line react-hooks/exhaustive-deps
  const vh = view.w * size.h / size.w
  const vb = { x: view.cx - view.w / 2, y: view.cy - vh / 2, w: view.w, h: vh }
  const k = view.w / size.w                                  // degrees per screen pixel
  const toPx = ([x, y]: Pt) => [((x - vb.x) / vb.w) * size.w, ((y - vb.y) / vb.h) * size.h]
  const fromEvent = (e: { clientX: number; clientY: number }): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    return [vb.x + ((e.clientX - r.left) / r.width) * vb.w, vb.y + ((e.clientY - r.top) / r.height) * vb.h]
  }
  const zoom = (f: number, at?: Pt) => setView(v => {
    const w = Math.min(MAX_W, Math.max(MIN_W, v.w * f)), [ax, ay] = at ?? [v.cx, v.cy]
    return { w, cx: ax + (v.cx - ax) * (w / v.w), cy: ay + (v.cy - ay) * (w / v.w) }
  })
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const at = fromEvent(e); zoom(Math.exp(e.deltaY * 0.0015), at) }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }) // re-bound each render so it sees the current view

  // ---- overlap density over the footprints visible under the current filter. Exact even-odd coverage along one
  //      horizontal scanline per ROW_PX screen pixels: x boundaries are exact, y is sampled at each row's centre.
  const [show, setShow] = useState({ footprints: true, target: true, field: true, density: true, minimap: true })
  const density = useMemo(() => {
    if (!show.density || !show.footprints || !visible.length) return null
    const t0 = performance.now(), d = ['', '', '', '', ''], rowH = ROW_PX * vb.w / size.w
    const dp = Math.max(0, Math.ceil(-Math.log10(rowH)) + 2), f = (v: number) => v.toFixed(dp)
    for (let y = vb.y; y < vb.y + vb.h; y += rowH) {
      const yc = y + rowH / 2
      const runs = coverageRuns(visible.filter(v => v.bb![1] <= yc && yc <= v.bb![3]).map(v => v.pts!), yc, vb.x, vb.x + vb.w)
      for (let i = 0; i < runs.length; i++) {                // merge touching runs of the same class
        const b = densityBin(runs[i][2]), xa = runs[i][0]; let xb = runs[i][1]
        while (i + 1 < runs.length && runs[i + 1][0] === xb && densityBin(runs[i + 1][2]) === b) xb = runs[++i][1]
        d[b] += `M${f(xa)} ${f(y)}H${f(xb)}V${f(y + rowH)}H${f(xa)}Z`
      }
    }
    return { d, ms: performance.now() - t0 }
  }, [show.density, show.footprints, visible, vb.x, vb.y, vb.w, vb.h, size.w])

  // ---- overlap inspector: clicked screen point -> sky RA/Dec -> polygon containment
  const [scope, setScope] = useState<'all' | 'visible'>('all')
  // Inspect (default) only reads geometry: it never selects, so it never starts a download. Select = the original behaviour.
  const [clickMode, setClickMode] = useState<'inspect' | 'select'>('inspect')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: 1 })
  const probed = useMemo(() => {
    if (!probe || !target) return null
    const p = tanProject(target.ra, target.dec, probe[0], probe[1])
    const pool = scope === 'all' ? drawn : visible
    const pt = p && toScreen(p)
    return { pt, pool: pool.length, hits: pt ? pool.filter(f => covers(f, pt)) : [] }
  }, [probe, target, scope, drawn, visible])
  const hitRows = probed ? probed.hits.map(f => f.o).sort((a, b) => SORTS[sort.key](a, b) * sort.dir) : []

  // ---- interaction: drag to pan (a drag is not a click), hover lists everything under the cursor
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const [hover, setHover] = useState<{ px: number; py: number; under: Fp[] } | null>(null)
  const under = (pt: Pt) => visible.filter(f => covers(f, pt))
  const top = (list: Fp[]) => list.find(f => f.o.access_url === selectedUrl) ?? list.sort((a, b) => b.o.mjd_start - a.o.mjd_start)[0]
  const requested = requestedUrl ? rows.find(o => o.access_url === requestedUrl) : undefined
  const scaleDeg = [0.1, 0.25, 0.5, 1, 2, 5].find(d => d / k >= 60) ?? 5

  // ---- minimap: fixed frame = extent of all valid footprints; click/drag moves the main view
  const mm = useRef<{ off: Pt } | null>(null)
  const mmW = size.w < 480 ? 104 : 140, mmPad = 0.06
  const mmBox = { x: ext.x - ext.w * mmPad, y: ext.y - ext.h * mmPad, w: ext.w * (1 + 2 * mmPad), h: ext.h * (1 + 2 * mmPad) }
  const mmH = Math.round(Math.min(mmW, Math.max(56, mmW * mmBox.h / mmBox.w)))
  const mmPoint = (svg: SVGSVGElement, e: { clientX: number; clientY: number }): Pt => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse()); return [p.x, p.y]
  }

  if (demo) return <div data-testid="map-demo" className="border border-line bg-panel px-3 py-8 text-center text-[12px] text-ink-3">Synthetic demo data has no sky position or archive footprints.</div>
  if (!target) return <div data-testid="map-empty" className="border border-line bg-panel px-3 py-8 text-center text-[12px] text-ink-3">Load a target to see its observation footprints.</div>

  const btn = 'inline-flex h-7 items-center justify-center gap-1 rounded-sm border border-line-strong px-2 text-[11px] text-ink-2 hover:bg-hover hover:text-ink'
  const seg = (on: boolean) => `inline-flex h-6 items-center gap-1 px-2 text-[11px] transition-colors ${on ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'}`
  const probeScreen = probed?.pt
  const sortHead = (key: SortKey, label: string) => (
    <button type="button" onClick={() => setSort(s => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }))} aria-label={`Sort by ${label}`}
      aria-pressed={sort.key === key} className={`inline-flex items-center gap-0.5 text-left ${sort.key === key ? 'text-ink' : 'text-ink-3 hover:text-ink'}`}>
      {label}{sort.key === key && (sort.dir === 1 ? <ArrowUp size={10} aria-hidden /> : <ArrowDown size={10} aria-hidden />)}
    </button>)

  return (
    <section aria-label="Sky coverage map" data-testid="skymap" className="space-y-2">
      <div className="border border-line bg-panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-[11px]">
          <span className="font-semibold text-ink">Sky coverage</span>
          <span className="text-ink-3">{band} · {drawn.length} of {rows.length} footprints · gnomonic projection centred on target · N↑ E←</span>
          <InfoTip label="Footprints" align="start">Outlines are the archive's whole-detector footprints (s_region, ~3.5° across), not the cutouts SPHERE TRACK displays. Overlapping outlines mean the detectors pointed there; they do not guarantee valid pixels (masks, edges and flags still apply).</InfoTip>
          <div className="ml-auto flex flex-wrap items-center gap-1" role="group" aria-label="Map controls">
            <button className={btn} onClick={() => zoom(0.8)} aria-label="Map zoom in"><Plus size={12} aria-hidden /></button>
            <button className={btn} onClick={() => zoom(1.25)} aria-label="Map zoom out"><Minus size={12} aria-hidden /></button>
            <button className={btn} onClick={() => setView(fitAll())} aria-label="Fit all footprints"><Maximize size={12} aria-hidden />Fit all</button>
            <button className={btn} onClick={() => setView(toTarget())} aria-label="Reset to target"><Crosshair size={12} aria-hidden />Target</button>
            {(['footprints', 'density', 'target', 'field', 'minimap'] as const).map(kk => (
              <label key={kk} className="ml-1 inline-flex items-center gap-1 text-ink-2"><input type="checkbox" checked={show[kk]} onChange={e => setShow(s => ({ ...s, [kk]: e.target.checked }))} className="h-3 w-3" />
                {kk === 'field' ? 'displayed field' : kk === 'density' ? 'overlap density' : kk}</label>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1 text-[11px]">
          <span className="text-ink-3">Click</span>
          <div role="group" aria-label="Map click mode" className="inline-flex overflow-hidden rounded-sm border border-line-strong">
            <button type="button" data-testid="mode-inspect" aria-pressed={clickMode === 'inspect'} onClick={() => setClickMode('inspect')} className={seg(clickMode === 'inspect')}
              title="Click the map to list every footprint containing that sky position. Never selects or downloads."><ScanSearch size={12} aria-hidden />Inspect point</button>
            <button type="button" data-testid="mode-select" aria-pressed={clickMode === 'select'} onClick={() => setClickMode('select')} className={seg(clickMode === 'select')}
              title="Click a footprint to select the topmost observation there; an unloaded one is downloaded."><MousePointerClick size={12} aria-hidden />Select observation</button>
          </div>
          <span className="mx-1 h-4 w-px bg-line" aria-hidden />
          <span className="text-ink-3">Show</span>
          <div role="group" aria-label="Coverage filter" className="inline-flex overflow-hidden rounded-sm border border-line-strong">
            {([['all', 'All'], ['loaded', 'Loaded'], ['unloaded', 'Unloaded'], ['selected', 'Selected']] as const).map(([f, l]) => (
              <button key={f} type="button" data-testid={`filter-${f}`} aria-pressed={filter === f} onClick={() => setFilter(f)} className={seg(filter === f)}>
                {l}<span className="font-mono text-ink-3">{counts[f]}</span></button>
            ))}
          </div>
          {isolated
            ? <button type="button" className={`${btn} border-accent text-ink`} onClick={() => { setIsolate(false); setFilter('all') }} aria-label="Show all footprints"><X size={12} aria-hidden />Show all</button>
            : <button type="button" className={`${btn} disabled:opacity-40`} disabled={!selVis} onClick={() => setIsolate(true)} aria-label="Isolate selected observation"><Focus size={12} aria-hidden />Isolate selected</button>}
          <span className="text-ink-3">{filter === 'all' ? '' : `filter changes the map only; all ${drawn.length} valid footprints are kept`}{isolated ? `${filter === 'all' ? '' : ' · '}others faded` : ''}</span>
        </div>

        <div ref={box} className="relative select-none" style={{ height: size.h }}>
          <svg ref={svgRef} data-testid="map-svg" width="100%" height={size.h} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="none"
            className={`block touch-none ${drag.current?.moved ? 'cursor-grabbing' : clickMode === 'inspect' ? 'cursor-crosshair' : 'cursor-pointer'}`} role="group" aria-label="Observation footprints around the target"
            onPointerDown={e => { (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, moved: false } }}
            onPointerMove={e => {
              const d = drag.current
              if (d) {
                if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3) d.moved = true
                if (d.moved) {   // delta captured before d is updated: the state updater may run later
                  const s = vb.w / size.w, dx = (e.clientX - d.x) * s, dy = (e.clientY - d.y) * s
                  setView(v => ({ ...v, cx: v.cx - dx, cy: v.cy - dy })); d.x = e.clientX; d.y = e.clientY; setHover(null); return
                }
              }
              const pt = fromEvent(e), r = box.current!.getBoundingClientRect()
              setHover({ px: e.clientX - r.left, py: e.clientY - r.top, under: show.footprints ? under(pt) : [] })
            }}
            onPointerUp={e => {
              const d = drag.current; drag.current = null
              if (!d || d.moved) return
              const pt = fromEvent(e)
              if (clickMode === 'inspect') setProbe(screenToSky(target.ra, target.dec, pt))
              else if (show.footprints) { const hit = top(under(pt)); if (hit) onPick(hit.o) }
            }}
            onPointerLeave={() => setHover(null)}>
            {/* 1° graticule in the tangent plane (not RA/Dec lines): a scale reference only */}
            {Array.from({ length: Math.ceil(vb.w) + 2 }, (_, i) => Math.floor(vb.x) + i).map(x => <line key={`gx${x}`} x1={x} x2={x} y1={vb.y} y2={vb.y + vb.h} className="stroke-raised" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
            {Array.from({ length: Math.ceil(vb.h) + 2 }, (_, i) => Math.floor(vb.y) + i).map(y => <line key={`gy${y}`} x1={vb.x} x2={vb.x + vb.w} y1={y} y2={y} className="stroke-raised" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
            {density && (
              <g data-testid="density" data-ms={density.ms.toFixed(2)} className="transition-opacity duration-200" style={{ pointerEvents: 'none', opacity: isolated ? 0.25 : 1 }} shapeRendering="crispEdges">
                {density.d.map((d, i) => d && <path key={i} data-testid="density-bin" data-bin={i} d={d} className={DENSITY_FILL[i]} />)}
              </g>
            )}
            {show.footprints && visible.map(f => {
              const st = status(f.o), sel = f.o.access_url === selectedUrl, req = f.o.access_url === requestedUrl
              const fill = density ? 'fill-none' : sel ? 'fill-accent/15' : req ? 'fill-accent/10' : st === 'ok' ? 'fill-accent/[0.06]' : 'fill-ink/[0.03]'
              return (
                <polygon key={f.o.access_url} data-testid="footprint" data-obs={f.o.obs_id} data-url={f.o.access_url} data-status={st} data-points={JSON.stringify(f.pts)}
                  points={f.pts!.map(p => p.join(',')).join(' ')} vectorEffect="non-scaling-stroke"
                  className={`${fill} transition-opacity duration-200 ${sel ? 'stroke-accent' : req ? 'stroke-accent-ink' : st === 'ok' ? 'stroke-ink-2' : 'stroke-ink-3'}`}
                  strokeWidth={sel ? 2.2 : 1} strokeDasharray={st === 'ok' || sel ? undefined : '4 3'} style={{ pointerEvents: 'none', opacity: isolated && !sel ? 0.15 : 1 }} />
              )
            })}
            {show.footprints && selVis && (
              <polygon points={selVis.pts!.map(p => p.join(',')).join(' ')} className={`stroke-accent ${isolated ? 'fill-accent/15' : 'fill-none'}`} strokeWidth={2.2} vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none' }} />
            )}
            {show.field && fov != null && (   // SPHERE TRACK's own grid: exact square in this same tangent plane
              <rect data-testid="displayed-field" x={-fov / 2} y={-fov / 2} width={fov} height={fov} className="fill-none stroke-ink" strokeWidth={1.5} vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none' }} />
            )}
            {show.target && (
              <g data-testid="target-marker" style={{ pointerEvents: 'none' }}>
                <circle cx={0} cy={0} r={7 * k} className="fill-none stroke-warn" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
                {[[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => <line key={`${dx}${dy}`} x1={dx * 10 * k} y1={dy * 10 * k} x2={dx * 17 * k} y2={dy * 17 * k} className="stroke-warn" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />)}
              </g>
            )}
            {probeScreen && (
              <g data-testid="probe-marker" data-x={probeScreen[0]} data-y={probeScreen[1]} style={{ pointerEvents: 'none' }}>
                <path d={`M${probeScreen[0] - 6 * k} ${probeScreen[1]}H${probeScreen[0] + 6 * k}M${probeScreen[0]} ${probeScreen[1] - 6 * k}V${probeScreen[1] + 6 * k}`} className="stroke-ink" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                <rect x={probeScreen[0] - 3 * k} y={probeScreen[1] - 3 * k} width={6 * k} height={6 * k} className="fill-none stroke-ink" strokeWidth={1} vectorEffect="non-scaling-stroke" transform={`rotate(45 ${probeScreen[0]} ${probeScreen[1]})`} />
              </g>
            )}
          </svg>
          {show.target && (() => { const [x, y] = toPx([0, 0]); return (
            <div data-testid="target-label" className="pointer-events-none absolute whitespace-nowrap rounded-sm bg-panel/85 px-1 font-mono text-[10px] text-ink" style={{ left: Math.min(size.w - 150, x + 14), top: Math.max(0, y + 10) }}>
              RA {target.ra.toFixed(5)}° ({sexa(target.ra, true)})<br />Dec {fmtDec(target.dec)}° ({sexa(target.dec, false)})
            </div>) })()}
          <div className="pointer-events-none absolute bottom-2 left-2 flex items-end gap-1.5 font-mono text-[10px] text-ink-2">
            <span className="block h-1 border-x border-b border-ink-2" style={{ width: scaleDeg / k }} aria-hidden />{scaleDeg}°
          </div>

          {show.minimap && drawn.length > 0 && (
            <div data-testid="minimap" className="absolute right-2 top-2 z-10 border border-line-strong bg-panel/90" style={{ width: mmW }}>
              <svg data-testid="minimap-svg" width={mmW} height={mmH} viewBox={`${mmBox.x} ${mmBox.y} ${mmBox.w} ${mmBox.h}`} className="block cursor-pointer touch-none"
                role="group" aria-label="Minimap: click or drag to move the main view"
                onPointerDown={e => {
                  const s = e.currentTarget as SVGSVGElement, [x, y] = mmPoint(s, e); s.setPointerCapture(e.pointerId)
                  const inside = x >= vb.x && x <= vb.x + vb.w && y >= vb.y && y <= vb.y + vb.h
                  mm.current = { off: inside ? [view.cx - x, view.cy - y] : [0, 0] }   // drag the rectangle, or jump to the click
                  if (!inside) setView(v => ({ ...v, cx: x, cy: y }))
                }}
                onPointerMove={e => { if (!mm.current) return; const [x, y] = mmPoint(e.currentTarget as SVGSVGElement, e), o = mm.current.off; setView(v => ({ ...v, cx: x + o[0], cy: y + o[1] })) }}
                onPointerUp={() => { mm.current = null }}>
                {drawn.map(f => <polygon key={f.o.access_url} points={f.pts!.map(p => p.join(',')).join(' ')} className={f.o.access_url === selectedUrl ? 'fill-none stroke-accent' : 'fill-accent/[0.05] stroke-ink-3'} strokeWidth={f.o.access_url === selectedUrl ? 1.5 : 0.6} vectorEffect="non-scaling-stroke" />)}
                <circle cx={0} cy={0} r={mmBox.w * 0.025} className="fill-warn" />
                <rect data-testid="minimap-viewport" x={vb.x} y={vb.y} width={vb.w} height={vb.h} className="fill-ink/[0.06] stroke-ink" strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
              </svg>
              <div className="flex items-center gap-1 border-t border-line px-1 py-0.5 font-mono text-[9.5px] text-ink-2">
                <span data-testid="minimap-zoom" className="mr-auto" title="width of the main view · zoom relative to Fit all">{view.w < 1 ? view.w.toFixed(2) : view.w.toFixed(1)}° · ×{(fitAll().w / view.w).toFixed(1)}</span>
                <button type="button" className="rounded-sm p-0.5 hover:bg-hover hover:text-ink" onClick={() => setView(fitAll())} aria-label="Minimap fit"><Maximize size={10} aria-hidden /></button>
                <button type="button" className="rounded-sm p-0.5 hover:bg-hover hover:text-ink" onClick={() => setView(toTarget())} aria-label="Minimap centre on target"><Crosshair size={10} aria-hidden /></button>
              </div>
            </div>
          )}

          {hover && hover.under.length > 0 && (
            <div role="tooltip" data-testid="map-tip" className="pointer-events-none absolute z-20 w-64 border border-line-strong bg-raised px-2.5 py-1.5 text-[11px]"
              style={{ left: Math.min(hover.px + 12, size.w - 262), top: Math.min(hover.py + 12, size.h - 90) }}>
              <div className="text-ink-3"><span data-testid="map-tip-count" className="font-mono text-ink">{hover.under.length}</span> whole-detector footprint(s) {filter === 'all' ? '' : 'shown '}cover this point</div>
              {(() => { const t = top(hover.under); return t && <>
                <div className="mt-0.5 font-mono text-ink">{mjdDate(t.o.mjd_start)} UTC</div>
                <div className="text-ink-2">{t.o.obs_id} · {t.o.band} · {t.o.em_min_um.toFixed(2)}–{t.o.em_max_um.toFixed(2)} µm</div>
                <div className="text-ink-3">{status(t.o) === 'ok' ? 'loaded' : status(t.o)} · {clickMode === 'inspect' ? 'click to list every footprint here (no download)' : status(t.o) === 'ok' ? 'click to select' : 'click to load and select'}</div>
              </> })()}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-1.5 text-[10px] text-ink-3">
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-3 border border-ink-2" aria-hidden />loaded (whole detector)</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-3 border border-dashed border-ink-3" aria-hidden />not loaded</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-3 border-2 border-accent" aria-hidden />selected</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 border border-ink" aria-hidden />displayed field (SPHERE TRACK grid)</span>
          {density ? (
            <span data-testid="density-legend" className="inline-flex flex-wrap items-center gap-1.5">
              Footprint overlap:
              {DENSITY_LABELS.map((l, i) => <span key={l} className="inline-flex items-center gap-0.5"><span className={`h-2.5 w-3.5 border border-line ${DENSITY_SWATCH[i]}`} aria-hidden />{l}</span>)}
              <InfoTip label="Overlap density">Counts of {filter === 'all' ? 'all valid' : `the ${filter}`} whole-detector footprints at each position, computed from the archive polygons along one scanline every {ROW_PX} screen pixels (exact left–right, sampled top–bottom). It is pointing overlap only: not exposure depth, sensitivity or valid-pixel coverage.</InfoTip>
            </span>
          ) : <span>Darker = more detector footprints overlap (pointing only, not guaranteed valid pixels).</span>}
          <span>Cutout outlines are not stored, so not drawn.</span>
        </div>
      </div>

      {probe && probed && (
        <div data-testid="inspector" className="border border-line bg-panel" aria-label="Footprint overlap at the inspected point" role="region">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 text-[11px]">
            <span className="font-semibold text-ink">Footprint overlap</span>
            <span data-testid="probe-coords" data-ra={probe[0]} data-dec={probe[1]} className="font-mono text-ink-2">RA {probe[0].toFixed(5)}° Dec {fmtDec(probe[1])}°</span>
            <span className="text-ink-2"><span data-testid="probe-count" className="font-mono text-ink">{probed.hits.length}</span> whole-detector footprint{probed.hits.length === 1 ? '' : 's'} contain this point</span>
            <div role="group" aria-label="Search scope" className="ml-auto inline-flex overflow-hidden rounded-sm border border-line-strong">
              <button type="button" data-testid="scope-all" aria-pressed={scope === 'all'} onClick={() => setScope('all')} className={seg(scope === 'all')}>all valid archive footprints</button>
              <button type="button" data-testid="scope-visible" aria-pressed={scope === 'visible'} onClick={() => setScope('visible')} className={seg(scope === 'visible')}>visible on map</button>
            </div>
            <button type="button" className="text-ink-3 hover:text-ink" onClick={() => setProbe(null)} aria-label="Close overlap inspector"><X size={13} aria-hidden /></button>
          </div>
          <p data-testid="probe-scope" className="border-b border-line px-3 py-1 text-[10.5px] text-ink-3">
            Searched {probed.pool} {scope === 'all' ? 'valid archive footprints' : `footprints visible under the "${filter}" filter`}
            {bad.length > 0 ? ` (${bad.length} without valid geometry excluded)` : ''}. Containment in a whole-detector outline is pointing only:
            it does not show valid pixels or usable FITS data at this position (masks, detector edges and flags still apply). λ is each detector's full bandpass, not the wavelength at this point.
          </p>
          {hitRows.length ? (
            <div className="max-h-72 overflow-y-auto md:max-h-56" role="table" aria-label="Footprints containing the inspected point">
              {/* ≥768 px: table. Narrower: each row reflows into a two-line card (same cells, same order for screen readers). */}
              <div role="row" className={`sticky top-0 z-[1] hidden ${GRID} gap-x-3 border-b border-line bg-panel px-3 py-1 text-[10px] md:grid`}>
                <span role="columnheader">Observation</span>
                <span role="columnheader">{sortHead('date', 'Date (UTC)')}</span>
                <span role="columnheader">{sortHead('detector', 'Detector')}</span>
                <span role="columnheader">{sortHead('wave', 'λ (µm)')}</span>
                <span role="columnheader" className="text-ink-3">Status</span>
                <span role="columnheader" className="text-ink-3">Viewer</span>
              </div>
              <div className="sticky top-0 z-[1] flex items-center gap-3 border-b border-line bg-panel px-3 py-1 text-[10px] md:hidden" aria-label="Sort footprints" role="group">
                <span className="text-ink-3">Sort</span>{sortHead('date', 'Date (UTC)')}{sortHead('detector', 'Detector')}{sortHead('wave', 'λ (µm)')}
              </div>
              {hitRows.map(o => {
                const st = status(o), sel = o.access_url === selectedUrl, busy = st === 'loading' || st === 'pending'
                const action = sel && st === 'ok' ? 'Selected' : busy ? 'Loading…' : st === 'ok' ? 'Select' : st === 'error' ? 'Retry & select' : 'Load & select'
                return (
                  <div key={o.access_url} role="row" data-testid="probe-row" data-url={o.access_url} aria-current={sel || undefined}
                    className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-raised px-3 py-1 font-mono text-[10.5px] md:grid ${GRID} md:gap-x-3 md:py-[3px] ${sel ? 'bg-accent/10 text-ink' : 'text-ink-2'}`}>
                    <span role="cell" className="min-w-0 truncate text-ink max-md:order-1">{o.obs_id}</span>
                    <span role="cell" className="max-md:order-5">{mjdDate(o.mjd_start)}<span className="md:hidden"> UTC</span></span>
                    <span role="cell" className="max-md:order-2"><span className="md:hidden">· </span>{o.band}</span>
                    <span role="cell" className="max-md:order-6"><span className="md:hidden">· λ </span>{o.em_min_um.toFixed(2)}–{o.em_max_um.toFixed(2)}<span className="md:hidden"> µm</span></span>
                    <span role="cell" className={`max-md:order-3 max-md:ml-auto ${st === 'error' ? 'text-warn' : st === 'ok' ? 'text-ink' : 'text-ink-3'}`}>{st === 'ok' ? 'loaded' : st}</span>
                    <span className="basis-full md:hidden max-md:order-4" aria-hidden />
                    <span role="cell" className="max-md:order-7 max-md:ml-auto">
                      <button type="button" data-testid="probe-action" disabled={action === 'Selected' || busy} onClick={() => onPick(o)} aria-label={`${action} ${o.obs_id}`}
                        className="h-6 rounded-sm border border-line-strong px-2 font-sans text-[10.5px] text-ink-2 hover:bg-hover hover:text-ink disabled:border-transparent disabled:text-ink-3">{action}</button>
                    </span>
                  </div>
                )
              })}
            </div>
          ) : <p data-testid="probe-none" className="px-3 py-2 text-[11px] text-ink-3">No {scope === 'all' ? 'valid archive' : 'visible'} footprint contains this point.</p>}
        </div>
      )}

      {(requested && requested.access_url !== selectedUrl) && (
        <p data-testid="map-loading" role="status" className="border-l-2 border-accent bg-panel px-2 py-1 text-[11px] text-ink-2">
          Loading {requested.obs_id} ({mjdDate(requested.mjd_start)})… the viewer and inspector switch to it when it has loaded{status(requested) === 'error' ? ' — failed; use Retry on the timeline' : ''}.
        </p>
      )}
      {bad.length > 0 && (
        <p data-testid="map-missing" className="text-[11px] text-ink-3">{bad.length} observation(s) have no drawable footprint: {Object.entries(bad.reduce<Record<string, number>>((a, f) => { const r = f.why ?? '?'; a[r] = (a[r] ?? 0) + 1; return a }, {})).map(([r, n]) => `${n} × ${r}`).join('; ')}.</p>
      )}

      <div className="max-h-56 overflow-auto border border-line bg-panel" role="list" aria-label="Observations on the map">
        {[...fps].sort((a, b) => a.o.mjd_start - b.o.mjd_start).map(f => {
          const st = status(f.o), sel = f.o.access_url === selectedUrl
          return (
            <button key={f.o.access_url} role="listitem" data-testid="map-row" data-url={f.o.access_url} aria-current={sel || undefined} onClick={() => onPick(f.o)}
              className={`grid w-full grid-cols-[8.5rem_1fr_auto_auto] gap-x-3 border-b border-raised px-3 py-[3px] text-left font-mono text-[10.5px] hover:bg-hover ${sel ? 'bg-accent/10 text-ink' : 'text-ink-2'}`}>
              <span>{mjdDate(f.o.mjd_start)}</span><span className="truncate">{f.o.obs_id} · {f.o.band}</span>
              <span className={st === 'error' ? 'text-warn' : st === 'ok' ? 'text-ink' : 'text-ink-3'}>{st === 'ok' ? 'loaded' : st}</span>
              <span className={f.pts ? 'text-ink-3' : 'text-warn'}>{f.pts ? 'footprint' : (f.o.footprint?.status ?? 'none')}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
