import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Columns2, Diff, Film, Maximize, Pause, Play, RotateCw, TriangleAlert, Zap, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'
import { fmtDate, getJSON, pngUrl, type FrameSource, type DiffResult, type FrameMeta, type GaiaSource } from '../api'
import InfoTip from './InfoTip'
import SkyImage from './SkyImage'
import { FIT, zoomAt, type View } from '../view'

export type Slot = {
  id: string; mjd: number | null; label: string; status: 'pending' | 'loading' | 'ok' | 'error'; meta?: FrameMeta; error?: string; exptime?: number
  cached?: 'grid' | 'cutout' | null   // known before loading (from /observations)
  source?: FrameSource                // how it was actually served
}
type Mode = 'sequence' | 'side' | 'blink' | 'diff'

interface Props {
  slots: Slot[]
  demo: boolean
  band?: string
  totalVisits?: number
  gaia: GaiaSource[] | null
  stretch: string
  cmap: string
  cand: number | null
  onCand: (i: number | null) => void
  onRetry: (id: string) => void
  onRetryAll: () => void
  onSelect: (m: FrameMeta) => void
  onDiff: (d: DiffResult | null) => void
  jumpTo?: { key: string; seq: number } | null   // external selection (dashboard); seq makes repeat clicks re-apply
  onPixel?: (p: { key: string; x: number; y: number; label: string } | null) => void   // pixel inspector target
  clearPixel?: number                             // bump to clear the selected pixel from outside
}

const SOURCE_LABEL: Record<FrameSource, string> = { grid: 'from cache', 'cutout-cache': 'from cached cutout', download: 'downloaded from IRSA', 'shared-download': 'downloaded from IRSA (shared request)' }
const mjdToDate = (mjd: number) => new Date((mjd - 40587) * 86400000)
const lam = (m?: FrameMeta) => (m?.wavelength_at_target ? `λ ${m.wavelength_at_target.center_um.toFixed(3)} µm` : '')
const ctl = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-sm border border-line-strong px-2.5 text-xs font-medium text-ink hover:border-ink-2 hover:bg-hover disabled:opacity-35 disabled:hover:border-line-strong disabled:hover:bg-transparent'
const MODES: [Mode, string, typeof Film][] = [['sequence', 'Sequence', Film], ['side', 'Side-by-side', Columns2], ['blink', 'Blink', Zap], ['diff', 'Difference', Diff]]
// Image sizing. ≥1280px: the image area is a size container filling the leftover height, so the image takes
// exactly the space left after controls (26px = caption strip). 1024–1279px: page scrolls; cap by viewport height.
const FIT_SEQ = 'lg:max-xl:max-w-[calc(100dvh-300px)] xl:w-[min(100%,calc(100cqh-26px))]'
const FIT_CMP = 'lg:max-xl:max-w-[calc(100dvh-380px)] xl:w-[min(100%,calc(100cqh-26px))]'

export default function Viewer({ slots, demo, band, totalVisits, gaia, stretch, cmap, cand, onCand, onRetry, onRetryAll, onSelect, onDiff, jumpTo, onPixel, clearPixel }: Props) {
  const ok = useMemo(() => slots.filter(s => s.status === 'ok' && s.meta).map(s => s.meta!), [slots])
  const [mode, setMode] = useState<Mode>('sequence')
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(2)
  const [aKey, setAKey] = useState('')
  const [bKey, setBKey] = useState('')
  const [blinkB, setBlinkB] = useState(false)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [view, setView] = useState<View>(FIT)          // one zoom/pan shared by every image in every mode
  const [contrast, setContrast] = useState(5)          // difference DISPLAY range ±Nσ (detection threshold is separate)
  const [opacity, setOpacity] = useState(1)            // difference over observation A: visual aid only
  const diffCtl = useRef<AbortController | null>(null)
  // Selected pixel (grid display coords) + which image it belongs to. 'seq' follows the displayed sequence frame, so
  // stepping frames inspects the SAME sky pixel in the new frame. Independent of the selected difference candidate.
  const [pick, setPick] = useState<{ x: number; y: number; src: 'seq' | 'A' | 'B' } | null>(null)
  const [diffErr, setDiffErr] = useState('')
  const [diffBusy, setDiffBusy] = useState(false)

  const idx = Math.min(i, Math.max(0, ok.length - 1))
  const cur = ok[idx]
  const A = ok.find(m => m.key === aKey) ?? ok[0]
  const B = ok.find(m => m.key === bKey) ?? ok[ok.length - 1]
  const nErr = slots.filter(s => s.status === 'error').length

  useEffect(() => { if (cur) onSelect(cur) }, [cur, onSelect])
  useEffect(() => {
    if (!jumpTo) return
    const k = ok.findIndex(m => m.key === jumpTo.key)
    if (k >= 0) { setPlaying(false); setI(k) }
  }, [jumpTo]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing || ok.length < 2) return
    const t = setInterval(() => setI(v => (v + 1) % ok.length), 1000 / fps)
    return () => clearInterval(t)
  }, [playing, fps, ok.length])

  useEffect(() => {
    if (mode !== 'blink') return
    const t = setInterval(() => setBlinkB(v => !v), 1000 / fps)
    return () => clearInterval(t)
  }, [mode, fps])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' && e.key === ' ') return
      if (e.key === 'ArrowRight') setI(v => Math.min(v + 1, ok.length - 1))
      if (e.key === 'ArrowLeft') setI(v => Math.max(v - 1, 0))
      if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ok.length])

  const runDiff = async (contrastOnly = false) => {
    if (!A || !B || A.key === B.key) { setDiffErr('Choose two different observations.'); setDiff(null); onDiff(null); return }
    diffCtl.current?.abort()
    const ctl = new AbortController(); diffCtl.current = ctl
    // A contrast-only refresh keeps the current picture and candidate selection (candidates do not depend on contrast).
    if (!contrastOnly) { setDiffBusy(true); onCand(null) }
    setDiffErr('')
    try {
      const d = await getJSON<DiffResult>('diff', { a: A.key, b: B.key, scale_sigma: contrast }, 60_000, ctl.signal)
      if (ctl.signal.aborted) return            // stale: a newer A/B or contrast request owns the view
      setDiff(d); onDiff(d)
    } catch (e) {
      if (ctl.signal.aborted) return
      setDiffErr((e as Error).message); setDiff(null); onDiff(null)
      toast.error('Difference image failed', { description: (e as Error).message })
    } finally { if (diffCtl.current === ctl) setDiffBusy(false) }
  }
  useEffect(() => { if (mode === 'diff') runDiff() }, [mode, A?.key, B?.key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {                                // debounce: only display contrast changed
    if (mode !== 'diff' || !diff || diff.display_scale_sigma === contrast) return
    const t = setTimeout(() => runDiff(true), 250)
    return () => clearTimeout(t)
  }, [contrast]) // eslint-disable-line react-hooks/exhaustive-deps
  // New target/search: start from the fitted view. Mode and frame changes keep the current zoom.
  const slotSig = slots.map(s => s.id).join('|')
  useEffect(() => { setView(FIT); setPick(null) }, [slotSig])
  useEffect(() => { if (clearPixel) setPick(null) }, [clearPixel])
  const pickMeta = !pick ? undefined : pick.src === 'A' ? A : pick.src === 'B' ? B : cur
  const pickKey = pickMeta?.key
  useEffect(() => {
    onPixel?.(pick && pickMeta ? { key: pickMeta.key, x: pick.x, y: pick.y, label: `${pick.src === 'seq' ? 'Frame' : pick.src} · ${fmtDate(pickMeta)}` } : null)
  }, [pick?.x, pick?.y, pick?.src, pickKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const inspect = (src: 'seq' | 'A' | 'B') => (x: number, y: number) => setPick({ x, y, src })
  useEffect(() => { if (mode !== 'diff') { onDiff(null); onCand(null) } }, [mode, onDiff, onCand])

  const kind = demo ? 'demo' as const : 'measured' as const
  const bandLabel = demo ? 'NumPy' : `SPHEREx${band ? ' ' + band : ''}`
  const img = (m: FrameMeta, tag?: string, visible = true, fit = FIT_SEQ) => (
    <SkyImage src={pngUrl(m.key, stretch, cmap)} alt={`${tag ? 'Observation ' + tag + ', ' : ''}${fmtDate(m)}`} kind={kind}
      label={tag ? `${tag} · ${bandLabel}` : bandLabel} caption={[fmtDate(m), lam(m)].filter(Boolean).join('  ')}
      gaia={demo || !visible ? null : gaia} year={m.decimal_year} className={fit} view={view} onView={setView}
      onInspect={inspect(tag === 'A' ? 'A' : tag === 'B' ? 'B' : 'seq')} marker={pick} />
  )

  const picker = (tag: 'A' | 'B', m: FrameMeta | undefined, set: (k: string) => void) => {
    const k = m ? ok.findIndex(x => x.key === m.key) : -1
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span className={`w-5 text-center font-mono text-xs font-semibold ${mode === 'diff' ? (tag === 'A' ? 'text-diff-a' : 'text-diff-b') : 'text-ink'}`}>{tag}</span>
        <button className={`${ctl} w-8 px-0`} disabled={k <= 0} onClick={() => set(ok[k - 1].key)} aria-label={`Observation ${tag}: earlier`}><ChevronLeft size={14} aria-hidden /></button>
        <select value={m?.key} onChange={e => set(e.target.value)} aria-label={`Observation ${tag}`}
          className="h-8 min-w-0 flex-1 rounded-sm border border-line-strong bg-panel px-1.5 font-mono text-[11px] text-ink">
          {ok.map(x => <option key={x.key} value={x.key}>{fmtDate(x)}{x.wavelength_at_target ? `  ${lam(x)}` : ''}</option>)}
        </select>
        <button className={`${ctl} w-8 px-0`} disabled={k < 0 || k >= ok.length - 1} onClick={() => set(ok[k + 1].key)} aria-label={`Observation ${tag}: later`}><ChevronRight size={14} aria-hidden /></button>
      </div>
    )
  }

  const lamA = A?.wavelength_at_target?.center_um, lamB = B?.wavelength_at_target?.center_um
  const lamWarn = mode !== 'sequence' && lamA != null && lamB != null && Math.abs(lamA - lamB) > 0.02 && (
    <span role="note" className="inline-flex items-center gap-1.5 text-warn">
      <TriangleAlert size={12} className="text-warn" aria-hidden />
      A and B sample different wavelengths at the target ({lamA.toFixed(3)} vs {lamB.toFixed(3)} µm): differences may be spectral, not temporal.
    </span>
  )

  // --- timeline geometry: real time on x; visits closer than MIN_GAP% stack into extra rows so each stays clickable.
  const mjds = slots.map(s => s.mjd).filter((x): x is number => x != null)
  const t0 = Math.min(...mjds), t1 = Math.max(...mjds)
  const timed = mjds.length > 1 && t1 > t0
  const dots = useMemo(() => {
    const MIN_GAP = 2.2, ROWS = 3
    const last = Array<number>(ROWS).fill(-99)
    return slots.map((s, k) => {
      const pos = (timed && s.mjd != null ? (s.mjd - t0) / (t1 - t0) : k / Math.max(1, slots.length - 1)) * 100
      let row = last.findIndex(p => pos - p >= MIN_GAP)
      if (row < 0) row = last.indexOf(Math.min(...last))
      last[row] = pos
      return { s, pos, row }
    })
  }, [slots, timed, t0, t1])
  const months = useMemo(() => {
    if (!timed) return []
    const out: { pos: number; label: string }[] = []
    const d = mjdToDate(t0), end = mjdToDate(t1)
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
    while (m <= end) {
      out.push({ pos: ((m.getTime() / 86400000 + 40587 - t0) / (t1 - t0)) * 100, label: m.toISOString().slice(0, 7) })
      m.setUTCMonth(m.getUTCMonth() + 1)
    }
    return out
  }, [timed, t0, t1])
  const labelEvery = Math.max(1, Math.ceil(months.length / 7))
  const curDot = dots.find(d => d.s.meta?.key === cur?.key)

  return (
    <section aria-label="Observation viewer" className="flex flex-col border border-line bg-panel xl:min-h-full">
      {/* mode bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1.5">
        <div role="tablist" aria-label="Comparison mode" className="flex flex-wrap">
          {MODES.map(([m, l, Icon]) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              className={`inline-flex h-8 items-center gap-1.5 border-b-2 px-3 text-xs font-medium ${mode === m ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}>
              <Icon size={14} aria-hidden />{l}
            </button>
          ))}
        </div>
        {ok.length > 0 && (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Zoom">
            <button className={`${ctl} w-8 px-0`} onClick={() => setView(v => zoomAt(v, 0.5, 0.5, 0.8))} disabled={view.s <= 1} aria-label="Zoom out"><ZoomOut size={14} aria-hidden /></button>
            <span data-testid="zoom-level" className="w-11 text-center font-mono text-[11px] text-ink-2">×{view.s.toFixed(1)}</span>
            <button className={`${ctl} w-8 px-0`} onClick={() => setView(v => zoomAt(v, 0.5, 0.5, 1.25))} disabled={view.s >= 24} aria-label="Zoom in"><ZoomIn size={14} aria-hidden /></button>
            <button className={ctl} onClick={() => setView(FIT)} disabled={view.s === 1} aria-label="Fit to view (reset zoom)"><Maximize size={13} aria-hidden />Fit</button>
          </div>
        )}
        {mode === 'blink' && ok.length > 0 && (
          <span className="font-mono text-xs text-ink-2">showing <span data-testid="blink-label" className="font-semibold text-ink">{blinkB ? 'B' : 'A'}</span></span>
        )}
      </div>

      {mode !== 'sequence' && ok.length > 0 && (
        <div className="flex flex-col gap-1.5 border-b border-line px-2 py-1 sm:flex-row">{picker('A', A, setAKey)}{picker('B', B, setBKey)}</div>
      )}

      {/* image area */}
      <div className="p-2 sm:p-3 xl:flex xl:flex-1 xl:flex-col xl:p-2">
        {/* 420px floor via flex-basis (not min-height: cqh resolved to 0 when only min-height gave the size).
            On short screens the centre column scrolls rather than shrinking the image further. */}
        <div className="xl:flex-[1_0_420px] xl:[container-type:size]">
        {ok.length === 0 ? (
          <div className={`mx-auto flex aspect-square w-full max-w-[560px] flex-col items-center justify-center gap-3 border border-dashed border-line-strong bg-canvas text-xs text-ink-2 ${FIT_SEQ}`}>
            {nErr === slots.length && slots.length > 0 ? (
              <>
                <span className="text-warn">All {nErr} cutout requests failed.</span>
                <button className={ctl} onClick={onRetryAll}><RotateCw size={14} aria-hidden />Retry failed</button>
              </>
            ) : <span className="font-mono">Retrieving first cutout from IRSA…</span>}
          </div>
        ) : mode === 'sequence' ? (
          <div className={`relative mx-auto ${FIT_SEQ}`}>
            {ok.map((m, k) => (
              <div key={m.key} className={k === idx ? '' : 'pointer-events-none absolute inset-0 opacity-0'} aria-hidden={k !== idx}>{img(m, undefined, k === idx)}</div>
            ))}
          </div>
        ) : mode === 'side' ? (
          <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">{A && img(A, 'A', true, FIT_CMP)}{B && img(B, 'B', true, FIT_CMP)}</div>
        ) : mode === 'blink' ? (
          <div className={`relative mx-auto ${FIT_CMP}`}>
            {[A, B].map((m, k) => m && (
              <div key={k} className={(k === 1) === blinkB ? '' : 'pointer-events-none absolute inset-0 opacity-0'}>{img(m, k ? 'B' : 'A')}</div>
            ))}
          </div>
        ) : (
          <div>
            {diffBusy && <p className="py-16 text-center font-mono text-xs text-ink-2" aria-live="polite">Computing A − k·B …</p>}
            {diffErr && !diffBusy && <p role="alert" className="py-6 text-center text-xs text-warn">{diffErr} <button className="underline" onClick={() => runDiff()}>Retry</button></p>}
            {diff && !diffBusy && (
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-center">
                {/* Sized from container units directly (thumb column = 144px + 8px gap); a %-width figure inside a flex-1 item collapsed to 0 at 1280px. */}
                <div className="min-w-0 md:flex-1 xl:w-[min(calc(100cqw-152px),calc(100cqh-26px))] xl:flex-none">
                  <SkyImage src={diff.png} alt="Difference image, A minus k times B" kind={diff.demo ? 'demo' : 'derived'} label={opacity < 1 ? `A − k·B over A (${Math.round(opacity * 100)}%)` : 'A − k·B'} className="lg:max-xl:max-w-[calc(100dvh-380px)]"
                    caption={`display ±${diff.display_scale_sigma ?? 5}σ · σ = ${diff.noise_sigma.toPrecision(3)}`} candidates={diff.candidates} selected={cand} onPick={k => onCand(cand === k ? null : k)}
                    view={view} onView={setView} underlay={opacity < 1 && A ? pngUrl(A.key, stretch, cmap) : undefined} opacity={opacity}
                    onInspect={inspect('A')} marker={pick} />
                </div>
                <div className="grid grid-cols-2 gap-2 md:w-36 md:shrink-0 md:grid-cols-1">
                  {A && <SkyImage src={pngUrl(A.key, stretch, cmap)} alt="Observation A" kind={kind} compact label="A" caption={fmtDate(A).slice(0, 10)} crosshair={false} view={view} onView={setView} onInspect={inspect('A')} marker={pick} />}
                  {B && <SkyImage src={pngUrl(B.key, stretch, cmap)} alt="Observation B" kind={kind} compact label="B" caption={fmtDate(B).slice(0, 10)} crosshair={false} view={view} onView={setView} onInspect={inspect('B')} marker={pick} />}
                </div>
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      {/* legend: always visible; difference semantics shown in Difference mode */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-line px-3 py-1 text-[11px] text-ink-2">
        {mode === 'diff' && (
          <div className="flex basis-full flex-wrap items-center gap-x-5 gap-y-0.5">
            <label className="inline-flex items-center gap-2"><span className="text-ink-2">Display contrast ±</span>
              <input type="range" min={1} max={20} step={0.5} value={contrast} onChange={e => setContrast(+e.target.value)} className="w-28" aria-label="Difference display contrast in sigma" />
              <span data-testid="diff-contrast" className="w-10 font-mono text-ink">{contrast}σ</span>
              {contrast !== 5 && <button className="text-[10px] underline" onClick={() => setContrast(5)}>default 5σ</button>}
            </label>
            <label className="inline-flex items-center gap-2"><span className="text-ink-2">Opacity over A</span>
              <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={e => setOpacity(+e.target.value)} className="w-24" aria-label="Difference image opacity over observation A" />
              <span data-testid="diff-opacity" className="w-9 font-mono text-ink">{Math.round(opacity * 100)}%</span>
            </label>
            <span className="text-[10px] text-ink-3">Display only: candidates and statistics do not change.{opacity < 1 && ' Below 100% colours blend with observation A — visual aid, not pure red/blue.'}</span>
          </div>
        )}
        {mode === 'diff' && (
          <>
            {/* Swatches are the coolwarm colour-map ends used in the difference PNG: data colours, same in both themes. */}
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 ring-1 ring-line-strong bg-[#b40426]" aria-hidden /><span className="text-ink">Red = brighter in observation A</span></span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 ring-1 ring-line-strong bg-[#3b4cc0]" aria-hidden /><span className="text-ink">Blue = brighter in observation B</span></span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 ring-1 ring-line-strong bg-[#dddddd]" aria-hidden /><span data-testid="diff-scale-legend">no change (display scale ±{diff?.display_scale_sigma ?? contrast}σ)</span></span>
            <span className="inline-flex items-center">Difference imaging
              <InfoTip label="Difference imaging" align="end">Observation B is scaled by a fitted flux factor k and subtracted from A after WCS alignment and background removal. Static stars cancel. A source that moved leaves a red/blue pair; a source that changed brightness leaves one colour. The colour scale (default ±5σ) is display contrast only: candidate detection always uses its own 5σ threshold.</InfoTip>
            </span>
          </>
        )}
        {/* Same colours the backend paints (fitsproc MASK_RGB / OFFDET_RGB + hatch); display only, never data. */}
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 ring-1 ring-line-strong" style={{ background: 'rgb(118,120,124)' }} aria-hidden />masked (FITS flags)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 ring-1 ring-line-strong" style={{ background: 'repeating-linear-gradient(135deg, rgb(66,68,72) 0 1px, rgb(46,47,50) 1px 4px)' }} aria-hidden />outside detector (not observed)</span>
        {gaia && !demo && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border border-gaia" aria-hidden />Gaia DR3</span>}
        {mode !== 'diff' && <span>Each frame scaled independently</span>}
        {lamWarn}
      </div>

      {/* Playback row: on small screens it sticks to the viewport bottom only while this section is on screen
          (sticky is bounded by the section), and only this slim row sticks — the timeline stays in flow. */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line bg-panel px-3 py-2 max-lg:sticky max-lg:bottom-0 max-lg:z-10 max-lg:shadow-[0_-1px_0_var(--color-line)]">
          <button className={ctl} onClick={() => setI(Math.max(idx - 1, 0))} disabled={idx === 0} aria-label="Previous frame"><ChevronLeft size={15} aria-hidden /></button>
          <button className={`${ctl} min-w-20 ${playing ? 'border-accent text-accent-ink' : ''}`} onClick={() => setPlaying(p => !p)}
            disabled={ok.length < 2 || mode !== 'sequence'} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}{playing ? 'Pause' : 'Play'}
          </button>
          <button className={ctl} onClick={() => setI(Math.min(idx + 1, ok.length - 1))} disabled={idx >= ok.length - 1} aria-label="Next frame"><ChevronRight size={15} aria-hidden /></button>
          <label className="ml-1 flex items-center gap-1.5 text-[11px] text-ink-2">
            <span className="hidden sm:inline">Speed</span>
            <input type="range" min={0.5} max={10} step={0.5} value={fps} onChange={e => setFps(+e.target.value)} className="w-20 sm:w-28" aria-label="Playback speed (frames per second)" />
            <span className="w-11 font-mono text-ink">{fps} fps</span>
          </label>
          <div className="ml-auto text-right leading-tight">
            <div data-testid="frame-date" aria-live="polite" className="font-mono text-sm font-medium text-ink">{fmtDate(cur)}</div>
            <div className="font-mono text-[10px] text-ink-3">{ok.length ? idx + 1 : 0}/{ok.length}{cur?.wavelength_at_target ? ` · ${lam(cur)}` : ''}</div>
          </div>
      </div>

      <div className="bg-panel px-3 pb-2">
        <div className="relative h-[58px]" role="group" aria-label="Observation timeline">
          <div className="absolute inset-x-1.5 top-0 h-[44px]">
            {months.map((m, k) => (
              <div key={m.label} className="absolute top-0 h-[44px] border-l border-line" style={{ left: `${m.pos}%` }}>
                {k % labelEvery === 0 && m.pos < 93 && <span className="absolute left-1 top-[46px] whitespace-nowrap font-mono text-[9px] text-ink-3">{m.label}</span>}
              </div>
            ))}
            <div className="absolute inset-x-0 top-[9px] h-px bg-line-strong" />
            {dots.map(({ s, pos, row }) => {
              const okIdx = ok.findIndex(m => m.key === s.meta?.key)
              const isCur = s.status === 'ok' && okIdx === idx
              const look = s.status === 'ok' ? (isCur ? 'bg-accent border-accent' : 'bg-ink border-ink hover:bg-ink')
                : s.status === 'error' ? 'border-warn bg-transparent'
                : s.status === 'loading' ? 'animate-pulse border-ink-2 bg-ink-3'
                : 'border-ink-3 bg-transparent' // queued: hollow
              const date = s.meta?.date_obs ? fmtDate(s.meta) : s.label
              const state = s.status === 'error' ? `failed: ${s.error} (click to retry)`
                : s.status === 'loading' ? (s.cached ? 'loading from cache' : 'downloading from IRSA')
                : s.status === 'pending' ? 'queued' : SOURCE_LABEL[s.source ?? 'grid']
              return (
                <button key={s.id} title={`${date} — ${state}`}
                  style={{ left: `${pos}%`, top: `${4 + row * 12}px` }}
                  onClick={() => (s.status === 'error' ? onRetry(s.id) : okIdx >= 0 && setI(okIdx))}
                  className={`absolute h-2.5 w-2.5 -translate-x-1/2 rounded-full border ${look} ${isCur ? 'scale-125' : ''}`}
                  aria-current={isCur || undefined}
                  aria-label={s.status === 'error' ? `Retry failed frame ${s.label}` : `Frame ${date} (${s.status})`} />
              )
            })}
            {curDot && <div className="pointer-events-none absolute top-0 h-[44px] w-px bg-accent/50" style={{ left: `${curDot.pos}%` }} aria-hidden />}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 text-[10px] text-ink-3">
          {timed && !demo && <span className="font-mono">baseline {(t1 - t0).toFixed(0)} d · {slots.length}{totalVisits && totalVisits > slots.length ? ` of ${totalVisits} visits, evenly sampled` : ' visits'}</span>}
          <span className="hidden sm:inline">← → step · space play/pause</span>
          {nErr > 0 && <button className="ml-auto inline-flex items-center gap-1 text-warn underline" onClick={onRetryAll}><RotateCw size={11} aria-hidden />Retry failed ({nErr})</button>}
        </div>
      </div>
    </section>
  )
}
