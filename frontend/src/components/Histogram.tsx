import { useEffect, useMemo, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { getJSON } from '../api'
import InfoTip from './InfoTip'

export interface FrameStats {
  key: string; quantity: string; unit: string; calibrated_photometry: false; demo: boolean
  n_grid: number; n_valid: number; n_off_detector: number; n_masked_or_invalid: number
  display_limits: { min: number; max: number } | null
  stats: { mean: number; median: number; robust_sigma: number; min: number; max: number; percentiles: Record<string, number> } | null
  histogram: { edges: number[]; counts: number[]; underflow: number; overflow: number } | null
}

// Grid keys are versioned and immutable, so a stats result never goes stale: keep it for the session.
const cache = new Map<string, FrameStats>()
const W = 300, H = 96
const fmt = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : v.toPrecision(3))
const PCTS = ['1', '5', '50', '95', '99', '99.7']

export default function Histogram({ frameKey }: { frameKey: string }) {
  const [data, setData] = useState<FrameStats | null>(() => cache.get(frameKey) ?? null)
  const [err, setErr] = useState('')
  const [hover, setHover] = useState<number | null>(null)
  const [logY, setLogY] = useState(true)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setHover(null)
    const hit = cache.get(frameKey)
    if (hit) { setData(hit); setErr(''); return }
    setData(null); setErr('')
    const ctl = new AbortController()
    getJSON<FrameStats>(`frame/${frameKey}/stats`, {}, 30_000, ctl.signal)
      .then(s => { if (ctl.signal.aborted) return; cache.set(frameKey, s); setData(s) })   // stale guard
      .catch(e => { if (!ctl.signal.aborted) setErr((e as Error).message) })
    return () => ctl.abort()
  }, [frameKey, attempt])

  const geo = useMemo(() => {
    const h = data?.histogram
    if (!h) return null
    const lo = h.edges[0], hi = h.edges[h.edges.length - 1]
    const x = (v: number) => ((v - lo) / (hi - lo)) * W
    const yv = (c: number) => (logY ? Math.log10(c + 1) : c)
    const top = Math.max(...h.counts.map(yv), 1e-9)
    return { h, lo, hi, x, bars: h.counts.map((c, i) => ({ x: x(h.edges[i]), w: Math.max(0.5, x(h.edges[i + 1]) - x(h.edges[i]) - 0.4), y: H - (yv(c) / top) * (H - 2), c })) }
  }, [data, logY])

  const s = data?.stats
  const dl = data?.display_limits
  const pctX = (v: number) => (geo ? `${Math.min(100, Math.max(0, ((v - geo.lo) / (geo.hi - geo.lo)) * 100))}%` : '0')

  return (
    <section aria-label="Intensity histogram" className="border-b border-line px-3 py-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-ink-2">
        <span className="text-ink">Intensity distribution</span>
        <span className="font-normal text-ink-3">· {data?.demo ? 'synthetic, arbitrary units' : `aligned grid, ${data?.unit ?? 'MJy/sr'}`}</span>
        <InfoTip label="Intensity distribution" align="start">
          Surface brightness of the aligned (reprojected) grid for this observation only. Masked, flagged and off-detector pixels are excluded; nothing is filled.
          These are interpolated grid values, not calibrated photometry. The shaded band is the display stretch range, not a measurement limit.
        </InfoTip>
      </h2>

      {err ? (
        <p role="alert" className="text-[11px] text-warn">Statistics unavailable: {err}{' '}
          <button className="inline-flex items-center gap-1 underline" onClick={() => setAttempt(a => a + 1)}><RotateCw size={11} aria-hidden />Retry</button>
        </p>
      ) : !data ? (
        <div data-testid="hist-loading" className="h-[96px] animate-pulse rounded-sm bg-raised" aria-busy="true" aria-label="Computing statistics" />
      ) : !geo || !s ? (
        <p data-testid="hist-empty" className="text-[11px] text-ink-3">No valid pixels in this field ({data.n_off_detector.toLocaleString('en-US')} off-detector, {data.n_masked_or_invalid.toLocaleString('en-US')} masked/invalid). Nothing to plot.</p>
      ) : (
        <>
          <div className="relative">
            <svg data-testid="hist-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[96px] w-full"
              role="img" aria-label={`Histogram of ${data.n_valid} valid pixels; median ${fmt(s.median)}, mean ${fmt(s.mean)} ${data.unit}`}
              onMouseLeave={() => setHover(null)}
              onMouseMove={e => {
                const r = e.currentTarget.getBoundingClientRect()
                const v = geo.lo + ((e.clientX - r.left) / r.width) * (geo.hi - geo.lo)
                const i = geo.h.edges.findIndex((edge, k) => k < geo.bars.length && v >= edge && v < geo.h.edges[k + 1])
                setHover(i >= 0 ? i : null)
              }}>
              {dl && <rect x={geo.x(dl.min)} y={0} width={Math.max(0, geo.x(dl.max) - geo.x(dl.min))} height={H} className="fill-accent/10" />}
              {geo.bars.map((b, i) => (
                <rect key={i} x={b.x} y={b.y} width={b.w} height={H - b.y} style={{ transition: 'y 200ms ease-out, height 200ms ease-out' }}
                  className={hover === i ? 'fill-accent' : 'fill-ink-2/55'} />
              ))}
              <line x1={geo.x(s.median)} x2={geo.x(s.median)} y1={0} y2={H} className="stroke-accent" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
              <line x1={geo.x(s.mean)} x2={geo.x(s.mean)} y1={0} y2={H} className="stroke-ink" strokeWidth={1} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
              <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-line" vectorEffect="non-scaling-stroke" />
            </svg>
            {dl && [dl.min, dl.max].map((v, i) => {
              // display limits beyond the plotted p0.5–p99 range are pinned to the edge and marked as such
              const beyond = v < geo.lo ? '◀' : v > geo.hi ? '▶' : '▲'
              return <span key={i} title={`display ${i ? 'max' : 'min'} ${fmt(v)}${beyond !== '▲' ? ' (outside plotted range)' : ''}`}
                className="pointer-events-none absolute -bottom-3.5 -translate-x-1/2 font-mono text-[9px] text-accent-ink" style={{ left: pctX(v) }}>{beyond}</span>
            })}
          </div>
          <div className="mt-3.5 flex justify-between font-mono text-[9px] text-ink-3">
            <span title="0.5th percentile of valid pixels">{fmt(geo.lo)}</span>
            <span data-testid="hist-hover" aria-live="polite" className="text-ink-2">
              {hover != null ? `[${fmt(geo.h.edges[hover])}, ${fmt(geo.h.edges[hover + 1])}) · ${geo.h.counts[hover].toLocaleString('en-US')} px (${((geo.h.counts[hover] / data.n_valid) * 100).toFixed(2)}%)` : 'hover a bin'}
            </span>
            <span title="99th percentile of valid pixels">{fmt(geo.hi)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-3">
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-0.5 bg-accent" aria-hidden />median</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-0 border-l border-dashed border-ink" aria-hidden />mean</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 bg-accent/15" aria-hidden />display stretch range</span>
            <label className="ml-auto inline-flex items-center gap-1"><input type="checkbox" checked={logY} onChange={e => setLogY(e.target.checked)} className="h-3 w-3" />log counts</label>
          </div>

          <dl className="mt-2 grid grid-cols-2 gap-x-3 font-mono text-[10.5px]">
            {([['N valid px', 'hist-n', data.n_valid.toLocaleString('en-US')], ['Median', 'hist-median', fmt(s.median)],
               ['Mean', 'hist-mean', fmt(s.mean)], ['Robust σ (MAD)', 'hist-sigma', fmt(s.robust_sigma)]] as const).map(([k, id, v]) => (
              <div key={k} className="flex justify-between border-b border-raised py-[2px]"><dt className="font-sans text-ink-2">{k}</dt><dd data-testid={id} className="text-ink">{v}</dd></div>
            ))}
          </dl>
          <div className="mt-1.5 grid grid-cols-6 text-center font-mono text-[9.5px]">
            {PCTS.map(p => <div key={p}><div className="text-ink-3">p{p}</div><div data-testid={`hist-p${p}`} className="text-ink">{fmt(s.percentiles[p])}</div></div>)}
          </div>
          <p className="mt-1.5 font-mono text-[9.5px] text-ink-3">
            display stretch {dl ? <span data-testid="hist-display">{fmt(dl.min)} … {fmt(dl.max)}</span> : 'n/a'} (render limits, not a measurement)
            {(geo.h.underflow > 0 || geo.h.overflow > 0) && <> · plotted p0.5–p99; outside: {geo.h.underflow} below, {geo.h.overflow} above</>}
            {data.n_off_detector + data.n_masked_or_invalid > 0 && <> · excluded {(data.n_off_detector + data.n_masked_or_invalid).toLocaleString('en-US')} px</>}
          </p>
        </>
      )}
    </section>
  )
}
