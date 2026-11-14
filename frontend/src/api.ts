export interface Observation {
  obs_id: string; band: string; access_url: string; mjd_start: number; mjd_end: number
  exptime_s: number; em_min_um: number; em_max_um: number; collection: string
  cached?: 'grid' | 'cutout' | null   // present when /observations was called with fov
}
export type FrameSource = 'grid' | 'cutout-cache' | 'download' | 'shared-download'
export interface ObsResponse { total_in_band: number; band_counts: Record<string, number>; observations: Observation[] }
export interface FrameMeta {
  key: string; hdu?: string; date_obs: string | null; date_beg?: string; date_end?: string
  mjd: number | null; decimal_year: number | null; detector?: number; obsid?: string; bunit?: string
  native_pixscale_arcsec?: number; native_rotation_deg?: number; native_shape?: number[]
  wavelength_at_target: { center_um: number; width_um: number } | null
  flag_counts?: Record<string, number> | null; masked_pixels?: number; coverage_fraction: number
  off_detector_fraction?: number
  // From the pipeline's linear WCS 'A' (0-based active pixels); null when it cannot be derived exactly.
  detector_position?: { x: number; y: number; edge_px: number; active_size: number } | null
  // Verbatim FITS-header QA (null = absent/invalid) + STREAK-flagged native pixels inside the displayed field.
  pipeline_qa?: {
    l1_dqa: string | null; l2_dqa: string | null
    detector_streaks: number | null; detector_streak_pixels: number | null  // whole detector, as reported by the pipeline
    field_streak_pixels: number | null                                      // computed from FLAGS for this field
  }
  pipeline_version?: string; exptime_s?: number | null; source_url?: string; demo: boolean; note?: string
  timing?: { source: FrameSource; download_s?: number; attempts?: number; process_s?: number; total_s?: number }
}
export interface Candidate { x: number; y: number; ra: number; dec: number; snr: number; sign: string }
export interface DiffResult {
  png: string; noise_sigma: number; overlap_fraction: number; flux_scale_b_to_a: number
  registration_offset_px: [number, number] | null; candidates: Candidate[]; n_candidates_total: number
  display_scale_sigma?: number; detection_nsig?: number   // display contrast vs detection threshold (independent)
  wavelength_mismatch_um: number | null; demo: boolean
}
export interface GaiaSource { source_id: string; g: number; x: number; y: number; dx_per_yr: number; dy_per_yr: number; pmra: number; pmdec: number }
export interface Preset {
  id: string; label: string; why: string; ra?: number; dec?: number; coord_source?: string; error?: string
  resolved?: { simbad_id: string; ra_j2000: number; dec_j2000: number; pmra_masyr: number | null; pmdec_masyr: number | null } | null
}

export class ApiError extends Error {}

export async function getJSON<T>(path: string, params: Record<string, string | number> = {}, timeoutMs = 120_000, signal?: AbortSignal): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs)
  signal?.addEventListener('abort', () => ctl.abort('cancelled'))
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  try {
    const r = await fetch(`/api/${path}?${qs}`, { signal: ctl.signal })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      const d = body.detail
      throw new ApiError(typeof d === 'string' ? d : Array.isArray(d) ? d.map((x: { msg: string }) => x.msg).join('; ') : `HTTP ${r.status}`)
    }
    return body as T
  } catch (e) {
    if (ctl.signal.aborted) throw new ApiError(ctl.signal.reason === 'timeout' ? `Request timed out after ${timeoutMs / 1000}s` : 'cancelled')
    if (e instanceof ApiError) throw e
    throw new ApiError('Backend unreachable — is the API running on port 8000?')
  } finally {
    clearTimeout(timer)
  }
}

export const fmtDate = (m?: FrameMeta) => !m?.date_obs ? '—' : m.demo ? m.date_obs : m.date_obs.replace('T', ' ').slice(0, 19) + ' UTC'

export const pngUrl = (key: string, stretch: string, cmap: string) => `/api/frame/${key}.png?stretch=${stretch}&cmap=${cmap}`

export const BANDS: [string, string][] = [
  ['D1', '≈0.75–1.1 µm'], ['D2', '≈1.1–1.6 µm'], ['D3', '≈1.6–2.4 µm'],
  ['D4', '≈2.4–3.8 µm'], ['D5', '≈3.8–4.4 µm'], ['D6', '≈4.4–5.0 µm'],
]
