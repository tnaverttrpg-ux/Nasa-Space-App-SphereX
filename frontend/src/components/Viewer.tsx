import { useEffect, useMemo, useState } from 'react'
import { getJSON, pngUrl, type DiffResult, type FrameMeta, type GaiaSource } from '../api'
import SkyImage from './SkyImage'

export type Slot = { id: string; mjd: number | null; label: string; status: 'pending' | 'loading' | 'ok' | 'error'; meta?: FrameMeta; error?: string; exptime?: number }
type Mode = 'sequence' | 'side' | 'blink' | 'diff'

interface Props {
  slots: Slot[]
  demo: boolean
  gaia: GaiaSource[] | null
  onRetry: (id: string) => void
  onSelect: (m: FrameMeta) => void
  onDiff: (d: DiffResult | null) => void
}

const fmtDate = (m?: FrameMeta) => !m?.date_obs ? '—' : m.demo ? m.date_obs : m.date_obs.replace('T', ' ').slice(0, 19) + ' UTC'
const btn = 'rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-space-600 hover:bg-space-700 disabled:opacity-40'

export default function Viewer({ slots, demo, gaia, onRetry, onSelect, onDiff }: Props) {
  const ok = useMemo(() => slots.filter(s => s.status === 'ok' && s.meta).map(s => s.meta!), [slots])
  const [mode, setMode] = useState<Mode>('sequence')
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(2)
  const [stretch, setStretch] = useState('asinh')
  const [cmap, setCmap] = useState('inferno')
  const [aKey, setAKey] = useState('')
  const [bKey, setBKey] = useState('')
  const [blinkB, setBlinkB] = useState(false)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffErr, setDiffErr] = useState('')
  const [diffBusy, setDiffBusy] = useState(false)

  const idx = Math.min(i, Math.max(0, ok.length - 1))
  const cur = ok[idx]
  const A = ok.find(m => m.key === aKey) ?? ok[0]
  const B = ok.find(m => m.key === bKey) ?? ok[ok.length - 1]

  useEffect(() => { if (cur) onSelect(cur) }, [cur, onSelect])

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
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return
      if (e.key === 'ArrowRight') setI(v => Math.min(v + 1, ok.length - 1))
      if (e.key === 'ArrowLeft') setI(v => Math.max(v - 1, 0))
      if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ok.length])

  const runDiff = async () => {
    if (!A || !B || A.key === B.key) { setDiffErr('Choose two different frames.'); return }
    setDiffBusy(true); setDiffErr('')
    try {
      const d = await getJSON<DiffResult>('diff', { a: A.key, b: B.key }, 60_000)
      setDiff(d); onDiff(d)
    } catch (e) { setDiffErr((e as Error).message); setDiff(null); onDiff(null) }
    finally { setDiffBusy(false) }
  }
  useEffect(() => { if (mode === 'diff') runDiff() }, [mode, A?.key, B?.key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode !== 'diff') onDiff(null) }, [mode, onDiff])

  const badge = demo ? { text: 'SYNTHETIC DEMO · NOT SPHEREx', tone: 'amber' as const } : { text: 'MEASURED · SPHEREx', tone: 'cyan' as const }
  const img = (m: FrameMeta) => (
    <SkyImage src={pngUrl(m.key, stretch, cmap)} alt={`Frame ${fmtDate(m)}`} badge={badge}
      caption={`${fmtDate(m)}${m.wavelength_at_target ? ` · λ ${m.wavelength_at_target.center_um} µm` : ''}`}
      gaia={demo ? null : gaia} year={m.decimal_year} />
  )
  const pick = (label: string, val: string | undefined, set: (k: string) => void) => (
    <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-slate-400">
      <span className="font-semibold text-slate-300">{label}</span>
      <select value={val} onChange={e => set(e.target.value)} className="min-w-0 flex-1 rounded-md bg-space-800 px-2 py-1 text-slate-200 ring-1 ring-space-600">
        {ok.map(m => <option key={m.key} value={m.key}>{fmtDate(m)}</option>)}
      </select>
    </label>
  )

  // Timeline spans real time (MJD) so gaps between visits are visible.
  const mjds = slots.map(s => s.mjd).filter((x): x is number => x != null)
  const t0 = Math.min(...mjds), t1 = Math.max(...mjds)
  const pos = (s: Slot, k: number) => (s.mjd != null && t1 > t0 ? (s.mjd - t0) / (t1 - t0) : k / Math.max(1, slots.length - 1)) * 100

  return (
    <section className="rounded-2xl bg-space-900/80 p-3 ring-1 ring-space-700 backdrop-blur sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" className="flex rounded-lg bg-space-950 p-1 ring-1 ring-space-700">
          {([['sequence', 'Sequence'], ['side', 'Side-by-side'], ['blink', 'Blink'], ['diff', 'Difference']] as [Mode, string][]).map(([m, l]) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 text-sm ${mode === m ? 'bg-gradient-to-r from-cyan-glow/25 to-violet-glow/25 text-white ring-1 ring-cyan-glow/40' : 'text-slate-400 hover:text-slate-200'}`}>{l}</button>
          ))}
        </div>
        <div className="ml-auto flex gap-2 text-xs">
          <select aria-label="Stretch" value={stretch} onChange={e => setStretch(e.target.value)} className="rounded-md bg-space-800 px-2 py-1 ring-1 ring-space-600">
            <option value="asinh">asinh</option><option value="linear">linear</option>
          </select>
          <select aria-label="Colormap" value={cmap} onChange={e => setCmap(e.target.value)} className="rounded-md bg-space-800 px-2 py-1 ring-1 ring-space-600">
            {['inferno', 'magma', 'viridis', 'gray'].map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {ok.length === 0 ? (
        <div className="flex aspect-[4/3] items-center justify-center rounded-xl bg-space-950 text-sm text-slate-400 ring-1 ring-space-700">
          Waiting for the first frame…
        </div>
      ) : mode === 'sequence' ? (
        <div className="mx-auto max-w-[640px]">
          <div className="relative">
            {ok.map((m, k) => (
              <div key={m.key} className={k === idx ? '' : 'pointer-events-none absolute inset-0 opacity-0'} aria-hidden={k !== idx}>{img(m)}</div>
            ))}
          </div>
        </div>
      ) : mode === 'side' ? (
        <div>
          <div className="mb-2 flex flex-col gap-2 sm:flex-row">{pick('A', A?.key, setAKey)}{pick('B', B?.key, setBKey)}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{A && img(A)}{B && img(B)}</div>
        </div>
      ) : mode === 'blink' ? (
        <div>
          <div className="mb-2 flex flex-col gap-2 sm:flex-row">{pick('A', A?.key, setAKey)}{pick('B', B?.key, setBKey)}</div>
          <div className="relative mx-auto max-w-[640px]">
            {[A, B].map((m, k) => m && (
              <div key={k} className={(k === 1) === blinkB ? '' : 'pointer-events-none absolute inset-0 opacity-0'}>{img(m)}</div>
            ))}
            <span className="absolute right-3 top-2 rounded bg-space-950/80 px-2 py-0.5 font-mono text-sm text-white">{blinkB ? 'B' : 'A'}</span>
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-2 flex flex-col gap-2 sm:flex-row">{pick('A', A?.key, setAKey)}{pick('B', B?.key, setBKey)}</div>
          {diffBusy && <p className="py-10 text-center text-sm text-slate-400">Computing difference…</p>}
          {diffErr && <p className="py-4 text-center text-sm text-red-300">{diffErr} <button className="underline" onClick={runDiff}>Retry</button></p>}
          {diff && !diffBusy && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
              <SkyImage src={diff.png} alt="Difference image A minus B" badge={{ text: 'DERIVED · A − k·B', tone: 'violet' }}
                caption="red = brighter in A · blue = brighter in B" candidates={diff.candidates} />
              <div className="grid grid-cols-2 gap-2 self-start sm:grid-cols-1">{A && img(A)}{B && img(B)}</div>
            </div>
          )}
        </div>
      )}

      {/* playback */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className={btn} onClick={() => setI(Math.max(idx - 1, 0))} disabled={idx === 0} aria-label="Previous frame">◀ Prev</button>
        <button className={`${btn} min-w-20 bg-cyan-glow/15 text-cyan-glow`} onClick={() => setPlaying(p => !p)} disabled={ok.length < 2 || mode !== 'sequence'}>
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className={btn} onClick={() => setI(Math.min(idx + 1, ok.length - 1))} disabled={idx >= ok.length - 1} aria-label="Next frame">Next ▶</button>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Speed <input type="range" min={0.5} max={10} step={0.5} value={fps} onChange={e => setFps(+e.target.value)} className="w-24" />
          <span className="w-12 font-mono text-slate-300">{fps} fps</span>
        </label>
        <div className="ml-auto text-right">
          <div className="font-mono text-sm text-cyan-glow">{fmtDate(cur)}</div>
          <div className="text-xs text-slate-500">frame {ok.length ? idx + 1 : 0} / {ok.length}</div>
        </div>
      </div>

      {/* timeline */}
      <div className="relative mt-4 h-10 px-2">
        <div className="absolute inset-x-2 top-4 h-0.5 rounded bg-gradient-to-r from-cyan-glow/40 to-violet-glow/40" />
        <div className="absolute inset-x-2 inset-y-0">{slots.map((s, k) => {
          const okIdx = ok.findIndex(m => m.key === s.meta?.key)
          const color = s.status === 'ok' ? (okIdx === idx ? 'bg-cyan-glow ring-4 ring-cyan-glow/30' : 'bg-violet-glow') : s.status === 'error' ? 'bg-red-500' : 'animate-pulse bg-slate-500'
          return (
            <button key={s.id} title={s.status === 'error' ? `${s.label}: ${s.error} (click to retry)` : s.label}
              style={{ left: `${pos(s, k)}%` }}
              onClick={() => (s.status === 'error' ? onRetry(s.id) : okIdx >= 0 && setI(okIdx))}
              className={`absolute top-2.5 h-3.5 w-3.5 -translate-x-1/2 rounded-full ${color}`} aria-label={`${s.label} (${s.status})`} />
          )
        })}</div>
        {mjds.length > 0 && !demo && (
          <div className="absolute inset-x-2 top-7 flex justify-between font-mono text-[10px] text-slate-500">
            <span>MJD {t0.toFixed(1)}</span><span>MJD {t1.toFixed(1)}</span>
          </div>
        )}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        <span className="mr-1 inline-block h-2.5 w-2.5 align-middle" style={{ background: 'rgb(78,86,112)' }} />grey = masked pixels (saturated, hot, transient, … per FITS FLAGS) or no coverage.
        Each frame is scaled independently. Keys: ← → step · space play/pause. Red timeline dots failed — click to retry.
      </p>
    </section>
  )
}
