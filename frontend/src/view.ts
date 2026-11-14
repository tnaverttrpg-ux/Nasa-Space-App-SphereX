/** Shared, resolution-independent view of a square sky image.
 *  s = zoom (1 = whole image fits the box); x, y = offset of the image's top-left corner as a fraction of the box size.
 *  Because offsets are fractions, the same View shows the same sky region in boxes of any pixel size. */
export interface View { s: number; x: number; y: number }

export const FIT: View = { s: 1, x: 0, y: 0 }
export const MIN_ZOOM = 1
export const MAX_ZOOM = 24

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Keep zoom within limits and the image covering the box (no empty margins can be panned into view). */
export function clampView(v: View): View {
  const s = clampNum(Number.isFinite(v.s) ? v.s : 1, MIN_ZOOM, MAX_ZOOM)
  return { s, x: clampNum(Number.isFinite(v.x) ? v.x : 0, 1 - s, 0), y: clampNum(Number.isFinite(v.y) ? v.y : 0, 1 - s, 0) }
}

/** Zoom by `factor` keeping the image point under (u, v) (fractions of the box) fixed on screen. */
export function zoomAt(v: View, u: number, w: number, factor: number): View {
  const s2 = clampNum(v.s * factor, MIN_ZOOM, MAX_ZOOM)
  const cu = (u - v.x) / v.s, cw = (w - v.y) / v.s   // image coordinate (0..1) under the cursor
  return clampView({ s: s2, x: u - cu * s2, y: w - cw * s2 })
}

export const panBy = (v: View, dx: number, dy: number): View => clampView({ ...v, x: v.x + dx, y: v.y + dy })

export const sameView = (a: View, b: View) => a.s === b.s && a.x === b.x && a.y === b.y
