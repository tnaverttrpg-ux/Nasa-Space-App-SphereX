import { useEffect, useState } from 'react'
import { MousePointerClick, RotateCw, X } from 'lucide-react'
import { getJSON } from '../api'
import InfoTip from './InfoTip'

export interface PixelInfo {
  key: string; demo: boolean; unit: string; grid_size: [number, number]
  grid: { x: number; y: number; value: number | null; value_finite: boolean; state: 'valid' | 'masked_or_invalid' | 'off_detector' }
  sky: { ra: number; dec: number } | null
  native: { available: boolean; reason: string | null; x?: number; y?: number; ix?: number; iy?: number; value?: number | null; value_finite?: boolean
    flags?: number | null; flag_names?: string[] | null; masked_by_app?: boolean | null; flags_available?: boolean; cutout_shape?: [number, number] }
  detector: { x: number; y: number; on_detector: boolean; ix: number | null; iy: number | null; active_size: number } | null
}
export type PixelSel = { key: string; x: number; y: number; label: string }

// Results depend only on (grid key, pixel): keep them for the session; a re-click never re-requests.
const cache = new Map<string, PixelInfo>()
const STATE: Record<PixelInfo['grid']['state'], [string, string]> = {
  valid: ['Valid data', 'text-ink border-line-strong'],
  masked_or_invalid: ['Masked / invalid', 'text-ink border-[rgb(118,120,124)]'],
  off_detector: ['Off detector · not observed', 'text-ink-2 border-dashed border-line-strong'],
}
const BAD = new Set(['TRANSIENT', 'OVERFLOW', 'SUR_ERROR', 'NONFUNC', 'MISSING_DATA', 'HOT', 'COLD', 'PERSIST', 'OUTLIER'])  // = fitsproc.BAD_PLANES
const num = (v: number | null | undefined, d = 4) => (v == null ? '—' : Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : v.toFixed(d))

function Row({ k, v, id }: { k: React.ReactNode; v: React.ReactNode; id?: string }) {
  return <div className="flex justify-between gap-3 border-b border-raised py-[2px]"><dt className="text-ink-2">{k}</dt><dd data-testid={id} className="text-right font-mono text-ink">{v}</dd></div>
}
const Sub = ({ children }: { children: React.ReactNode }) => <div className="mt-2 text-[10px] font-semibold text-ink-3">{children}</div>

export default function PixelInspector({ sel, onClear }: { sel: PixelSel | null; onClear: () => void }) {
  const ck = sel ? `${sel.key}|${sel.x}|${sel.y}` : ''
  const [data, setData] = useState<PixelInfo | null>(null)
  const [err, setErr] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setErr('')
    if (!sel) { setData(null); return }
    const hit = cache.get(ck)
    if (hit) { setData(hit); return }
    setData(null)
    const ctl = new AbortController()        // clicking elsewhere aborts this request (stale responses are dropped)
    getJSON<PixelInfo>(`frame/${sel.key}/pixel`, { x: sel.x, y: sel.y }, 30_000, ctl.signal)
      .then(d => { if (!ctl.signal.aborted) { cache.set(ck, d); setData(d) } })
      .catch(e => { if (!ctl.signal.aborted) setErr((e as Error).message) })
    return () => ctl.abort()
  }, [ck, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  const n = data?.native
  return (
    <section aria-label="Pixel inspector" className="border-b border-line px-3 py-3">
      <h2 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-ink-2">
        <span className="text-ink">Pixel inspector</span>
        <InfoTip label="Pixel inspector" align="start">
          Click the image to trace one aligned-grid pixel back to the sky, the original FITS pixel and the detector.
          Grid values are interpolated; native values are the original IMAGE pixel. FLAGS are per-pixel quality bits, not the header Pipeline QA.
        </InfoTip>
        {sel && <button onClick={onClear} className="ml-auto inline-flex items-center gap-1 font-normal text-ink-3 hover:text-ink" aria-label="Clear pixel selection"><X size={12} aria-hidden />Clear</button>}
      </h2>

      {!sel ? (
        <p data-testid="pixel-empty" className="flex items-center gap-1.5 text-[11px] text-ink-3"><MousePointerClick size={13} aria-hidden />Click a pixel on the image to inspect it.</p>
      ) : err ? (
        <p role="alert" className="text-[11px] text-warn">Pixel lookup failed: {err}{' '}
          <button className="inline-flex items-center gap-1 underline" onClick={() => setAttempt(a => a + 1)}><RotateCw size={11} aria-hidden />Retry</button></p>
      ) : !data ? (
        <div data-testid="pixel-loading" aria-busy="true" className="h-24 animate-pulse rounded-sm bg-raised" />
      ) : (
        <div data-testid="pixel-result" className="text-[11px]">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span data-testid="pixel-state" className={`rounded-sm border px-1.5 py-[1px] text-[10px] font-semibold ${STATE[data.grid.state][1]}`}>{STATE[data.grid.state][0]}</span>
            <span className="truncate text-[10px] text-ink-3">{sel.label}</span>
          </div>
          <dl>
            <Row k="RA, Dec (deg)" id="pixel-sky" v={data.sky ? `${data.sky.ra.toFixed(6)}, ${data.sky.dec >= 0 ? '+' : '−'}${Math.abs(data.sky.dec).toFixed(6)}` : 'n/a (synthetic)'} />
          </dl>

          <Sub>Aligned grid · interpolated · north up</Sub>
          <dl>
            <Row k="Grid x, y" id="pixel-grid" v={`${data.grid.x}, ${data.grid.y}`} />
            <Row k={`Value (${data.unit})`} id="pixel-grid-value" v={data.grid.value_finite ? num(data.grid.value) : <span className="text-ink-3">no value</span>} />
          </dl>

          <Sub>Original FITS pixel · native</Sub>
          {n?.available ? (
            <dl>
              <Row k="Native x, y" id="pixel-native" v={<>{n.ix}, {n.iy} <span className="text-ink-3">({num(n.x, 2)}, {num(n.y, 2)})</span></>} />
              <Row k={`Value (${data.unit})`} id="pixel-native-value" v={n.value_finite ? num(n.value) : <span className="text-ink-3">non-finite in file</span>} />
              <Row k="FLAGS" id="pixel-flags" v={n.flags_available ? `0x${(n.flags ?? 0).toString(16).toUpperCase()}` : <span className="text-ink-3">no FLAGS extension</span>} />
              {n.flag_names && n.flag_names.length > 0 && (
                <div className="flex flex-wrap gap-1 py-1" data-testid="pixel-flag-names">
                  {n.flag_names.map(f => <span key={f} className={`rounded-sm border px-1 font-mono text-[10px] ${BAD.has(f) ? 'border-warn text-warn' : 'border-line-strong text-ink-2'}`} title={BAD.has(f) ? 'masked by SPHERE TRACK' : 'informational, not masked'}>{f}</span>)}
                </div>
              )}
              {n.masked_by_app != null && <p className="text-[10px] text-ink-3">{n.masked_by_app ? 'This native pixel is masked by SPHERE TRACK (flag in the masked set).' : 'No masking flag set on this native pixel.'}</p>}
            </dl>
          ) : (
            <p data-testid="pixel-native-unavailable" className="text-[11px] text-ink-3">{n?.reason ?? 'Unavailable'}</p>
          )}

          <Sub>Detector · 0-based active pixels</Sub>
          {data.detector ? (
            <dl>
              <Row k="Detector x, y" id="pixel-detector" v={data.detector.on_detector ? <>{data.detector.ix}, {data.detector.iy} <span className="text-ink-3">({num(data.detector.x, 2)}, {num(data.detector.y, 2)})</span></>
                : <span className="text-ink-2">outside ({num(data.detector.x, 1)}, {num(data.detector.y, 1)})</span>} />
            </dl>
          ) : <p className="text-[11px] text-ink-3">Unavailable{data.demo ? ' (synthetic)' : n?.available === false ? '' : ' (no detector WCS in header)'}</p>}
          <p className="mt-1.5 text-[10px] leading-snug text-ink-3">Values are surface brightness, not calibrated photometry. Per-pixel FITS FLAGS are separate from the header Pipeline QA.</p>
        </div>
      )}
    </section>
  )
}
