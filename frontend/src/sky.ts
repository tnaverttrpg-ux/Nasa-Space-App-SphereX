/** Sky geometry for the coverage map. Gnomonic (TAN) projection centred on the target: great circles (footprint
 *  edges) project to straight lines, and using sin/cos of ΔRA makes RA wrap-around at 0°/360° a non-issue. */

const D2R = Math.PI / 180

/** Standard gnomonic projection. Returns [ξ, η] in degrees (ξ toward +RA/east, η toward north), or null when the
 *  point lies 90° or more from the tangent point (it cannot be projected). */
export function tanProject(ra0: number, dec0: number, ra: number, dec: number): [number, number] | null {
  const d0 = dec0 * D2R, d = dec * D2R, da = (ra - ra0) * D2R
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da)
  if (!(cosc > 1e-9)) return null
  const xi = (Math.cos(d) * Math.sin(da)) / cosc
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc
  return [xi / D2R, eta / D2R]           // standard (ξ, η) tangent-plane coordinates, expressed in degrees
}

/** Inverse gnomonic: [ξ, η] in degrees -> [ra, dec] in degrees (ra in [0, 360)). */
export function tanUnproject(ra0: number, dec0: number, xiDeg: number, etaDeg: number): [number, number] {
  const xi = xiDeg * D2R, eta = etaDeg * D2R, d0 = dec0 * D2R
  const rho = Math.hypot(xi, eta), c = Math.atan(rho)
  if (rho === 0) return [((ra0 % 360) + 360) % 360, dec0]
  const dec = Math.asin(Math.cos(c) * Math.sin(d0) + (eta * Math.sin(c) * Math.cos(d0)) / rho)
  const ra = ra0 * D2R + Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c))
  return [(((ra / D2R) % 360) + 360) % 360, dec / D2R]
}

/** Screen-plane coordinates (degrees): x grows to the WEST (east is left, as on the sky), y grows to the SOUTH (north up). */
export const toScreen = ([xi, eta]: [number, number]): [number, number] => [-xi, -eta]

/** Signed area (screen coords, y down): > 0 means clockwise on screen. */
export const signedArea = (p: [number, number][]) => p.reduce((a, [x, y], i) => { const [x2, y2] = p[(i + 1) % p.length]; return a + (x * y2 - x2 * y) }, 0) / 2

/** Consistent winding (clockwise on screen) whatever order the archive listed the vertices in. */
export const normalizeWinding = (p: [number, number][]) => (signedArea(p) < 0 ? [...p].reverse() : p)

/** Sky position under a screen-plane point (inverse of toScreen + tanProject). */
export const screenToSky = (ra0: number, dec0: number, [x, y]: [number, number]) => tanUnproject(ra0, dec0, -x, -y)

/** Exact even-odd x-intervals where the horizontal line at height y lies inside polygon p (same crossing rule as contains). */
export function scanIntervals(p: [number, number][], y: number): [number, number][] {
  const xs: number[] = []
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j]
    if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi)
  }
  xs.sort((a, b) => a - b)
  const out: [number, number][] = []
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]])
  return out
}

/** Along the line at height y, between x0 and x1: runs [xa, xb, n] where exactly n polygons overlap (n > 0). */
export function coverageRuns(polys: [number, number][][], y: number, x0: number, x1: number): [number, number, number][] {
  const ev: [number, number][] = []
  for (const p of polys) for (const [a, b] of scanIntervals(p, y)) if (b > x0 && a < x1) ev.push([Math.max(a, x0), 1], [Math.min(b, x1), -1])
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const runs: [number, number, number][] = []
  let n = 0, prev = x0
  for (const [x, d] of ev) { if (n > 0 && x > prev) runs.push([prev, x, n]); n += d; prev = x }
  return runs
}

/** Overlap-density classes: 1, 2–5, 6–10, 11–20, 21+ footprints. Returns the class index, or -1 for none. */
export const DENSITY_LABELS = ['1', '2–5', '6–10', '11–20', '21+']
export const densityBin = (n: number) => (n <= 0 ? -1 : n === 1 ? 0 : n <= 5 ? 1 : n <= 10 ? 2 : n <= 20 ? 3 : 4)

/** Even-odd point-in-polygon test (screen coords). */
export function contains(p: [number, number][], [x, y]: [number, number]) {
  let inside = false
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
