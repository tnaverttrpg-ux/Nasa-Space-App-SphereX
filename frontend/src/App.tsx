import { useCallback, useEffect, useRef, useState } from 'react'
import { BANDS, getJSON, type DiffResult, type FrameMeta, type GaiaSource, type ObsResponse, type Preset } from './api'
import Viewer, { type Slot } from './components/Viewer'

const FOV_MIN = 0.02, FOV_MAX = 0.5
const CONCURRENCY = 4 // polite to IRSA; each cutout takes ~10-20 s server-side on first fetch

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

const card = 'rounded-2xl bg-space-900/80 p-4 ring-1 ring-space-700 backdrop-blur'
const input = 'w-full min-w-0 rounded-lg bg-space-950 px-3 py-2 font-mono text-sm text-slate-100 ring-1 ring-space-600 focus:ring-cyan-glow'

export default function App() {
  const init = useRef(readUrl()).current
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
  const [gaiaOn, setGaiaOn] = useState(false)
  const [gaia, setGaia] = useState<GaiaSource[] | null>(null)
  const [gaiaMsg, setGaiaMsg] = useState('')
  const [active, setActive] = useState<Params | null>(null)
  const run = useRef<AbortController | null>(null)

  const loadPresets = useCallback(() => {
    setPresetErr('')
    getJSON<Preset[]>('presets', {}, 60_000).then(setPresets).catch(e => setPresetErr(e.message))
  }, [])
  useEffect(loadPresets, [loadPresets])

  const patch = (id: string, s: Partial<Slot>) => setSlots(v => v.map(x => (x.id === id ? { ...x, ...s } : x)))

  const loadFrame = useCallback(async (slot: Slot, q: Params, signal: AbortSignal) => {
    patch(slot.id, { status: 'loading', error: undefined })
    try {
      const m = await getJSON<FrameMeta>('frame', { url: slot.id, ra: q.ra, dec: q.dec, fov: q.fov, exptime_s: slot.exptime ?? '' }, 240_000, signal)
      patch(slot.id, { status: 'ok', meta: m, mjd: m.mjd ?? slot.mjd })
    } catch (e) {
      if ((e as Error).message !== 'cancelled') patch(slot.id, { status: 'error', error: (e as Error).message })
    }
  }, [])

  const search = useCallback(async (q: Params) => {
    const v = validate(q)
    if (v) { setFormErr(v); return }
    setFormErr('')
    run.current?.abort()
    const ctl = new AbortController(); run.current = ctl
    history.replaceState(null, '', `?ra=${q.ra}&dec=${q.dec}&fov=${q.fov}&band=${q.band}&n=${q.n}`)
    setDemo(false); setActive(q); setSlots([]); setSel(null); setDiff(null); setGaia(null); setGaiaOn(false); setObsInfo(null)
    setPhase('querying'); setErr('')
    let r: ObsResponse
    try {
      r = await getJSON<ObsResponse>('observations', { ra: q.ra, dec: q.dec, band: q.band, limit: q.n }, 120_000, ctl.signal)
    } catch (e) {
      if ((e as Error).message === 'cancelled') return
      setErr((e as Error).message); setPhase('error'); return
    }
    setObsInfo(r)
    if (r.observations.length === 0) { setPhase('empty'); return }
    const list: Slot[] = r.observations.map(o => ({
      id: o.access_url, mjd: o.mjd_start, label: `${o.obs_id} · MJD ${o.mjd_start.toFixed(3)}`, status: 'pending', exptime: o.exptime_s,
    }))
    setSlots(list); setPhase('loading')
    let next = 0
    const worker = async () => { while (next < list.length && !ctl.signal.aborted) await loadFrame(list[next++], q, ctl.signal) }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    if (!ctl.signal.aborted) setPhase('done')
  }, [loadFrame])

  const startDemo = async () => {
    run.current?.abort()
    setPhase('querying'); setErr(''); setSel(null); setDiff(null); setGaiaOn(false); setGaia(null); setObsInfo(null); setActive(null)
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
      .then(g => { setGaia(g.sources); setGaiaMsg(`${g.sources.length} Gaia DR3 sources (G<19), propagated to each frame epoch`) })
      .catch(e => { setGaia(null); setGaiaMsg(`Gaia overlay unavailable: ${e.message}`) })
  }, [gaiaOn, active, demo])

  const retry = (id: string) => {
    const s = slots.find(x => x.id === id)
    if (s && active) loadFrame(s, active, (run.current ??= new AbortController()).signal)
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
  const onSelect = useCallback((m: FrameMeta) => setSel(m), [])

  return (
    <div className="mx-auto max-w-[1500px] px-4 pb-10 sm:px-6">
      <header className="flex flex-wrap items-center gap-3 py-5">
        <img src="/favicon.svg" alt="" className="h-9 w-9" />
        <div>
          <h1 className="bg-gradient-to-r from-cyan-glow to-violet-glow bg-clip-text text-2xl font-bold tracking-[0.18em] text-transparent">SPHERE TRACK</h1>
          <p className="text-xs text-slate-400">SPHEREx time-series explorer · NASA Space Apps 2026 · Planet X &amp; SPHEREx</p>
        </div>
        <span className={`ml-auto rounded-full px-3 py-1 text-xs font-semibold ring-1 ${demo ? 'bg-amber-400/10 text-amber-300 ring-amber-400/40' : 'bg-cyan-glow/10 text-cyan-glow ring-cyan-glow/30'}`}>
          {demo ? 'DEMO MODE · synthetic images' : 'LIVE · NASA/IPAC IRSA'}
        </span>
      </header>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <aside className="min-w-0 space-y-4">
          <form className={card} onSubmit={e => { e.preventDefault(); search(p) }} noValidate>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">Sky position</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">RA (deg)
                <input className={input} inputMode="decimal" value={p.ra} placeholder="0 – 360" onChange={e => setP({ ...p, ra: e.target.value })} aria-invalid={!!formErr} />
              </label>
              <label className="text-xs text-slate-400">Dec (deg)
                <input className={input} inputMode="decimal" value={p.dec} placeholder="−90 – +90" onChange={e => setP({ ...p, dec: e.target.value })} aria-invalid={!!formErr} />
              </label>
            </div>
            <label className="mt-3 block text-xs text-slate-400">Field of view: <span className="font-mono text-slate-200">{p.fov.toFixed(2)}° ({(p.fov * 60).toFixed(1)}′)</span>
              <input type="range" min={FOV_MIN} max={FOV_MAX} step={0.01} value={p.fov} onChange={e => setP({ ...p, fov: +e.target.value })} className="w-full" />
            </label>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">Band (detector)
                <select className={input} value={p.band} onChange={e => setP({ ...p, band: e.target.value })}>
                  {BANDS.map(([b, r]) => <option key={b} value={b}>{b} {r}</option>)}
                </select>
              </label>
              <label className="text-xs text-slate-400">Max frames
                <input className={input} type="number" min={2} max={48} value={p.n} onChange={e => setP({ ...p, n: Math.min(48, Math.max(2, +e.target.value || 2)) })} />
              </label>
            </div>
            {formErr && <p role="alert" className="mt-2 text-xs text-red-300">{formErr}</p>}
            <button type="submit" disabled={phase === 'querying'} className="mt-4 w-full rounded-lg bg-gradient-to-r from-cyan-500 to-violet-500 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-500/20 hover:brightness-110 disabled:opacity-50">
              {phase === 'querying' ? 'Querying IRSA…' : 'Search SPHEREx archive'}
            </button>
            <div className="mt-3 flex gap-2">
              <input className={input} value={nameQ} placeholder="Object name, e.g. M 42" onChange={e => setNameQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); resolveName() } }} aria-label="Object name" />
              <button type="button" onClick={resolveName} className="rounded-lg px-3 text-xs ring-1 ring-space-600 hover:bg-space-700">Resolve</button>
            </div>
            {nameMsg && <p className="mt-1 text-[11px] text-slate-400">{nameMsg}</p>}
          </form>

          <div className={card}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">Preset targets</h2>
            {!presets && !presetErr && <p className="text-xs text-slate-500">Resolving with SIMBAD…</p>}
            {presetErr && <p className="text-xs text-red-300">{presetErr} <button className="underline" onClick={loadPresets}>Retry</button></p>}
            <ul className="space-y-1.5">
              {presets?.map(t => (
                <li key={t.id}>
                  <button disabled={t.ra == null} onClick={() => { const q = { ...p, ra: String(t.ra), dec: String(t.dec) }; setP(q); search(q) }}
                    className="w-full rounded-lg px-3 py-2 text-left ring-1 ring-space-700 hover:bg-space-800 hover:ring-cyan-glow/40 disabled:opacity-40">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-slate-100">{t.label}</span>
                      <span className="font-mono text-[10px] text-slate-500">{t.ra?.toFixed(4)}, {t.dec?.toFixed(4)}</span>
                    </div>
                    <div className="text-[11px] text-slate-400">{t.why}</div>
                    <div className="text-[10px] text-slate-500">{t.error ?? t.coord_source}</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className={card}>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={gaiaOn} disabled={demo || !active} onChange={e => setGaiaOn(e.target.checked)} className="accent-emerald-400" />
              Gaia DR3 overlay <span className="text-[10px] text-slate-500">(catalogue, green circles)</span>
            </label>
            {gaiaOn && <p className="mt-1 text-[11px] text-slate-400">{gaiaMsg}</p>}
          </div>
        </aside>

        <main className="min-w-0 space-y-4">
          {phase === 'idle' && (
            <div className={`${card} py-16 text-center`}>
              <h2 className="text-lg font-semibold text-slate-100">Pick a sky position</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">Enter RA/Dec or choose a preset. SPHERE TRACK queries the NASA/IPAC IRSA SPHEREx archive, retrieves official cutouts and plays them in time order so moving or variable sources stand out.</p>
              <button onClick={startDemo} className="mt-5 rounded-lg px-4 py-2 text-sm text-amber-300 ring-1 ring-amber-400/40 hover:bg-amber-400/10">Try DEMO MODE (synthetic images)</button>
            </div>
          )}
          {phase === 'error' && (
            <div role="alert" className={`${card} py-10 text-center`}>
              <h2 className="font-semibold text-red-300">Archive request failed</h2>
              <p className="mt-1 text-sm text-slate-400">{err}</p>
              <div className="mt-4 flex justify-center gap-2">
                {active && <button onClick={() => search(active)} className="rounded-lg bg-cyan-glow/15 px-4 py-2 text-sm text-cyan-glow ring-1 ring-cyan-glow/40">Retry</button>}
                <button onClick={startDemo} className="rounded-lg px-4 py-2 text-sm text-amber-300 ring-1 ring-amber-400/40">DEMO MODE</button>
              </div>
            </div>
          )}
          {phase === 'empty' && (
            <div className={`${card} py-10 text-center`}>
              <h2 className="font-semibold text-slate-100">No SPHEREx observations found</h2>
              <p className="mx-auto mt-1 max-w-lg text-sm text-slate-400">
                The IRSA SPHEREx DR1 archive returned no {active?.band} science images containing RA {active?.ra}, Dec {active?.dec}.
                {obsInfo && Object.values(obsInfo.band_counts).some(Boolean) && <> Other bands have data: {Object.entries(obsInfo.band_counts).filter(([, n]) => n).map(([b, n]) => `${b} (${n})`).join(', ')}.</>}
              </p>
              <button onClick={startDemo} className="mt-4 rounded-lg px-4 py-2 text-sm text-amber-300 ring-1 ring-amber-400/40 hover:bg-amber-400/10">Show DEMO MODE (synthetic, not SPHEREx)</button>
            </div>
          )}
          {demo && (
            <div role="note" className="rounded-xl bg-amber-400/10 px-4 py-2 text-sm text-amber-200 ring-1 ring-amber-400/40">
              <b>DEMO MODE.</b> These images are synthetic (NumPy-generated stars, one moving and one variable source). They are not SPHEREx or NASA data.
            </div>
          )}
          {(phase === 'loading' || phase === 'done' || phase === 'querying') && (slots.length > 0 || phase !== 'querying') && (
            <>
              {!demo && obsInfo && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                  <span><b className="text-slate-200">{obsInfo.total_in_band}</b> {active?.band} observations contain this position; showing {slots.length}{obsInfo.total_in_band > slots.length ? ' (evenly sampled across the time baseline)' : ''}.</span>
                  <span>Loaded {nOk}/{slots.length}{nErr ? ` · ${nErr} failed` : ''}</span>
                  {phase === 'loading' && <span className="animate-pulse text-cyan-glow">Retrieving cutouts from IRSA (first fetch ≈10–20 s each, then cached)…</span>}
                </div>
              )}
              <Viewer slots={slots} demo={demo} gaia={gaiaOn ? gaia : null} onRetry={retry} onSelect={onSelect} onDiff={setDiff} />
            </>
          )}
          {phase === 'querying' && slots.length === 0 && (
            <div className={`${card} py-16 text-center text-sm text-slate-400`}><span className="animate-pulse">Querying NASA/IPAC IRSA SIA2 for SPHEREx observations…</span></div>
          )}

          {(sel || diff) && (
            <div className="grid gap-4 xl:grid-cols-2">
              {sel && <MeasuredPanel m={sel} />}
              {diff && <DerivedPanel d={diff} />}
            </div>
          )}
        </main>
      </div>

      <footer className="mt-10 border-t border-space-700 pt-4 text-[11px] leading-relaxed text-slate-500">
        Data: SPHEREx DR1 via NASA/IPAC Infrared Science Archive (IRSA), SIA2 + IBE cutout service. Name resolution: SIMBAD (CDS) via Sesame.
        Overlay: ESA Gaia DR3. A moving or changing source here is a candidate for follow-up, not a discovery — and never evidence of “Planet X” on its own.
      </footer>
    </div>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-3 border-b border-space-800 py-1"><dt className="text-slate-400">{k}</dt><dd className="text-right font-mono text-slate-200">{v ?? '—'}</dd></div>
}

function MeasuredPanel({ m }: { m: FrameMeta }) {
  return (
    <section className="rounded-2xl bg-space-900/80 p-4 ring-1 ring-cyan-glow/30">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className={`rounded px-1.5 py-0.5 text-[10px] tracking-wider ${m.demo ? 'bg-amber-400/15 text-amber-300' : 'bg-cyan-glow/15 text-cyan-glow'}`}>{m.demo ? 'SYNTHETIC' : 'MEASURED'}</span>
        Frame metadata {m.demo ? '' : '(from FITS headers)'}
      </h3>
      {m.demo ? <p className="text-sm text-slate-400">{m.note}</p> : (
        <dl className="text-xs">
          <Row k="Observation ID" v={m.obsid} />
          <Row k="Mid-exposure (DATE-AVG)" v={m.date_obs} />
          <Row k="MJD-AVG" v={m.mjd?.toFixed(6)} />
          <Row k="Exposure" v={m.exptime_s ? `${m.exptime_s.toFixed(1)} s` : null} />
          <Row k="Detector / band" v={m.detector != null ? `D${m.detector}` : null} />
          <Row k="λ at target (LVF)" v={m.wavelength_at_target ? `${m.wavelength_at_target.center_um} µm (Δλ ${m.wavelength_at_target.width_um})` : null} />
          <Row k="Units" v={m.bunit} />
          <Row k="Native pixel scale" v={m.native_pixscale_arcsec ? `${m.native_pixscale_arcsec}″` : null} />
          <Row k="Native rotation" v={m.native_rotation_deg != null ? `${m.native_rotation_deg}°` : null} />
          <Row k="Science HDU" v={m.hdu} />
          <Row k="Masked bad pixels" v={m.masked_pixels} />
          <Row k="Coverage of field" v={`${Math.round(m.coverage_fraction * 100)}%`} />
          <Row k="Pipeline" v={m.pipeline_version} />
          {m.flag_counts && <Row k="Flag planes set" v={<span className="text-[10px]">{Object.entries(m.flag_counts).map(([n, c]) => `${n}:${c}`).join(' ')}</span>} />}
          {m.source_url && <div className="pt-2"><a href={m.source_url} target="_blank" rel="noreferrer" className="text-cyan-glow underline">Full IRSA file</a></div>}
        </dl>
      )}
    </section>
  )
}

function DerivedPanel({ d }: { d: DiffResult }) {
  const off = d.registration_offset_px
  const offBad = off && (off[0] !== 0 || off[1] !== 0)
  return (
    <section className="rounded-2xl bg-space-900/80 p-4 ring-1 ring-violet-glow/30">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="rounded bg-violet-glow/15 px-1.5 py-0.5 text-[10px] tracking-wider text-violet-glow">DERIVED</span>
        Difference analysis (computed by SPHERE TRACK)
      </h3>
      <dl className="text-xs">
        <Row k="Difference noise σ (MAD)" v={d.noise_sigma.toPrecision(3)} />
        <Row k="Flux scale k (A ≈ k·B)" v={d.flux_scale_b_to_a} />
        <Row k="Overlap" v={`${Math.round(d.overlap_fraction * 100)}%`} />
        <Row k="Residual registration offset" v={off ? `${off[0]}, ${off[1]} px` : 'n/a'} />
        {d.wavelength_mismatch_um != null && <Row k="λ difference at target" v={`${d.wavelength_mismatch_um} µm`} />}
      </dl>
      {offBad && <p className="mt-2 text-[11px] text-amber-300">Point sources correlate best at a non-zero offset: residuals may be registration error rather than motion.</p>}
      {d.wavelength_mismatch_um != null && d.wavelength_mismatch_um > 0.02 && (
        <p className="mt-2 text-[11px] text-amber-300">The frames sample different wavelengths. Brightness changes can be spectral, not temporal.</p>
      )}
      <h4 className="mt-3 text-xs font-semibold text-slate-300">Candidate residuals ≥5σ ({d.n_candidates_total})</h4>
      {d.candidates.length === 0 ? <p className="text-xs text-slate-500">None above threshold.</p> : (
        <ol className="mt-1 max-h-48 space-y-0.5 overflow-auto font-mono text-[11px] text-slate-300">
          {d.candidates.map((c, i) => (
            <li key={i}>#{i + 1} {d.demo ? `x=${c.x} y=${c.y}` : `${c.ra.toFixed(5)}, ${c.dec.toFixed(5)}`} · {c.snr}σ · {c.sign === 'brighter_in_A' ? 'brighter in A' : 'brighter in B'}</li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-[11px] text-slate-500">Unvetted residuals. Artefacts (ghosts, cosmic rays, PSF/spectral differences) are common. Confirm against more epochs and catalogues before interpreting anything as motion or variability.</p>
    </section>
  )
}
