import { useCallback, useEffect, useRef, useState } from 'react'
import { Crosshair, FlaskConical, RotateCw, Search, Telescope, Image as ImageIcon, LayoutDashboard } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { BANDS, fmtDate, getJSON, type DiffResult, type FrameMeta, type GaiaSource, type ObsResponse, type Preset } from './api'
import InfoTip from './components/InfoTip'
import Histogram from './components/Histogram'
import PixelInspector, { type PixelSel } from './components/PixelInspector'
import Dashboard from './components/Dashboard'
import ThemeSwitch from './components/ThemeSwitch'
import Viewer, { type Slot } from './components/Viewer'
import { useTheme } from './theme'

const EXAMPLES = [
  { label: "Barnard's Star", ra: '269.44629', dec: '4.767917', note: 'Fastest-moving star. Motion visible within one year.' },
  { label: 'WISE 0855', ra: '133.795129', dec: '-7.245147', note: 'Coldest known brown dwarf. Brightest at 4–5 µm (D6).' },
]

const FOV_MIN = 0.02, FOV_MAX = 0.5
// Concurrent /api/frame requests. The backend separately caps IRSA downloads (SPHERETRACK_IRSA_CONCURRENCY, default 3);
// IRSA starts answering HTTP 503 at ~4 parallel cutouts, and each ~4 MB cutout takes 10-16 s at ~300 KiB/s.
const CONCURRENCY = Math.max(1, Number(import.meta.env.VITE_FRAME_CONCURRENCY) || 3)

type Params = { ra: string; dec: string; fov: number; band: string; n: number }
type Phase = 'idle' | 'querying' | 'loading' | 'done' | 'empty' | 'error'

function readUrl(): Params & { demo: boolean } {
  const q = new URLSearchParams(location.search)
  return {
    ra: q.get('ra') ?? '', dec: q.get('dec') ?? '',
    fov: Math.min(FOV_MAX, Math.max(FOV_MIN, Number(q.get('fov')) || 0.1)),
    band: /^D[1-6]$/.test(q.get('band') ?? '') ? q.get('band')! : 'D6',
    n: Math.min(48, Math.max(2, Number(q.get('n')) || 12)),
    demo: q.get('demo') === '1',
  }
}

function validate(p: Params): string | null {
  const ra = Number(p.ra), dec = Number(p.dec)
  if (p.ra.trim() === '' || !Number.isFinite(ra) || ra < 0 || ra >= 360) return 'RA must be a number in [0, 360) degrees.'
  if (p.dec.trim() === '' || !Number.isFinite(dec) || dec < -90 || dec > 90) return 'Dec must be a number in [−90, +90] degrees.'
  return null
}

const section = 'border-b border-line px-3 py-3'
const heading = 'mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-ink-2'
const input = 'h-8 w-full min-w-0 rounded-sm border border-line-strong bg-canvas px-2 font-mono text-[13px] text-ink focus:border-accent focus:outline-none'
const fieldLabel = 'mb-1 flex items-center text-[11px] text-ink-2'
const CAND_GRID = 'grid grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1fr)_2.75rem_2rem]'
const sign = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(5)

export default function App() {
  const init = useRef(readUrl()).current
  const theme = useTheme()
  const [p, setP] = useState<Params>(init)
  const [formErr, setFormErr] = useState('')
  const [presets, setPresets] = useState<Preset[] | null>(null)
  const [presetErr, setPresetErr] = useState('')
  const [nameQ, setNameQ] = useState('')
  const [nameMsg, setNameMsg] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [err, setErr] = useState('')
  const [obsInfo, setObsInfo] = useState<ObsResponse | null>(null)
  const [slots, setSlots] = useState<Slot[]>([])
  const [demo, setDemo] = useState(false)
  const [sel, setSel] = useState<FrameMeta | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [cand, setCand] = useState<number | null>(null)
  const [gaiaOn, setGaiaOn] = useState(false)
  const [gaia, setGaia] = useState<GaiaSource[] | null>(null)
  const [gaiaMsg, setGaiaMsg] = useState('')
  const [gmax, setGmax] = useState(16)
  const [stretch, setStretch] = useState('asinh')
  const [cmap, setCmap] = useState('inferno')
  const [active, setActive] = useState<Params | null>(null)
  const [workspace, setWorkspace] = useState<'viewer' | 'dashboard'>('viewer')
  const [jumpTo, setJumpTo] = useState<{ key: string; seq: number } | null>(null)
  const [pixelSel, setPixelSel] = useState<PixelSel | null>(null)
  const [clearPixel, setClearPixel] = useState(0)
  const run = useRef<AbortController | null>(null)
  const headerRef = useRef<HTMLElement>(null)
  const [headerH, setHeaderH] = useState(44)
  useEffect(() => {
    if (!headerRef.current) return
    const ro = new ResizeObserver(([e]) => setHeaderH(Math.ceil(e.target.getBoundingClientRect().height)))
    ro.observe(headerRef.current)
    return () => ro.disconnect()
  }, [])
  const viewerRef = useRef<HTMLDivElement>(null)

  const loadPresets = useCallback(() => {
    setPresetErr('')
    getJSON<Preset[]>('presets', {}, 60_000).then(setPresets).catch(e => setPresetErr(e.message))
  }, [])
  useEffect(loadPresets, [loadPresets])

  const patch = (id: string, s: Partial<Slot>) => setSlots(v => v.map(x => (x.id === id ? { ...x, ...s } : x)))

  const loadFrame = useCallback(async (slot: Slot, q: Params, signal: AbortSignal) => {
    if (signal.aborted) return false
    patch(slot.id, { status: 'loading', error: undefined })
    try {
      const m = await getJSON<FrameMeta>('frame', { url: slot.id, ra: q.ra, dec: q.dec, fov: q.fov, exptime_s: slot.exptime ?? '' }, 240_000, signal)
      // Stale guard: a newer search may own slots with the same id (same file, different FOV) — never patch them.
      if (signal.aborted) return false
      patch(slot.id, { status: 'ok', meta: m, mjd: m.mjd ?? slot.mjd, source: m.timing?.source })
      return true
    } catch (e) {
      if (!signal.aborted && (e as Error).message !== 'cancelled') patch(slot.id, { status: 'error', error: (e as Error).message })
      return false
    }
  }, [])

  const search = useCallback(async (q: Params) => {
    const v = validate(q)
    if (v) { setFormErr(v); return }
    setFormErr('')
    run.current?.abort()
    const ctl = new AbortController(); run.current = ctl
    history.replaceState(null, '', `?ra=${q.ra}&dec=${q.dec}&fov=${q.fov}&band=${q.band}&n=${q.n}`)
    setDemo(false); setActive(q); setSlots([]); setSel(null); setDiff(null); setCand(null); setGaia(null); setGaiaOn(false); setObsInfo(null)
    setPhase('querying'); setErr('')
    let r: ObsResponse
    try {
      r = await getJSON<ObsResponse>('observations', { ra: q.ra, dec: q.dec, band: q.band, limit: q.n, fov: q.fov }, 120_000, ctl.signal)
    } catch (e) {
      if ((e as Error).message === 'cancelled') return
      setErr((e as Error).message); setPhase('error')
      toast.error('IRSA archive query failed', { description: (e as Error).message })
      return
    }
    setObsInfo(r)
    if (r.observations.length === 0) { setPhase('empty'); return }
    const list: Slot[] = r.observations.map(o => ({
      id: o.access_url, mjd: o.mjd_start, label: `${o.obs_id} · MJD ${o.mjd_start.toFixed(3)}`, status: 'pending', exptime: o.exptime_s, cached: o.cached ?? null,
    }))
    setSlots(list); setPhase('loading')
    if (window.innerWidth < 1024) setTimeout(() => viewerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    // Cached frames first (they return in milliseconds), so usable images appear before any IRSA download starts.
    const queue = [...list.filter(s => s.cached), ...list.filter(s => !s.cached)]
    let next = 0, failed = 0
    const worker = async () => { while (next < queue.length && !ctl.signal.aborted) if (!(await loadFrame(queue[next++], q, ctl.signal))) failed++ }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    if (ctl.signal.aborted) return
    setPhase('done')
    // Success is reported in the toolbar status row; only partial failure needs a notification.
    if (failed) toast.warning(`${list.length - failed} of ${list.length} observations loaded`, { description: `${failed} cutout request(s) failed. Use "Retry failed".` })
  }, [loadFrame])

  const startDemo = async () => {
    run.current?.abort()
    setPhase('querying'); setErr(''); setSel(null); setDiff(null); setCand(null); setGaiaOn(false); setGaia(null); setObsInfo(null); setActive(null)
    history.replaceState(null, '', '?demo=1')
    try {
      const d = await getJSON<{ frames: FrameMeta[] }>('demo')
      setSlots(d.frames.map(m => ({ id: m.key, mjd: null, label: m.date_obs ?? m.key, status: 'ok', meta: m })))
      setDemo(true); setPhase('done')
    } catch (e) { setErr((e as Error).message); setPhase('error') }
  }

  useEffect(() => {
    if (init.demo) startDemo()
    else if (init.ra && init.dec) search(init)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!gaiaOn || !active || demo) return
    setGaiaMsg('Querying Gaia DR3…')
    getJSON<{ sources: GaiaSource[] }>('gaia', { ra: active.ra, dec: active.dec, fov: active.fov }, 90_000)
      .then(g => { setGaia(g.sources); setGaiaMsg(`Gaia DR3 sources propagated to each frame epoch (${g.sources.length} retrieved, brightest first)`) })
      .catch(e => { setGaia(null); setGaiaMsg(`Gaia overlay unavailable: ${e.message}`); toast.error('Gaia DR3 overlay unavailable', { description: e.message }) })
  }, [gaiaOn, active, demo])

  // Retries run in the background: progress shows inline in the toolbar status, never as a persistent toast
  // (a loading toast used to sit on top of the toolbar's workspace/theme switches for the whole retry).
  const retryingRef = useRef(new Set<string>())
  const [retrying, setRetrying] = useState(0)
  const retry = async (ids: string[]) => {
    if (!active) return
    const fresh = ids.filter(id => !retryingRef.current.has(id))   // never retry the same frame twice concurrently
    if (!fresh.length) return
    fresh.forEach(id => retryingRef.current.add(id)); setRetrying(retryingRef.current.size)
    const signal = (run.current ??= new AbortController()).signal  // same cancellation as the search it belongs to
    let res: boolean[] = []
    try {
      res = await Promise.all(slots.filter(s => fresh.includes(s.id)).map(s => loadFrame(s, active, signal)))
    } finally {
      fresh.forEach(id => retryingRef.current.delete(id)); setRetrying(retryingRef.current.size)
    }
    if (signal.aborted) return                                       // superseded by a new search: say nothing
    const bad = res.filter(x => !x).length
    if (bad) toast.error(`${bad} of ${fresh.length} retried observation(s) still failing`, { description: 'IRSA may be busy. Try again shortly.' })
    else toast.success(`${fresh.length} observation(s) recovered`, { duration: 2500 })
  }

  const resolveName = async () => {
    if (!nameQ.trim()) return
    setNameMsg('Resolving via SIMBAD…')
    try {
      const r = await getJSON<{ simbad_id: string; ra: number; dec: number; epoch: number }>('resolve', { name: nameQ.trim() }, 30_000)
      setP(v => ({ ...v, ra: String(r.ra), dec: String(r.dec) }))
      setNameMsg(`${r.simbad_id} — SIMBAD${r.epoch !== 2000 ? `, proper motion applied to epoch ${r.epoch}` : ' (J2000)'}`)
    } catch (e) { setNameMsg((e as Error).message) }
  }

  const nOk = slots.filter(s => s.status === 'ok').length
  const nErr = slots.filter(s => s.status === 'error').length
  const nFromCache = slots.filter(s => s.status === 'ok' && (s.source === 'grid' || s.source === 'cutout-cache')).length
  const nDownloaded = slots.filter(s => s.status === 'ok' && (s.source === 'download' || s.source === 'shared-download')).length
  const nDownloading = slots.filter(s => s.status === 'loading' && !s.cached).length
  const nQueued = slots.filter(s => s.status === 'pending').length
  const onSelect = useCallback((m: FrameMeta) => setSel(m), [])
  const go = (q: Params) => { setP(q); search(q) }

  const status = demo ? <span className="text-warn">Synthetic demo data</span>
    : phase === 'querying' ? <span className="text-ink">Querying IRSA SIA2…</span>
    : phase === 'loading' ? (
      <span className="text-ink">Loaded <span className="font-mono">{nOk}/{slots.length}</span>
        <span className="hidden text-ink-3 sm:inline">
          {nFromCache > 0 && <> · <span className="font-mono">{nFromCache}</span> from cache</>}
          {nDownloaded > 0 && <> · <span className="font-mono">{nDownloaded}</span> downloaded</>}
          {nDownloading > 0 && <> · <span className="font-mono text-ink">{nDownloading}</span> downloading from IRSA (≈10–20 s each)</>}
          {nQueued > 0 && <> · <span className="font-mono">{nQueued}</span> queued</>}
        </span>
        {nErr > 0 && <span className="text-warn"> · {nErr} failed</span>}
      </span>)
    : phase === 'done' ? <span className="text-ink">Loaded <span className="font-mono">{nOk}/{slots.length}</span> frames<span className="hidden text-ink-3 sm:inline">{nFromCache || nDownloaded ? ` · ${nFromCache} from cache, ${nDownloaded} downloaded` : ''}{obsInfo ? ` · ${obsInfo.total_in_band} ${active?.band} visits in archive` : ''}</span>{nErr ? <span className="text-warn"> · {nErr} failed</span> : ''}</span>
    : phase === 'error' ? <span className="text-warn">Archive request failed</span>
    : phase === 'empty' ? <span className="text-ink">No observations</span>
    : <span className="text-ink-3">Idle</span>
  const dot = demo || phase === 'error' || nErr ? 'bg-warn' : phase === 'querying' || phase === 'loading' ? 'animate-pulse bg-accent' : phase === 'done' ? 'bg-accent' : 'bg-ink-3'

  return (
    <div className="flex min-h-dvh flex-col xl:h-dvh xl:overflow-hidden">
      {/* toolbar */}
      <header ref={headerRef} className="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-1 border-b border-line bg-panel px-3 py-1.5">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-5 w-5" />
          <h1 className="text-[13px] font-semibold tracking-[0.12em] text-ink">SPHERE TRACK</h1>
          <span className="hidden text-[11px] text-ink-3 md:inline">SPHEREx time-series explorer</span>
        </div>
        {active && !demo && (
          <div className="flex items-baseline gap-2 font-mono text-[12px]" aria-label="Current field">
            <span className="text-[10px] font-sans text-ink-3">FIELD</span>
            <span className="text-ink">{Number(active.ra).toFixed(5)} {sign(Number(active.dec))}</span>
            <span className="text-ink-2">{(active.fov * 60).toFixed(1)}′ · {active.band}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2 text-[12px]" role="status" aria-live="polite">
          <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
          <span className="text-ink-3">{demo ? 'DEMO' : 'IRSA'}</span>{status}
          {retrying > 0 && (
            <span data-testid="retry-progress" className="inline-flex items-center gap-1 text-accent-ink">
              <RotateCw size={12} className="animate-spin" aria-hidden />Retrying <span className="font-mono">{retrying}</span>
            </span>
          )}
        </div>
        {slots.length > 0 && (
          // Workspace switch lives in the toolbar so it costs the image no vertical space.
          <div role="tablist" aria-label="Workspace" className="flex h-7 shrink-0 rounded-sm border border-line-strong">
            {([['viewer', 'Viewer', ImageIcon], ['dashboard', 'Dashboard', LayoutDashboard]] as const).map(([w, l, Icon]) => (
              <button key={w} role="tab" aria-selected={workspace === w} onClick={() => setWorkspace(w)}
                className={`inline-flex items-center gap-1.5 px-2.5 text-[11px] font-medium ${workspace === w ? 'bg-accent/15 text-accent-ink' : 'text-ink-3 hover:text-ink'}`}>
                <Icon size={13} aria-hidden />{l}
              </button>
            ))}
          </div>
        )}
        <ThemeSwitch pref={theme.pref} onChange={theme.choose} />
        {phase === 'loading' && (
          <div className="basis-full" role="progressbar" aria-label="Cutouts loaded" aria-valuemin={0} aria-valuemax={slots.length} aria-valuenow={nOk + nErr}>
            <div className="h-0.5 bg-line"><div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${((nOk + nErr) / Math.max(1, slots.length)) * 100}%` }} /></div>
          </div>
        )}
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[264px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)_300px]">
        {/* left control panel */}
        <aside className="min-w-0 border-b border-line bg-panel lg:row-span-2 lg:border-b-0 lg:border-r xl:row-span-1 xl:overflow-y-auto">
          <form className={section} onSubmit={e => { e.preventDefault(); search(p) }} noValidate>
            <h2 className={heading}><Crosshair size={13} aria-hidden />Field (ICRS, degrees)</h2>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className={fieldLabel}><label htmlFor="ra">RA</label>
                  <InfoTip label="Right Ascension" align="start">Sky longitude, measured eastward along the celestial equator. Enter decimal degrees, 0 to 360 (1 h = 15°).</InfoTip></div>
                <input id="ra" className={input} inputMode="decimal" value={p.ra} placeholder="0 – 360" onChange={e => setP({ ...p, ra: e.target.value })} aria-invalid={!!formErr} aria-describedby={formErr ? 'form-err' : undefined} />
              </div>
              <div>
                <div className={fieldLabel}><label htmlFor="dec">Dec</label>
                  <InfoTip label="Declination" align="end">Sky latitude: angle north (+) or south (−) of the celestial equator, from −90 to +90 decimal degrees.</InfoTip></div>
                <input id="dec" className={input} inputMode="decimal" value={p.dec} placeholder="−90 – +90" onChange={e => setP({ ...p, dec: e.target.value })} aria-invalid={!!formErr} aria-describedby={formErr ? 'form-err' : undefined} />
              </div>
            </div>
            <div className={`${fieldLabel} mt-2`}>
              <label htmlFor="fov">Field of view</label>
              <InfoTip label="Field of View">Width of the square cutout around your position. SPHEREx pixels are 6.15″, so 0.10° ≈ 59 × 59 pixels. Larger fields take longer to retrieve.</InfoTip>
              <span className="ml-auto font-mono text-ink">{p.fov.toFixed(2)}° · {(p.fov * 60).toFixed(1)}′</span>
            </div>
            <input id="fov" type="range" min={FOV_MIN} max={FOV_MAX} step={0.01} value={p.fov} onChange={e => setP({ ...p, fov: +e.target.value })} className="w-full" />
            <div className="mt-1 grid grid-cols-[1fr_72px] gap-2">
              <div>
                <div className={fieldLabel}><label htmlFor="band">Band</label>
                  <InfoTip label="Wavelength" align="start">SPHEREx images the sky through 6 detectors (D1–D6) covering 0.75–5.0 µm. A linear variable filter means each pixel sees a slightly different wavelength, so the wavelength at your target changes from visit to visit. Cool brown dwarfs such as WISE 0855 are brightest in D6.</InfoTip></div>
                <select id="band" className={input} value={p.band} onChange={e => setP({ ...p, band: e.target.value })}>
                  {BANDS.map(([b, r]) => <option key={b} value={b}>{b}  {r}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="nmax" className={fieldLabel}>Frames</label>
                <input id="nmax" className={input} type="number" min={2} max={48} value={p.n} onChange={e => setP({ ...p, n: Math.min(48, Math.max(2, +e.target.value || 2)) })} />
              </div>
            </div>
            {formErr && <p id="form-err" role="alert" className="mt-2 border-l-2 border-warn pl-2 text-[11px] text-warn">{formErr}</p>}
            <button type="submit" disabled={phase === 'querying'} className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-sm border border-accent/70 bg-accent/10 text-xs font-semibold text-accent-ink hover:bg-accent/20 disabled:opacity-50">
              <Search size={14} aria-hidden />{phase === 'querying' ? 'Querying IRSA…' : 'Search SPHEREx archive'}
            </button>
            <div className="mt-2 flex gap-1.5">
              <input className={input} value={nameQ} placeholder="Name, e.g. M 42" onChange={e => setNameQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); resolveName() } }} aria-label="Object name" />
              <button type="button" onClick={resolveName} className="h-8 shrink-0 rounded-sm border border-line-strong px-2.5 text-xs text-ink hover:bg-hover">Resolve</button>
            </div>
            {nameMsg && <p className="mt-1 text-[11px] text-ink-2">{nameMsg}</p>}
          </form>

          <div className={section}>
            <h2 className={heading}><Telescope size={13} aria-hidden />Challenge targets
              <InfoTip label="Proper Motion" align="start">The apparent motion of a star across the sky, in milliarcseconds per year (mas/yr). SIMBAD positions are for epoch J2000. For fast movers, SPHERE TRACK moves the search position to epoch 2025.9, the middle of SPHEREx DR1, so the target sits at the field centre.</InfoTip>
            </h2>
            {!presets && !presetErr && <p className="font-mono text-[11px] text-ink-3">Resolving with SIMBAD…</p>}
            {presetErr && <p className="text-[11px] text-warn">{presetErr} <button className="underline" onClick={loadPresets}>Retry</button></p>}
            {/* Vertical table on desktop, horizontal scroller on mobile. */}
            <ul className="-mx-1 flex gap-1.5 overflow-x-auto pb-1 lg:mx-0 lg:block lg:space-y-px lg:overflow-visible lg:pb-0">
              {presets?.map(t => {
                const pm = t.resolved?.pmra_masyr != null && t.resolved.pmdec_masyr != null ? Math.hypot(t.resolved.pmra_masyr, t.resolved.pmdec_masyr) / 1000 : null
                const on = !!active && String(t.ra) === active.ra && String(t.dec) === active.dec
                return (
                  <li key={t.id} className="shrink-0">
                    <button disabled={t.ra == null} onClick={() => go({ ...p, ra: String(t.ra), dec: String(t.dec) })}
                      title={`${t.why}. ${t.error ?? t.coord_source}`} aria-current={on ? 'true' : undefined}
                      className={`grid w-52 grid-cols-[1fr_auto] gap-x-2 rounded-sm border-l-2 px-2 py-1.5 text-left hover:bg-hover disabled:opacity-40 lg:w-full ${on ? 'border-accent bg-raised' : 'border-transparent'}`}>
                      <span className="truncate text-[12px] font-medium text-ink">{t.label}</span>
                      <span className="font-mono text-[10px] text-ink-2">{pm != null && pm > 0.1 ? `μ ${pm.toFixed(2)}″/yr` : ''}</span>
                      <span className="col-span-2 truncate font-mono text-[10px] text-ink-3">{t.ra?.toFixed(4)} {t.dec != null ? sign(t.dec).slice(0, -1) : ''}{t.coord_source?.includes('fixed') ? ' · brief' : ''}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className={section}>
            <h2 className={heading}>Overlays</h2>
            <label className="flex items-center gap-2 text-[12px] text-ink">
              <input type="checkbox" checked={gaiaOn} disabled={demo || !active} onChange={e => setGaiaOn(e.target.checked)} className="h-3.5 w-3.5 accent-gaia" />
              Gaia DR3 overlay
            </label>
            {gaiaOn && gaia && (
              <label className="mt-1.5 flex items-center gap-2 text-[11px] text-ink-2">Show stars brighter than
                <select value={gmax} onChange={e => setGmax(+e.target.value)} className="h-6 rounded-sm border border-line-strong bg-canvas px-1 font-mono text-ink">
                  {[12, 14, 16, 18, 19].map(g => <option key={g} value={g}>G {g}</option>)}
                </select>
                <span className="font-mono text-ink">{gaia.filter(s => s.g < gmax).length}</span>
              </label>
            )}
            <p className="mt-1 text-[11px] text-ink-3">
              {gaiaOn ? <span aria-live="polite" className="text-ink-2">{gaiaMsg}</span>
                : !active ? 'Available after a live archive search.' : 'Catalogue stars, moved to each frame’s date using Gaia proper motions.'}
            </p>
          </div>

          <div className={section}>
            <h2 className={heading}>Display</h2>
            <div className="grid grid-cols-2 gap-2">
              <select aria-label="Intensity stretch" value={stretch} onChange={e => setStretch(e.target.value)} className={input}>
                <option value="asinh">asinh</option><option value="linear">linear</option>
              </select>
              <select aria-label="Colour map" value={cmap} onChange={e => setCmap(e.target.value)} className={input}>
                {['inferno', 'magma', 'viridis', 'gray'].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
        </aside>

        {/* centre: viewer */}
        <main className="min-w-0 p-2 sm:p-3 xl:flex xl:flex-col xl:overflow-y-auto xl:p-2">
          {phase === 'idle' && (
            <section aria-label="Getting started" className="border border-line bg-panel">
              <div className="border-b border-line px-3 py-2 text-[12px] text-ink">
                No field loaded. Enter RA/Dec or pick a target. SPHERE TRACK lists every SPHEREx DR1 observation of the position in IRSA, aligns the cutouts by WCS, and plays them in time order.
              </div>
              <div className="grid gap-px bg-line sm:grid-cols-2">
                {EXAMPLES.map(x => (
                  <button key={x.label} aria-label={`Example: ${x.label}`} onClick={() => go({ ...p, ra: x.ra, dec: x.dec, band: 'D6' })}
                    className="bg-panel px-3 py-3 text-left hover:bg-hover">
                    <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink"><Crosshair size={13} className="text-accent-ink" aria-hidden />{x.label}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-ink-2">{x.ra} {sign(Number(x.dec)).slice(0, -1)} · D6</div>
                    <div className="mt-0.5 text-[11px] text-ink-3">{x.note}</div>
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-[11px]">
                <span className="text-ink-3">First retrieval takes 10–20 s per cutout, then results are cached.</span>
                <button onClick={startDemo} className="inline-flex shrink-0 items-center gap-1 text-warn hover:underline">
                  <FlaskConical size={12} aria-hidden />Demo mode (synthetic, not SPHEREx)
                </button>
              </div>
            </section>
          )}
          {phase === 'error' && (
            <section role="alert" className="border border-line border-l-2 border-l-warn bg-panel px-3 py-3">
              <h2 className="text-[13px] font-semibold text-warn">Archive request failed</h2>
              <p className="mt-0.5 font-mono text-[11px] text-ink-2">{err}</p>
              <div className="mt-2 flex gap-2">
                {active && <button onClick={() => search(active)} className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-accent/70 px-3 text-xs text-accent-ink hover:bg-accent/10"><RotateCw size={13} aria-hidden />Retry</button>}
                <button onClick={startDemo} className="h-8 rounded-sm border border-line-strong px-3 text-xs text-warn hover:bg-hover">Demo mode</button>
              </div>
            </section>
          )}
          {phase === 'empty' && (
            <section className="border border-line bg-panel px-3 py-3">
              <h2 className="text-[13px] font-semibold text-ink">No SPHEREx observations found</h2>
              <p className="mt-0.5 text-[12px] text-ink-2">
                IRSA SPHEREx DR1 returned no {active?.band} science images containing RA {active?.ra}, Dec {active?.dec}.
                {!(obsInfo && Object.values(obsInfo.band_counts).some(Boolean)) && ' DR1 covers only part of the mission, so some positions have no released images yet.'}
              </p>
              {obsInfo && Object.values(obsInfo.band_counts).some(Boolean) && active && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-ink-2">Other bands have data:</span>
                  {Object.entries(obsInfo.band_counts).filter(([, n]) => n).map(([b, n]) => (
                    <button key={b} onClick={() => go({ ...active, band: b })} className="h-7 rounded-sm border border-line-strong px-2 font-mono hover:border-accent hover:text-accent-ink">{b} ({n})</button>
                  ))}
                </div>
              )}
              <button onClick={startDemo} className="mt-2 text-[11px] text-warn hover:underline">Show demo mode (synthetic, not SPHEREx)</button>
            </section>
          )}
          {demo && (
            <div role="note" className="mb-2 border-l-2 border-warn bg-warn/5 px-3 py-1.5 text-[12px] text-warn">
              <b>DEMO MODE.</b> Synthetic images (NumPy stars, one moving and one variable source). These are not SPHEREx or NASA data.
            </div>
          )}
          {phase === 'querying' && slots.length === 0 && (
            <div className="border border-line bg-panel px-3 py-10 text-center font-mono text-[12px] text-ink-2">Querying NASA/IPAC IRSA SIA2 for SPHEREx observations…</div>
          )}
          {(phase === 'loading' || phase === 'done' || phase === 'querying') && (slots.length > 0 || phase !== 'querying') && (
            <>
              {/* Viewer stays mounted while the dashboard is shown, so playback/selection state is kept. */}
              <div ref={viewerRef} className={`scroll-mt-2 ${workspace === 'viewer' ? 'xl:flex xl:flex-1 xl:flex-col' : 'hidden'}`}>
                <Viewer slots={slots} demo={demo} band={active?.band} totalVisits={obsInfo?.total_in_band} gaia={gaiaOn && gaia ? gaia.filter(s => s.g < gmax) : null}
                  stretch={stretch} cmap={cmap} cand={cand} onCand={setCand}
                  onRetry={id => retry([id])} onRetryAll={() => retry(slots.filter(s => s.status === 'error').map(s => s.id))}
                  onSelect={onSelect} onDiff={setDiff} jumpTo={jumpTo} onPixel={setPixelSel} clearPixel={clearPixel} />
              </div>
              {workspace === 'dashboard' && (
                <Dashboard slots={slots} obsInfo={obsInfo} band={active?.band} demo={demo} selectedKey={sel?.key}
                  onPick={key => setJumpTo({ key, seq: Date.now() })} />
              )}
            </>
          )}
        </main>

        {/* right inspector */}
        <aside aria-label="Inspector" className="min-w-0 border-t border-line bg-panel lg:col-start-2 xl:col-start-auto xl:border-l xl:border-t-0 xl:overflow-y-auto">
          {slots.length > 0 && <PixelInspector sel={pixelSel} onClear={() => { setPixelSel(null); setClearPixel(c => c + 1) }} />}
          {sel ? <MeasuredPanel m={sel} /> : (
            <div className={section}><h2 className={heading}>Frame</h2><p className="text-[11px] text-ink-3">Metadata for the displayed observation appears here.</p></div>
          )}
          {sel && <Histogram key={sel.key} frameKey={sel.key} />}
          {sel && !sel.demo && <QAPanel m={sel} />}
          {diff && <DerivedPanel d={diff} cand={cand} onCand={setCand} />}
          <footer className="px-3 py-3 text-[10px] leading-relaxed text-ink-3">
            Data: SPHEREx DR1 via NASA/IPAC Infrared Science Archive (IRSA), SIA2 + IBE cutout service. Name resolution: SIMBAD (CDS) via Sesame.
            Overlay: ESA Gaia DR3. A moving or changing source here is a candidate for follow-up, not a discovery — and never evidence of “Planet X” on its own.
            <br />SPHERE TRACK is an independent NASA Space Apps Challenge project. It is not endorsed by NASA, Caltech/IPAC, ESA or CDS.
          </footer>
        </aside>
      </div>
      <Toaster theme={theme.resolved} position="top-right" closeButton
        // Below the toolbar, and expanded: Sonner's collapsed stack shifts older toasts upward, back over the toolbar.
        offset={{ top: headerH + 8, right: 12 }} mobileOffset={{ top: headerH + 8, left: 8, right: 8 }} expand visibleToasts={3}
        toastOptions={{ style: { fontFamily: 'Inter, system-ui, sans-serif', borderRadius: 3, background: 'var(--raised)', color: 'var(--ink)', border: '1px solid var(--line-strong)' } }} />
    </div>
  )
}

function Row({ k, v }: { k: React.ReactNode; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-b border-raised py-[3px]">
      <dt className="flex items-center text-ink-2">{k}</dt>
      <dd className="text-right font-mono text-ink">{v ?? '—'}</dd>
    </div>
  )
}

function MeasuredPanel({ m }: { m: FrameMeta }) {
  return (
    <section className={section} aria-label="Frame metadata">
      <h2 className={heading}>
        <span className={m.demo ? 'text-warn' : 'text-ink'}>{m.demo ? 'Synthetic' : 'Measured'}</span>
        <span className="font-normal text-ink-3">· frame metadata{m.demo ? '' : ' from FITS headers'}</span>
      </h2>
      {m.demo ? <p className="text-[12px] text-warn">{m.note}</p> : (
        <dl className="text-[11px]">
          <Row k="Observation ID" v={m.obsid} />
          <Row k={<span title="Mid-exposure time, UTC">DATE-AVG</span>} v={fmtDate(m).replace(' UTC', '')} />
          <Row k="MJD-AVG" v={m.mjd?.toFixed(6)} />
          <Row k="Exposure" v={m.exptime_s ? `${m.exptime_s.toFixed(1)} s` : null} />
          <Row k="Detector" v={m.detector != null ? `D${m.detector}` : null} />
          <Row k={<>λ at target<InfoTip label="Wavelength" align="start">The wavelength measured at the target pixel, read from the WCS-WAVE table. SPHEREx's linear variable filter makes it change with detector position, so frames of one band can differ by ~0.5 µm.</InfoTip></>}
            v={m.wavelength_at_target ? `${m.wavelength_at_target.center_um.toFixed(4)} µm` : null} />
          <Row k="Δλ at target" v={m.wavelength_at_target ? `${m.wavelength_at_target.width_um.toFixed(4)} µm` : null} />
          <Row k="Units" v={m.bunit} />
          <Row k="Native pixel scale" v={m.native_pixscale_arcsec ? `${m.native_pixscale_arcsec.toFixed(2)}″` : null} />
          <Row k="Native rotation" v={m.native_rotation_deg != null ? `${m.native_rotation_deg.toFixed(2)}°` : null} />
          <Row k="Science HDU" v={m.hdu} />
          {/* Counted over the retrieved native cutout, which can be larger than the field when a cached cutout is reused. */}
          <Row k="Masked pixels (native cutout)" v={m.masked_pixels != null && m.native_shape ? `${m.masked_pixels} / ${m.native_shape[1]}×${m.native_shape[0]}` : m.masked_pixels} />
          <Row k={<>Field coverage<InfoTip label="Field coverage" align="start">Percentage of the displayed field containing valid observed data after excluding masked pixels. Areas outside the detector are not observed.</InfoTip></>}
            v={`${Math.round(m.coverage_fraction * 100)}%`} />
          {m.detector_position && (
            <Row k={<span title="Distance from the target to the nearest edge of the 2040 × 2040 active detector area, from the pipeline's detector-pixel WCS">Target → detector edge</span>}
              v={<>{m.detector_position.edge_px.toFixed(0)} px <span className="text-ink-3">(x {m.detector_position.x.toFixed(0)}, y {m.detector_position.y.toFixed(0)})</span></>} />
          )}
          <Row k="Pipeline" v={m.pipeline_version} />
          {m.flag_counts && (
            <div className="py-1.5">
              <dt className="mb-1 text-ink-2">Flag planes set (pixels)</dt>
              <dd className="grid grid-cols-2 gap-x-3 font-mono text-[10px] text-ink">
                {Object.entries(m.flag_counts).map(([n, c]) => <span key={n} className="flex justify-between"><span className="text-ink-3">{n}</span>{c}</span>)}
              </dd>
            </div>
          )}
          {m.source_url && <a href={m.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11px] text-accent-ink hover:underline">Full IRSA file ↗</a>}
        </dl>
      )}
    </section>
  )
}

const UNAVAILABLE = <span className="text-ink-3">Unavailable</span>
const qaText = (v: string | null | undefined) => v ?? UNAVAILABLE
const qaCount = (v: number | null | undefined) => (v == null ? UNAVAILABLE : v.toLocaleString('en-US'))

/** Pipeline QA exactly as recorded in the FITS header; detector-wide header counts kept apart from the field count. */
function QAPanel({ m }: { m: FrameMeta }) {
  const q = m.pipeline_qa
  return (
    <section className={section} aria-label="Pipeline QA">
      <h2 className={heading}>
        <span className="text-ink">Pipeline QA</span><span className="font-normal text-ink-3">· SPHEREx FITS header</span>
        <InfoTip label="Pipeline QA" align="start">Values recorded by the SPHEREx pipeline. "Pass" means the pipeline's automated quality checks passed; it is not proof that the image is free of artefacts.</InfoTip>
      </h2>
      <dl className="text-[11px]">
        <Row k="L1 data-quality (L1DQAFLG)" v={qaText(q?.l1_dqa)} />
        <Row k="L2 data-quality (L2DQAFLG)" v={qaText(q?.l2_dqa)} />
        <div className="mt-1.5 text-[10px] font-semibold text-ink-3">Whole detector · reported by pipeline</div>
        <Row k="Satellite streaks (SATSTRKS)" v={qaCount(q?.detector_streaks)} />
        <Row k="Streak pixels (SATSTRKS_PXS)" v={qaCount(q?.detector_streak_pixels)} />
        <div className="mt-1.5 text-[10px] font-semibold text-ink-3">Displayed field · from FITS FLAGS</div>
        <Row k="STREAK-flagged pixels" v={qaCount(q?.field_streak_pixels)} />
      </dl>
      {q?.detector_streaks != null && q.detector_streaks > 0 && (
        <p role="note" data-testid="streak-advisory" className="mt-2 border-l-2 border-warn bg-warn/5 px-2 py-1 text-[11px] text-ink">
          The pipeline reports satellite streak activity. Reported streaks may lie outside this displayed field, and additional unflagged linear trails may remain. Inspect linear residuals across multiple observations before interpreting them as astronomical sources.
        </p>
      )}
      <p className="mt-1.5 text-[10px] leading-snug text-ink-3">QA “Pass” reflects automated pipeline checks only; it does not certify the image is free of artefacts.</p>
    </section>
  )
}

function DerivedPanel({ d, cand, onCand }: { d: DiffResult; cand: number | null; onCand: (i: number | null) => void }) {
  const off = d.registration_offset_px
  const offBad = off && (off[0] !== 0 || off[1] !== 0)
  const c = cand != null ? d.candidates[cand] : null
  return (
    <section className={section} aria-label="Difference analysis">
      <h2 className={heading}><span className="text-ink">Derived</span><span className="font-normal text-ink-3">· difference A − k·B</span></h2>
      <dl className="text-[11px]">
        <Row k="Noise σ (MAD)" v={d.noise_sigma.toPrecision(3)} />
        <Row k="Flux scale k (A ≈ k·B)" v={d.flux_scale_b_to_a.toFixed(4)} />
        <Row k="Overlap" v={`${Math.round(d.overlap_fraction * 100)}%`} />
        <Row k="Residual registration offset" v={off ? `${off[0]}, ${off[1]} px` : 'n/a'} />
        {d.wavelength_mismatch_um != null && <Row k="Δλ between A and B" v={`${d.wavelength_mismatch_um.toFixed(4)} µm`} />}
      </dl>
      {offBad && <p className="mt-2 border-l-2 border-warn pl-2 text-[11px] text-warn">Point sources correlate best at a non-zero offset. Residuals may be registration error rather than motion.</p>}
      {d.wavelength_mismatch_um != null && d.wavelength_mismatch_um > 0.02 && (
        <p className="mt-2 border-l-2 border-warn pl-2 text-[11px] text-warn">A and B sample different wavelengths. Brightness changes can be spectral, not temporal.</p>
      )}

      <h3 className="mt-3 text-[11px] font-semibold text-ink">Candidate residuals ≥5σ <span className="font-normal text-ink-3">({d.n_candidates_total}, unvetted)</span></h3>
      {d.candidates.length === 0 ? <p className="mt-1 text-[11px] text-ink-3">None above threshold.</p> : (
        <div className="mt-1 font-mono text-[10.5px]" role="list" aria-label="Candidate residuals">
          <div className={`${CAND_GRID} px-1 py-0.5 text-ink-3`} aria-hidden>
            <span>#</span><span>{d.demo ? 'x, y' : 'RA'}</span><span>{d.demo ? '' : 'Dec'}</span><span className="text-right">σ</span><span className="text-right">sign</span>
          </div>
          {d.candidates.map((k, i) => (
            <div role="listitem" key={i} className="border-t border-raised">
              <button aria-pressed={cand === i} aria-label={`Candidate ${i + 1}, ${k.snr} sigma, ${k.sign === 'brighter_in_A' ? 'brighter in A' : 'brighter in B'}`}
                onClick={() => onCand(cand === i ? null : i)}
                className={`${CAND_GRID} w-full px-1 py-[3px] text-left ${cand === i ? 'bg-line outline outline-1 outline-ink/60' : 'hover:bg-hover'}`}>
                <span className="text-ink-2">{i + 1}</span>
                <span className="text-ink">{d.demo ? `${k.x}, ${k.y}` : k.ra.toFixed(5)}</span>
                <span className="text-ink">{d.demo ? '' : sign(k.dec)}</span>
                <span className="text-right text-ink">{k.snr}</span>
                <span className={`text-right font-semibold ${k.sign === 'brighter_in_A' ? 'text-diff-a' : 'text-diff-b'}`}>{k.sign === 'brighter_in_A' ? 'A' : 'B'}</span>
              </button>
            </div>
          ))}
        </div>
      )}
      {c && (
        <dl data-testid="candidate-detail" className="mt-2 border border-line-strong bg-canvas px-2 py-1.5 text-[11px]">
          <Row k={`Candidate #${cand! + 1}`} v="derived" />
          {!d.demo && <Row k="RA, Dec (deg)" v={`${c.ra.toFixed(5)}, ${sign(c.dec)}`} />}
          <Row k="Grid pixel" v={`x ${c.x}, y ${c.y}`} />
          <Row k="Significance" v={`${c.snr} σ`} />
          <Row k="Sign" v={<span className={c.sign === 'brighter_in_A' ? 'text-diff-a' : 'text-diff-b'}>{c.sign === 'brighter_in_A' ? 'brighter in A' : 'brighter in B'}</span>} />
        </dl>
      )}
      <p className="mt-2 text-[10px] leading-snug text-ink-3">A residual is not a detection. Streaks, cosmic rays, ghosts, PSF and wavelength differences all leave residuals. Confirm across more epochs and against catalogues.</p>
    </section>
  )
}
