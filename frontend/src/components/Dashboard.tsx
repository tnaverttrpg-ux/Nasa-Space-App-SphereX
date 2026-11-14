import { useEffect, useMemo, useRef, useState } from 'react'
import type { ObsResponse } from '../api'
import { fmtDate } from '../api'
import InfoTip from './InfoTip'
import type { Slot } from './Viewer'

/* Observation overview of the LOADED sample. Every value comes from existing frame metadata (/api/frame) or the archive
   query (/api/observations); nothing is fetched or computed from pixels here. */

type QA = 'Pass' | 'Fail' | 'Unavailable'
interface Row {
  id: string; key?: string; status: Slot['status']; source?: string; cached?: string | null
  mjd: number | null; date: string; obsid: string; detector: string; lam: number | null
  cov: number | null; off: number | null; maskDerived: number | null
  l1: string | null; l2: string | null; qa: QA; sat: number | null; satPx: number | null; fieldStreak: number | null
}

const qaOf = (v: string | null | undefined): QA => (v == null ? 'Unavailable' : v === 'Pass' ? 'Pass' : 'Fail')
const pct = (v: number | null, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`)

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.floor(e.contentRect.width))))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function rowsFrom(slots: Slot[]): Row[] {
  return slots.map(s => {
    const m = s.meta, q = m?.pipeline_qa
    const cov = m?.coverage_fraction ?? null, off = m?.off_detector_fraction ?? null
    // Field-level masked/invalid share is DERIVED (no direct field count is stored): 1 − coverage − off-detector.
    // Inputs are rounded to 0.001, so tiny negatives are rounding, clamped to 0.
    const maskDerived = cov != null && off != null ? Math.max(0, 1 - cov - off) : null
    const qa: QA = !m ? 'Unavailable' : [qaOf(q?.l1_dqa), qaOf(q?.l2_dqa)].includes('Fail') ? 'Fail'
      : [qaOf(q?.l1_dqa), qaOf(q?.l2_dqa)].includes('Unavailable') ? 'Unavailable' : 'Pass'
    return {
      id: s.id, key: m?.key, status: s.status, source: s.source, cached: s.cached, mjd: m?.mjd ?? s.mjd,
      date: m ? fmtDate(m) : s.label, obsid: m?.obsid ?? s.label.split(' · ')[0], detector: m?.detector != null ? `D${m.detector}` : '—',
      lam: m?.wavelength_at_target?.center_um ?? null, cov, off, maskDerived,
      l1: q?.l1_dqa ?? null, l2: q?.l2_dqa ?? null, qa,
      sat: q?.detector_streaks ?? null, satPx: q?.detector_streak_pixels ?? null, fieldStreak: q?.field_streak_pixels ?? null,
    }
  })
}

const QA_STYLE: Record<QA, string> = { Pass: 'fill-accent stroke-accent', Fail: 'fill-transparent stroke-warn', Unavailable: 'fill-transparent stroke-ink-3' }

export default function Dashboard({ slots, obsInfo, band, demo, selectedKey, onPick }: {
  slots: Slot[]; obsInfo: ObsResponse | null; band?: string; demo: boolean; selectedKey?: string; onPick: (key: string) => void
}) {
  const rows = useMemo(() => rowsFrom(slots), [slots])
  const ok = rows.filter(r => r.status === 'ok')
  const [tip, setTip] = useState<{ r: Row; x: number; y: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const showTip = (r: Row, e: React.MouseEvent) => {
    const b = wrapRef.current!.getBoundingClientRect()
    setTip({ r, x: e.clientX - b.left, y: e.clientY - b.top })
  }
  const pick = (r: Row) => r.key && onPick(r.key)

  if (!slots.length) {
    return <div data-testid="dash-empty" className="border border-line bg-panel px-3 py-10 text-center text-[12px] text-ink-3">No observations loaded. Search a position or pick a target to see its observation overview.</div>
  }

  // ---- loading / archive -------------------------------------------------------------------------------------------
  const n = (f: (r: Row) => boolean) => rows.filter(f).length
  const load = {
    archive: obsInfo?.total_in_band ?? null, selected: rows.length, loaded: ok.length,
    fromCache: n(r => r.status === 'ok' && (r.source === 'grid' || r.source === 'cutout-cache')),
    downloaded: n(r => r.status === 'ok' && (r.source === 'download' || r.source === 'shared-download')),
    downloading: n(r => r.status === 'loading' && !r.cached), loadingCache: n(r => r.status === 'loading' && !!r.cached),
    queued: n(r => r.status === 'pending'), failed: n(r => r.status === 'error'),
  }

  // ---- coverage --------------------------------------------------------------------------------------------------
  const withCov = ok.filter(r => r.cov != null)
  const lo = withCov.reduce<Row | null>((a, r) => (!a || r.cov! < a.cov! ? r : a), null)
  const hi = withCov.reduce<Row | null>((a, r) => (!a || r.cov! > a.cov! ? r : a), null)
  const mean = withCov.length ? withCov.reduce((s, r) => s + r.cov!, 0) / withCov.length : null
  const covBins = Array.from({ length: 10 }, (_, i) => withCov.filter(r => Math.min(9, Math.floor(r.cov! * 10)) === i).length)

  // ---- QA ----------------------------------------------------------------------------------------------------------
  const dist = (f: (r: Row) => string | null) => ({ Pass: ok.filter(r => f(r) === 'Pass').length, Fail: ok.filter(r => f(r) != null && f(r) !== 'Pass').length, Unavailable: ok.filter(r => f(r) == null).length })
  const l1 = dist(r => r.l1), l2 = dist(r => r.l2)
  const satRows = ok.filter(r => (r.sat ?? 0) > 0), satKnown = ok.filter(r => r.sat != null)
  const fieldKnown = ok.filter(r => r.fieldStreak != null), fieldPos = fieldKnown.filter(r => r.fieldStreak! > 0)
  const lams = ok.map(r => r.lam).filter((v): v is number => v != null)

  const Stat = ({ k, v, id, tone = 'text-ink' }: { k: string; v: React.ReactNode; id?: string; tone?: string }) => (
    <div className="min-w-[88px]"><div className="text-[10px] text-ink-3">{k}</div><div data-testid={id} className={`font-mono text-[15px] ${tone}`}>{v}</div></div>
  )

  return (
    <div ref={wrapRef} className="relative space-y-3" data-testid="dashboard">
      {/* scope */}
      <section className="border border-line bg-panel px-3 py-2.5">
        <p data-testid="dash-scope" className="text-[12px] text-ink-2">
          {demo ? <><b className="text-warn">Synthetic demo data.</b> Archive, QA and wavelength values do not apply.</>
            : <>Showing the <b className="text-ink">loaded sample</b>: <span className="font-mono text-ink">{load.loaded}</span> of <span className="font-mono text-ink">{load.selected}</span> selected
              {load.archive != null && <> from <span className="font-mono text-ink">{load.archive}</span> {band} observations of this position in IRSA SPHEREx DR1{load.archive > load.selected ? ' (evenly sampled across the time baseline)' : ''}</>}.
              Statistics below describe the loaded sample only, not the full archive.</>}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          <Stat k={`In archive (${band ?? '—'})`} v={load.archive ?? '—'} id="dash-archive" />
          <Stat k="Selected" v={load.selected} id="dash-selected" />
          <Stat k="Loaded" v={load.loaded} id="dash-loaded" />
          <Stat k="From cache" v={load.fromCache} id="dash-cache" tone="text-ink-2" />
          <Stat k="Downloaded" v={load.downloaded} id="dash-downloaded" tone="text-ink-2" />
          <Stat k="Downloading" v={load.downloading} id="dash-downloading" tone={load.downloading ? 'text-accent-ink' : 'text-ink-2'} />
          <Stat k="Reading cache" v={load.loadingCache} id="dash-reading" tone="text-ink-2" />
          <Stat k="Queued" v={load.queued} id="dash-queued" tone="text-ink-2" />
          <Stat k="Failed" v={load.failed} id="dash-failed" tone={load.failed ? 'text-warn' : 'text-ink-2'} />
        </div>
      </section>

      <Timeline rows={rows} selectedKey={selectedKey} onPick={pick} onHover={showTip} onLeave={() => setTip(null)} />

      <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
        {/* coverage */}
        <section aria-label="Coverage per observation" className="border border-line bg-panel px-3 py-2.5">
          <h3 className="mb-1.5 flex items-center text-[11px] font-semibold text-ink-2">Field coverage per observation
            <InfoTip label="Field coverage" align="start">Valid observed data as a share of the displayed field. The masked/invalid share is derived as 1 − coverage − off-detector fraction (not a direct pixel count); off-detector sky was never observed.</InfoTip>
          </h3>
          <CoverageBars rows={rows} selectedKey={selectedKey} onPick={pick} onHover={showTip} onLeave={() => setTip(null)} />
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
            <Stat k="Mean coverage" v={pct(mean)} id="dash-cov-mean" />
            <Stat k="Lowest" v={lo ? <button className="hover:underline" onClick={() => pick(lo)}>{pct(lo.cov)}</button> : '—'} id="dash-cov-min" />
            <Stat k="Highest" v={hi ? <button className="hover:underline" onClick={() => pick(hi)}>{pct(hi.cov)}</button> : '—'} id="dash-cov-max" />
          </div>
          <p className="mt-1 text-[10px] text-ink-3">{lo && <>lowest: {lo.date.slice(0, 16)} ({lo.obsid}) · </>}{hi && <>highest: {hi.date.slice(0, 16)} ({hi.obsid})</>}</p>
        </section>

        {/* quality */}
        <section aria-label="Data quality overview" className="border border-line bg-panel px-3 py-2.5">
          <h3 className="mb-1.5 flex items-center text-[11px] font-semibold text-ink-2">Data quality (loaded sample)
            <InfoTip label="Data quality" align="end">QA values are the SPHEREx pipeline's own header flags. “Pass” means its automated checks passed, not that a frame is artefact-free. Streak counts are per-observation, detector-wide pipeline reports and are never added up across observations.</InfoTip>
          </h3>
          <table className="w-full font-mono text-[11px]" data-testid="dash-qa">
            <thead><tr className="text-left text-[10px] text-ink-3"><th className="font-normal">header flag</th><th className="font-normal">Pass</th><th className="font-normal">Fail</th><th className="font-normal">Unavailable</th></tr></thead>
            <tbody>
              {([['L1DQAFLG', l1], ['L2DQAFLG', l2]] as const).map(([k, d]) => (
                <tr key={k} className="border-t border-raised"><td className="py-0.5 text-ink-2">{k}</td>
                  <td data-testid={`dash-${k}-pass`} className="text-ink">{d.Pass}</td><td className={d.Fail ? 'text-warn' : 'text-ink-3'}>{d.Fail}</td><td className="text-ink-3">{d.Unavailable}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 space-y-1 text-[11px]">
            <div className="text-[10px] font-semibold text-ink-3">Whole detector · reported by pipeline</div>
            <p><span data-testid="dash-sat" className="font-mono text-ink">{satRows.length}</span> <span className="text-ink-2">of {satKnown.length} loaded observations report SATSTRKS &gt; 0</span>
              {ok.length > satKnown.length && <span className="text-ink-3"> ({ok.length - satKnown.length} unavailable)</span>}</p>
            <div className="text-[10px] font-semibold text-ink-3">Displayed field · from FITS FLAGS</div>
            <p><span data-testid="dash-field-streak" className="font-mono text-ink">{fieldPos.length}</span> <span className="text-ink-2">of {fieldKnown.length} have STREAK-flagged pixels in the displayed field</span>
              {fieldPos.length > 0 && <span className="text-ink-3"> (max {Math.max(...fieldPos.map(r => r.fieldStreak!)).toLocaleString('en-US')} px in one frame)</span>}</p>
          </div>
          <div className="mt-2 text-[10px] font-semibold text-ink-3">Coverage distribution</div>
          <CoverageHistogram bins={covBins} />
          {lams.length > 0 && <p className="mt-1 text-[10px] text-ink-3">λ at target across loaded frames: <span className="font-mono text-ink-2">{Math.min(...lams).toFixed(3)}–{Math.max(...lams).toFixed(3)} µm</span> (linear-variable filter: varies per visit)</p>}
        </section>
      </div>

      {tip && (
        <div role="tooltip" data-testid="dash-tip" className="pointer-events-none absolute z-30 w-60 border border-line-strong bg-raised px-2.5 py-1.5 text-[11px]"
          style={{ left: Math.min(tip.x + 12, (wrapRef.current?.clientWidth ?? 600) - 250), top: tip.y + 12 }}>
          <div className="font-mono text-ink">{tip.r.date}</div>
          <div className="text-ink-3">{tip.r.obsid} · {tip.r.detector}{tip.r.lam != null ? ` · λ ${tip.r.lam.toFixed(3)} µm` : ''}</div>
          <div className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[10.5px]">
            <span className="font-sans text-ink-3">status</span><span>{tip.r.status}{tip.r.source ? ` (${tip.r.source})` : ''}</span>
            <span className="font-sans text-ink-3">coverage</span><span>{pct(tip.r.cov)}</span>
            <span className="font-sans text-ink-3">off-detector</span><span>{pct(tip.r.off)}</span>
            <span className="font-sans text-ink-3">masked (derived)</span><span>{pct(tip.r.maskDerived)}</span>
            <span className="font-sans text-ink-3">QA L1/L2</span><span>{tip.r.l1 ?? 'Unavailable'} / {tip.r.l2 ?? 'Unavailable'}</span>
            <span className="font-sans text-ink-3">SATSTRKS (det.)</span><span>{tip.r.sat ?? 'Unavailable'}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function Timeline({ rows, selectedKey, onPick, onHover, onLeave }: {
  rows: Row[]; selectedKey?: string; onPick: (r: Row) => void; onHover: (r: Row, e: React.MouseEvent) => void; onLeave: () => void
}) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const H = 150, padL = 44, padR = 12, padT = 14, padB = 22
  const timed = rows.filter(r => r.mjd != null)
  const t0 = Math.min(...timed.map(r => r.mjd!)), t1 = Math.max(...timed.map(r => r.mjd!))
  const lams = rows.map(r => r.lam).filter((v): v is number => v != null)
  const l0 = lams.length ? Math.min(...lams) : 0, l1 = lams.length ? Math.max(...lams) : 1
  const lp = (l1 - l0) * 0.12 || 0.05
  const X = (r: Row, i: number) => padL + (t1 > t0 && r.mjd != null ? (r.mjd - t0) / (t1 - t0) : i / Math.max(1, rows.length - 1)) * (w - padL - padR)
  const Y = (lam: number | null) => (lam == null ? H - padB - 4 : padT + (1 - (lam - (l0 - lp)) / ((l1 + lp) - (l0 - lp))) * (H - padT - padB - 10))
  const months: { x: number; label: string }[] = []
  if (t1 > t0) {
    const d = new Date((t0 - 40587) * 864e5), m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
    while ((m.getTime() / 864e5 + 40587) <= t1) { months.push({ x: padL + ((m.getTime() / 864e5 + 40587 - t0) / (t1 - t0)) * (w - padL - padR), label: m.toISOString().slice(0, 7) }); m.setUTCMonth(m.getUTCMonth() + 1) }
  }
  const every = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(w / 90))))
  return (
    <section aria-label="Observation timeline" className="border border-line bg-panel px-3 py-2.5">
      <h3 className="mb-1 flex flex-wrap items-center gap-x-3 text-[11px] font-semibold text-ink-2">
        Observation timeline <span className="font-normal text-ink-3">x: date · y: wavelength at target</span>
        <span className="ml-auto flex flex-wrap items-center gap-x-3 font-normal text-ink-3">
          <span className="inline-flex items-center gap-1"><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" className="fill-accent stroke-accent" /></svg>QA Pass</span>
          <span className="inline-flex items-center gap-1"><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" className="fill-transparent stroke-warn" strokeWidth="1.5" /></svg>QA Fail</span>
          <span className="inline-flex items-center gap-1"><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="3.5" className="fill-transparent stroke-ink-3" strokeDasharray="2 1.5" /></svg>Unavailable / not loaded</span>
          <span className="inline-flex items-center gap-1"><svg width="10" height="10" aria-hidden><path d="M5 1 L9 8 L1 8 Z" className="fill-warn" /></svg>pipeline-reported streak (detector-wide)</span>
        </span>
      </h3>
      <div ref={ref}>
        <svg width={w} height={H} className="block" role="group" aria-label="Observations over time; select one to show it in the viewer">
          {months.map((m, k) => (
            <g key={m.label}>
              <line x1={m.x} x2={m.x} y1={padT - 6} y2={H - padB} className="stroke-raised" />
              {k % every === 0 && <text x={m.x + 3} y={H - 6} className="fill-ink-3 font-mono text-[9px]">{m.label}</text>}
            </g>
          ))}
          {lams.length > 0 && [l0, (l0 + l1) / 2, l1].map((v, k) => (
            <g key={k}><line x1={padL - 4} x2={w - padR} y1={Y(v)} y2={Y(v)} className="stroke-raised" strokeDasharray="2 3" />
              <text x={padL - 6} y={Y(v) + 3} textAnchor="end" className="fill-ink-3 font-mono text-[9px]">{v.toFixed(2)}</text></g>
          ))}
          <text x={4} y={padT - 4} className="fill-ink-3 text-[9px]">λ µm</text>
          {rows.map((r, i) => {
            const cx = X(r, i), cy = Y(r.lam), sel = r.key != null && r.key === selectedKey
            const style = r.status !== 'ok' ? (r.status === 'error' ? 'fill-transparent stroke-warn' : 'fill-transparent stroke-ink-3') : QA_STYLE[r.qa]
            return (
              <g key={r.id} data-testid="dash-point" data-key={r.key ?? ''} data-qa={r.status === 'ok' ? r.qa : r.status}
                className={r.key ? 'cursor-pointer' : ''} onClick={() => onPick(r)} onMouseMove={e => onHover(r, e)} onMouseLeave={onLeave}
                role={r.key ? 'button' : undefined} aria-label={r.key ? `Select observation ${r.date}` : undefined} tabIndex={r.key ? 0 : -1}
                onKeyDown={e => { if (r.key && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); onPick(r) } }}>
                <circle cx={cx} cy={cy} r={12} className="fill-transparent" />
                {sel && <circle cx={cx} cy={cy} r={8} className="fill-transparent stroke-ink" strokeWidth={1.5} />}
                <circle cx={cx} cy={cy} r={4.5} className={style} strokeWidth={1.5}
                  strokeDasharray={r.status === 'ok' && r.qa !== 'Unavailable' ? undefined : '2 1.5'} />
                {(r.sat ?? 0) > 0 && <path data-testid="dash-streak-mark" d={`M${cx} ${cy - 13} L${cx + 4} ${cy - 7} L${cx - 4} ${cy - 7} Z`} className="fill-warn" />}
              </g>
            )
          })}
        </svg>
      </div>
    </section>
  )
}

function CoverageBars({ rows, selectedKey, onPick, onHover, onLeave }: {
  rows: Row[]; selectedKey?: string; onPick: (r: Row) => void; onHover: (r: Row, e: React.MouseEvent) => void; onLeave: () => void
}) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const H = 92, pad = 2, gap = 2
  const bw = Math.max(3, (w - pad * 2) / Math.max(1, rows.length) - gap)
  return (
    <div ref={ref}>
      <svg width={w} height={H + 14} className="block" role="group" aria-label="Coverage per observation">
        <defs>
          <pattern id="dash-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill="rgb(46,47,50)" /><line x1="0" y1="0" x2="0" y2="4" stroke="rgb(66,68,72)" strokeWidth="1.2" />
          </pattern>
        </defs>
        {[0.5, 1].map(v => <line key={v} x1={0} x2={w} y1={H - v * (H - 4)} y2={H - v * (H - 4)} className="stroke-raised" strokeDasharray={v === 1 ? undefined : '2 3'} />)}
        {rows.map((r, i) => {
          const x = pad + i * (bw + gap), sel = r.key != null && r.key === selectedKey
          if (r.status !== 'ok' || r.cov == null) {
            return <rect key={r.id} x={x} y={4} width={bw} height={H - 4} className={r.status === 'error' ? 'fill-transparent stroke-warn' : 'fill-transparent stroke-line-strong'} strokeDasharray="2 2" />
          }
          const seg = (f: number) => f * (H - 4)
          const hc = seg(r.cov), hm = seg(r.maskDerived ?? 0), ho = seg(r.off ?? 0)
          return (
            <g key={r.id} data-testid="dash-bar" data-key={r.key} data-cov={r.cov} className="cursor-pointer" onClick={() => onPick(r)} onMouseMove={e => onHover(r, e)} onMouseLeave={onLeave}>
              <rect x={x} y={H - hc} width={bw} height={hc} className={sel ? 'fill-accent' : 'fill-ink-2/60'} />
              <rect x={x} y={H - hc - hm} width={bw} height={hm} fill="rgb(118,120,124)" />
              <rect x={x} y={H - hc - hm - ho} width={bw} height={ho} fill="url(#dash-hatch)" />
            </g>
          )
        })}
        <text x={2} y={H + 11} className="fill-ink-3 font-mono text-[9px]">0%</text>
        <text x={w - 2} y={10} textAnchor="end" className="fill-ink-3 font-mono text-[9px]">100%</text>
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-ink-3">
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 bg-ink-2/60" aria-hidden />valid coverage</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5" style={{ background: 'rgb(118,120,124)' }} aria-hidden />masked/invalid (derived)</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5" style={{ background: 'repeating-linear-gradient(135deg, rgb(66,68,72) 0 1px, rgb(46,47,50) 1px 4px)' }} aria-hidden />off-detector</span>
        <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 border border-dashed border-line-strong" aria-hidden />not loaded</span>
      </div>
    </div>
  )
}

function CoverageHistogram({ bins }: { bins: number[] }) {
  const max = Math.max(1, ...bins)
  return (
    <div className="mt-1 grid grid-cols-10 items-end gap-0.5" style={{ height: 44 }} data-testid="dash-cov-hist">
      {bins.map((b, i) => (
        <div key={i} className="flex h-full flex-col justify-end" title={`${i * 10}–${i === 9 ? 100 : i * 10 + 10}% coverage: ${b} observation(s)`}>
          <div className="bg-ink-2/60" style={{ height: `${(b / max) * 100}%`, minHeight: b ? 2 : 0 }} />
          <div className="mt-0.5 text-center font-mono text-[8px] text-ink-3">{i * 10}</div>
        </div>
      ))}
    </div>
  )
}
