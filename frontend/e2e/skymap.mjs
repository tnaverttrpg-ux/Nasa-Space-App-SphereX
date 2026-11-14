// Sky coverage map: projection maths, real footprint geometry, wraparound, overlap, selection, loading, robustness.
import { chromium } from 'playwright-core'
import { LAUNCH, ORIGIN, OUT, report } from './lib.mjs'
const B = `${ORIGIN}`, RA = 269.44629, DEC = 4.767917
const PAGE = `${B}/?ra=${RA}&dec=${DEC}&fov=0.1&band=D6&n=12`
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
const loaded = p => p.waitForFunction(() => /Loaded \d+\/\d+ frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 300000 })
const toMap = async p => { await p.getByRole('tab', { name: 'Sky map' }).click(); await p.getByTestId('skymap').waitFor({ timeout: 10000 }) }
const insp = async p => (await p.locator('dt', { hasText: 'Observation ID' }).locator('xpath=following-sibling::dd').innerText()).trim()
const D2R = Math.PI / 180
// independent gnomonic implementation (screen plane: x = -ξ, y = -η)
const gno = (ra0, dec0, ra, dec) => { const d0 = dec0 * D2R, d = dec * D2R, da = (ra - ra0) * D2R
  const c = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da)
  return [-(Math.cos(d) * Math.sin(da) / c) / D2R, -((Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / c) / D2R] }
const samePts = (a, b2, tol = 1e-9) => a.length === b2.length && [...a].sort((p, q) => p[0] - q[0] || p[1] - q[1]).every((p, i) => { const q = [...b2].sort((m, n) => m[0] - n[0] || m[1] - n[1])[i]; return Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol })

{ // ---- projection maths on the live module
  const p = await b.newPage(); await p.goto(B)
  await check('projection: known points (target, 1° N, 1° E at Dec 0, poles), round trip', async () => {
    const r = await p.evaluate(async () => { const s = await import('/src/sky.ts')
      return { t: s.tanProject(120, 30, 120, 30), n: s.tanProject(10, 0, 10, 1), e: s.tanProject(10, 0, 11, 0), far: s.tanProject(0, 0, 90, 0), back: s.tanProject(0, 0, 180, 0),
        rt: s.tanUnproject(250, -40, ...s.tanProject(250, -40, 252.3, -41.7)) } })
    const want = 180 / Math.PI * Math.tan(Math.PI / 180)   // 1.000102 "degrees" in the tangent plane
    if (Math.hypot(...r.t) > 1e-12 || Math.abs(r.n[0]) > 1e-12 || Math.abs(r.n[1] - want) > 1e-9 || Math.abs(r.e[0] - want) > 1e-9 || Math.abs(r.e[1]) > 1e-12
      || r.far !== null || r.back !== null || Math.abs(r.rt[0] - 252.3) > 1e-9 || Math.abs(r.rt[1] + 41.7) > 1e-9) throw new Error(JSON.stringify(r))
    return `1° N → η=${r.n[1].toFixed(6)}; 1° E → ξ=${r.e[0].toFixed(6)}; 90°/180° away → null; round trip exact`
  })
  await check('projection: RA wraparound (359.5° ↔ 0.5°) and orientation normalisation', async () => {
    const r = await p.evaluate(async () => { const s = await import('/src/sky.ts')
      const sq = [[1, 1], [-1, 1], [-1, -1], [1, -1]]; const rev = [...sq].reverse()
      return { w: s.tanProject(359.5, 0, 0.5, 0), w2: s.tanProject(0.5, 0, 359.5, 0), a: s.normalizeWinding(sq), b: s.normalizeWinding(rev), sa: s.signedArea(s.normalizeWinding(rev)),
        inside: s.contains(sq, [0, 0]), outside: s.contains(sq, [2, 0]) } })
    const one = 180 / Math.PI * Math.tan(Math.PI / 180)
    if (Math.abs(r.w[0] - one) > 1e-9 || Math.abs(r.w2[0] + one) > 1e-9 || !(r.sa > 0) || !r.inside || r.outside) throw new Error(JSON.stringify(r))
    return `359.5→0.5 gives ξ=+${r.w[0].toFixed(4)} (not −359); both windings → clockwise`
  })
  await p.close() }

for (const scheme of ['dark', 'light']) {
  const T = `[${scheme}]`
  const p = await (await b.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 1000 } })).newPage()
  await p.goto(PAGE); await loaded(p); await toMap(p)
  const api = await (await p.request.get(`${B}/api/observations?ra=${RA}&dec=${DEC}&band=D6&limit=12&fov=0.1&include_all=true`)).json()
  await check(`${T} target marker at the projection centre with RA/Dec label`, async () => {
    const c = await p.getByTestId('target-marker').locator('circle').evaluate(e => [+e.getAttribute('cx'), +e.getAttribute('cy')])
    const lbl = await p.getByTestId('target-label').innerText()
    if (c[0] !== 0 || c[1] !== 0 || !lbl.includes(RA.toFixed(5)) || !lbl.includes(DEC.toFixed(5))) throw new Error(`${c} ${lbl}`); return lbl.replace(/\s+/g, ' ')
  })
  await check(`${T} every footprint = independent gnomonic projection of the archive polygon`, async () => {
    const polys = await p.getByTestId('footprint').evaluateAll(es => es.map(e => ({ url: e.dataset.url, pts: JSON.parse(e.dataset.points) })))
    let n = 0
    for (const o of api.all_observations) {
      const got = polys.find(q => q.url === o.access_url); if (!got) throw new Error('missing ' + o.obs_id)
      if (!samePts(got.pts, o.footprint.vertices.map(([r, d]) => gno(RA, DEC, r, d)))) throw new Error('geometry mismatch ' + o.obs_id); n++
    }
    const w = polys.map(q => Math.max(...q.pts.map(x => x[0])) - Math.min(...q.pts.map(x => x[0])))
    return `${n}/${api.all_observations.length} polygons match; widths ${Math.min(...w).toFixed(2)}–${Math.max(...w).toFixed(2)}° (whole detector)`
  })
  await check(`${T} displayed field drawn as the FOV square, distinct from detector footprints`, async () => {
    const r = await p.getByTestId('displayed-field').evaluate(e => ['x', 'y', 'width', 'height'].map(k => +e.getAttribute(k)))
    if (Math.abs(r[0] + 0.05) > 1e-12 || Math.abs(r[2] - 0.1) > 1e-12) throw new Error(r.join(',')); return `square ${r[2]}° at ±${-r[0]}°`
  })
  await check(`${T} overlap: hovering the target reports every covering footprint`, async () => {
    const svg = await p.getByTestId('map-svg').boundingBox(), vb = await p.getByTestId('map-svg').evaluate(e => e.getAttribute('viewBox').split(' ').map(Number))
    await p.mouse.move(svg.x + ((0 - vb[0]) / vb[2]) * svg.width + 2, svg.y + ((0 - vb[1]) / vb[3]) * svg.height + 2)
    const cnt = await p.getByTestId('map-tip-count').innerText()
    if (cnt !== String(api.all_observations.length)) throw new Error(`${cnt} vs ${api.all_observations.length}`); return `${cnt} footprints cover the target`
  })
  await check(`${T} click on the map selects the topmost covering observation in viewer + inspector`, async () => {
    // a point covered by few footprints: just inside a vertex of the first footprint
    const poly = (await p.getByTestId('footprint').evaluateAll(es => es.map(e => JSON.parse(e.dataset.points))))[0]
    const cx = poly.reduce((a, q) => a + q[0], 0) / poly.length, cy = poly.reduce((a, q) => a + q[1], 0) / poly.length
    const pt = [poly[0][0] + (cx - poly[0][0]) * 0.06, poly[0][1] + (cy - poly[0][1]) * 0.06]
    await p.getByRole('button', { name: 'Fit all footprints' }).click(); await p.getByTestId('mode-select').click()   // clicking selects only in Select mode
    const svg = await p.getByTestId('map-svg').boundingBox(), vb = await p.getByTestId('map-svg').evaluate(e => e.getAttribute('viewBox').split(' ').map(Number))
    await p.mouse.click(svg.x + ((pt[0] - vb[0]) / vb[2]) * svg.width, svg.y + ((pt[1] - vb[1]) / vb[3]) * svg.height)
    const covering = await p.evaluate(async ([pt]) => { const s = await import('/src/sky.ts'); return [...document.querySelectorAll('[data-testid="footprint"]')].filter(e => s.contains(JSON.parse(e.dataset.points), pt)).map(e => e.dataset.obs) }, [pt])
    await p.waitForTimeout(800)
    const obs = await insp(p)
    if (!covering.includes(obs)) throw new Error(`${obs} not among ${covering}`); return `selected ${obs} (one of ${covering.length} covering that point)`
  })
  await check(`${T} list selection of a loaded observation syncs viewer + highlighted footprint`, async () => {
    const o = api.observations[5]
    await p.locator(`[data-testid="map-row"][data-url="${o.access_url}"]`).click()
    await p.waitForFunction(id => [...document.querySelectorAll('dt')].find(d => d.textContent.includes('Observation ID'))?.nextElementSibling?.textContent.trim() === id, o.obs_id, { timeout: 10000 })
    const cls = await p.locator(`[data-testid="footprint"][data-url="${o.access_url}"]`).getAttribute('class')
    await p.getByRole('tab', { name: 'Viewer' }).click(); const d = await p.getByTestId('frame-date').innerText(); await toMap(p)
    if (!/stroke-accent/.test(cls)) throw new Error('not highlighted: ' + cls); return `${o.obs_id} → viewer ${d.slice(0, 16)}`
  })
  await check(`${T} map view and toggles survive switching workspaces`, async () => {
    await p.getByRole('button', { name: 'Map zoom in' }).click(); await p.getByRole('button', { name: 'Map zoom in' }).click()
    await p.getByTestId('skymap').getByRole('checkbox', { name: 'target', exact: true }).uncheck()
    const vb0 = await p.getByTestId('map-svg').getAttribute('viewBox')
    await p.getByRole('tab', { name: 'Dashboard' }).click(); await p.getByRole('tab', { name: 'Viewer' }).click(); await toMap(p)
    const vb1 = await p.getByTestId('map-svg').getAttribute('viewBox'), tgt = await p.getByTestId('target-marker').count()
    await p.getByTestId('skymap').getByRole('checkbox', { name: 'target', exact: true }).check()
    if (vb0 !== vb1 || tgt !== 0) throw new Error(`${vb0} vs ${vb1}, target ${tgt}`); return 'viewBox + toggle kept'
  })
  await check(`${T} controls: zoom, Fit all, Reset to target, hide footprints`, async () => {
    const w = async () => +(await p.getByTestId('map-svg').getAttribute('viewBox')).split(' ')[2]
    const w0 = await w(); await p.getByRole('button', { name: 'Map zoom out' }).click(); const w1 = await w()
    await p.getByRole('button', { name: 'Reset to target' }).click(); const vb = (await p.getByTestId('map-svg').getAttribute('viewBox')).split(' ').map(Number)
    const centred = Math.abs(vb[0] + vb[2] / 2) < 1e-9 && Math.abs(vb[1] + vb[3] / 2) < 1e-9
    await p.getByRole('button', { name: 'Fit all footprints' }).click(); const wf = await w()
    await p.getByTestId('skymap').getByRole('checkbox', { name: 'footprints', exact: true }).uncheck(); const hidden = await p.getByTestId('footprint').count(); await p.getByTestId('skymap').getByRole('checkbox', { name: 'footprints', exact: true }).check()
    if (!(w1 > w0) || !centred || !(wf > 3) || hidden !== 0) throw new Error(JSON.stringify({ w0, w1, centred, wf, hidden })); return `zoom ${w0.toFixed(2)}→${w1.toFixed(2)}°, target centred, fit ${wf.toFixed(2)}°`
  })
  await p.screenshot({ path: `${OUT}map-${scheme}.png` })
  await p.close()
}

{ // unloaded observation -> existing frame-loading path, then selected
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } }); await p.goto(PAGE); await loaded(p); await toMap(p)
  await check('clicking an unloaded observation loads it via the normal path, then selects it', async () => {
    const row = p.locator('[data-testid="map-row"]').filter({ hasText: 'not loaded' }).first()
    const url = await row.getAttribute('data-url'), obsText = await row.innerText()
    await row.click()
    // a frame cached by an earlier run loads in milliseconds, so the loading note may already be gone
    const sawLoading = await p.getByTestId('map-loading').waitFor({ timeout: 5000 }).then(() => true, () => false)
    const status = await p.locator('[role="status"]').first().innerText()
    await p.waitForFunction(u => document.querySelector(`[data-testid="footprint"][data-url="${u}"]`)?.getAttribute('class')?.includes('stroke-accent ') || document.querySelector(`[data-testid="footprint"][data-url="${u}"]`)?.getAttribute('class')?.endsWith('stroke-accent'), url, { timeout: 120000 })
    const id = await insp(p), loadedTxt = await p.locator('[role="status"]').first().innerText()
    if (!obsText.includes(id) || !/13 frames|\/13/.test(loadedTxt)) throw new Error(`${id} | ${loadedTxt}`)
    return `${id} loaded (loading note ${sawLoading ? 'seen' : 'too fast to see'}; status went "${status.replace(/\s+/g, ' ').slice(0, 40)}…" → "${loadedTxt.replace(/\s+/g, ' ').slice(0, 30)}")`
  })
  await p.close() }

{ // missing / malformed / reversed footprints via interception
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  let reversedUrl = null, firstPts = null
  await p.route('**/api/observations*', async r => {
    const res = await r.fetch(); const j = await res.json()
    const all = j.all_observations
    all[1].footprint = { status: 'missing', vertices: null, frame: null, reason: 'no s_region in the archive record' }
    all[2].footprint = { status: 'invalid', vertices: null, frame: null, reason: 'coordinates are not RA/Dec number pairs' }
    reversedUrl = all[3].access_url; firstPts = all[3].footprint.vertices; all[3].footprint = { ...all[3].footprint, vertices: [...all[3].footprint.vertices].reverse() }
    await r.fulfill({ response: res, json: j })
  })
  await p.route('**/api/frame?*', r => r.fulfill({ status: 504, json: { detail: 'not needed for this test' } }))
  await p.goto(PAGE); await loaded(p); await toMap(p)
  await check('missing and malformed footprints are listed, not drawn or invented', async () => {
    const note = await p.getByTestId('map-missing').innerText(), n = await p.getByTestId('footprint').count(), rows = await p.getByTestId('map-row').count()
    if (!/1 × missing/.test(note) || !/1 × invalid/.test(note) || n !== rows - 2) throw new Error(`${note} | ${n} polygons, ${rows} rows`); return `${n} drawn, ${rows} listed; ${note.slice(0, 90)}`
  })
  await check('reversed vertex order renders the same polygon (orientation normalised)', async () => {
    const pts = JSON.parse(await p.locator(`[data-testid="footprint"][data-url="${reversedUrl}"]`).getAttribute('data-points'))
    const area = pts.reduce((a, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return a + (x * y2 - x2 * y) }, 0)
    if (!samePts(pts, firstPts.map(([r, d]) => gno(RA, DEC, r, d))) || !(area > 0)) throw new Error('orientation/geometry'); return 'same vertices, clockwise on screen'
  })
  await p.close() }

{ // RA wraparound on real archive data (target near RA 0); frame downloads blocked, not needed for the map
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  await p.route('**/api/frame?*', r => r.fulfill({ status: 504, json: { detail: 'not needed' } }))
  await p.goto(`${B}/?ra=0.15&dec=20&fov=0.1&band=D6&n=2`); await loaded(p); await toMap(p)
  await check('real footprints straddling RA 0°/360° project as compact polygons around the target', async () => {
    const api = await (await p.request.get(`${B}/api/observations?ra=0.15&dec=20&band=D6&limit=2&include_all=true`)).json()
    const ras = api.all_observations.flatMap(o => o.footprint.vertices?.map(v => v[0]) ?? [])
    const straddle = ras.some(r => r > 350) && ras.some(r => r < 10)
    const polys = await p.getByTestId('footprint').evaluateAll(es => es.map(e => JSON.parse(e.dataset.points)))
    const widths = polys.map(q => Math.max(...q.map(x => x[0])) - Math.min(...q.map(x => x[0])))
    const inside = await p.evaluate(async () => { const s = await import('/src/sky.ts'); return [...document.querySelectorAll('[data-testid="footprint"]')].every(e => s.contains(JSON.parse(e.dataset.points), [0, 0])) })
    if (!straddle || !polys.length || Math.max(...widths) > 6 || !inside) throw new Error(JSON.stringify({ straddle, n: polys.length, maxW: Math.max(...widths), inside }))
    return `${polys.length} footprints; vertex RAs span ${Math.min(...ras).toFixed(1)}…${Math.max(...ras).toFixed(1)}°; max width ${Math.max(...widths).toFixed(2)}°; all contain the target`
  })
  await p.close() }

{ const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await p.goto(`${PAGE.replace('n=12', 'n=8')}`); await loaded(p); await p.evaluate(() => scrollTo(0, 0)); await toMap(p)
  await check('mobile 390 px: map fits, controls reachable, no horizontal overflow', async () => {
    const o = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), r = await p.getByTestId('map-svg').boundingBox()
    const vis = await p.getByRole('button', { name: 'Fit all footprints' }).isVisible()
    if (o > 0 || r.width > 390 || !vis) throw new Error(JSON.stringify({ o, w: r.width, vis })); return `svg ${Math.round(r.width)}×${Math.round(r.height)}`
  })
  await p.close() }
report(results)
await b.close()
