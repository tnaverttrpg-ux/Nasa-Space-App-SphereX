// Sky map coverage analysis: overlap inspector, density shading, minimap, isolation, filters, click modes.
// Every scientific check is made against an INDEPENDENT implementation (inverse gnomonic + spherical containment).
// Prerequisites and env: see lib.mjs. Run: npm run test:e2e -- coverage
import { chromium } from 'playwright-core'
import { APP, LAUNCH, ORIGIN, OUT, report } from './lib.mjs'
const B = ORIGIN, RA = 269.44629, DEC = 4.767917
const PAGE = `${APP}?ra=${RA}&dec=${DEC}&fov=0.1&band=D6&n=12`
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
const loaded = p => p.waitForFunction(() => /Loaded \d+\/\d+ frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 300000 })
// The map is display:none until its tab opens; it then measures itself and re-renders once with its real size.
// Wait for that (viewBox aspect = rendered aspect), so geometry a test reads cannot change before its click lands.
const mapSettled = p => p.waitForFunction(() => {
  const e = document.querySelector('[data-testid="map-svg"]'), r = e?.getBoundingClientRect(), vb = e?.getAttribute('viewBox').split(' ').map(Number)
  return !!r && r.width > 0 && Math.abs(vb[2] / vb[3] - r.width / r.height) < 1e-3
}, null, { timeout: 10000 })
const toMap = async p => { await p.getByRole('tab', { name: 'Sky map' }).click(); await p.getByTestId('skymap').waitFor({ timeout: 10000 }); await mapSettled(p) }
const insp = async p => (await p.locator('dt', { hasText: 'Observation ID' }).locator('xpath=following-sibling::dd').innerText()).trim()
const D2R = Math.PI / 180
// independent inverse gnomonic (screen plane x = -ξ, y = -η, degrees) — textbook form, not the app's code
const unproj = (ra0, dec0, x, y) => { const xi = -x * D2R, eta = -y * D2R, d0 = dec0 * D2R
  const dec = Math.atan((Math.sin(d0) + eta * Math.cos(d0)) / Math.sqrt(xi * xi + (Math.cos(d0) - eta * Math.sin(d0)) ** 2))
  const ra = ra0 * D2R + Math.atan2(xi, Math.cos(d0) - eta * Math.sin(d0)); return [((ra / D2R) % 360 + 360) % 360, dec / D2R] }
// independent spherical containment for convex polygons with great-circle edges (all SPHEREx footprints are quads)
const vec = (ra, dec) => [Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)]
const cross = (a, b2) => [a[1] * b2[2] - a[2] * b2[1], a[2] * b2[0] - a[0] * b2[2], a[0] * b2[1] - a[1] * b2[0]]
const dot = (a, b2) => a[0] * b2[0] + a[1] * b2[1] + a[2] * b2[2]
const sphContains = (verts, ra, dec) => { const p = vec(ra, dec), v = verts.map(([r, d]) => vec(r, d))
  const s = v.map((vi, i) => Math.sign(dot(cross(vi, v[(i + 1) % v.length]), p))); return s.every(x => x === s[0]) && s[0] !== 0 }
const vbOf = async p => p.getByTestId('map-svg').evaluate(e => e.getAttribute('viewBox').split(' ').map(Number))
const clickPlane = async (p, [x, y]) => { const r = await p.getByTestId('map-svg').boundingBox(), vb = await vbOf(p)
  await p.mouse.click(r.x + ((x - vb[0]) / vb[2]) * r.width, r.y + ((y - vb[1]) / vb[3]) * r.height) }
const probe = async p => p.getByTestId('probe-coords').evaluate(e => [+e.dataset.ra, +e.dataset.dec])

{ // ---- unit checks on the live module: inversion + containment + scanline coverage
  const p = await b.newPage(); await p.goto(APP)
  await check('unit: screen→sky inversion round-trips (incl. RA 0/360 and high Dec)', async () => {
    const r = await p.evaluate(async () => { const s = await import('/src/sky.ts'); const out = []
      for (const [ra0, dec0] of [[269.4, 4.8], [0.2, 20], [359.9, -35], [120, 82]]) for (const [x, y] of [[0, 0], [1.3, -0.7], [-2.2, 1.9], [0.01, 3.1]]) {
        const [ra, dec] = s.screenToSky(ra0, dec0, [x, y]), back = s.toScreen(s.tanProject(ra0, dec0, ra, dec)); out.push([ra0, dec0, x, y, ra, dec, back]) }
      return out })
    let worst = 0
    for (const [ra0, dec0, x, y, ra, dec, back] of r) { const [er, ed] = unproj(ra0, dec0, x, y)
      worst = Math.max(worst, Math.abs(back[0] - x), Math.abs(back[1] - y), Math.abs(((ra - er + 540) % 360) - 180), Math.abs(dec - ed)) }
    if (worst > 1e-9) throw new Error('max error ' + worst); return `${r.length} points, max error ${worst.toExponential(1)}°`
  })
  await check('unit: coverageRuns matches brute-force point counts; density classes 1/2–5/6–10/11–20/21+', async () => {
    const r = await p.evaluate(async () => { const s = await import('/src/sky.ts'); let bad = 0, n = 0
      const polys = Array.from({ length: 25 }, (_, i) => [[i * 0.1, 0], [i * 0.1 + 1, 0.1 * (i % 3)], [i * 0.1 + 1.2, 1], [i * 0.1 + 0.1, 1.1]])
      for (let y = 0.013; y < 1.1; y += 0.047) { const runs = s.coverageRuns(polys, y, -1, 5)
        for (let x = -0.97; x < 5; x += 0.0131) { n++; const want = polys.filter(q => s.contains(q, [x, y])).length
          const got = runs.find(([a, b2]) => a <= x && x < b2)?.[2] ?? 0; if (want !== got) bad++ } }
      return { bad, n, bins: [0, 1, 2, 5, 6, 10, 11, 20, 21, 41].map(s.densityBin) } })
    if (r.bad || r.bins.join() !== '-1,0,1,1,2,2,3,3,4,4') throw new Error(JSON.stringify(r)); return `${r.n} points agree; bins ${r.bins.join(',')}`
  })
  await p.close() }

for (const scheme of ['dark', 'light']) {
  const T = `[${scheme}]`
  const p = await (await b.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 1000 } })).newPage()
  await p.goto(PAGE); await loaded(p); await toMap(p)
  const api = await (await p.request.get(`${B}/api/observations?ra=${RA}&dec=${DEC}&band=D6&limit=12&fov=0.1&include_all=true`)).json()
  const valid = api.all_observations.filter(o => o.footprint?.status === 'ok')
  const expectAt = (ra, dec) => valid.filter(o => sphContains(o.footprint.vertices, ra, dec)).map(o => o.obs_id).sort()

  await check(`${T} click-to-inspect: clicked pixel → RA/Dec matches independent inverse projection`, async () => {
    const pt = [0.83, -0.41]; await clickPlane(p, pt)
    const got = await probe(p), vb = await vbOf(p), r = await p.getByTestId('map-svg').boundingBox()
    // the click lands on a whole pixel: recover its plane position the same way and project independently
    const px = Math.round(((pt[0] - vb[0]) / vb[2]) * r.width) , py = Math.round(((pt[1] - vb[1]) / vb[3]) * r.height)
    const want = unproj(RA, DEC, vb[0] + (px / r.width) * vb[2], vb[1] + (py / r.height) * vb[3]), tol = vb[2] / r.width * 1.5
    if (Math.abs(got[0] - want[0]) * Math.cos(got[1] * D2R) > tol || Math.abs(got[1] - want[1]) > tol) throw new Error(`${got} vs ${want}`)
    return `RA ${got[0].toFixed(5)} Dec ${got[1].toFixed(5)} (within one screen pixel = ${(tol * 3600).toFixed(0)}″)`
  })
  await check(`${T} inspector list = independent spherical containment (multi-overlap point)`, async () => {
    const [ra, dec] = await probe(p), want = expectAt(ra, dec)
    const got = (await p.getByTestId('probe-row').evaluateAll(es => es.map(e => e.querySelector('[role=cell]').textContent))).sort()
    const cnt = +(await p.getByTestId('probe-count').innerText())
    if (got.join() !== want.join() || cnt !== want.length || want.length < 2) throw new Error(`${cnt}: ${got.length} vs ${want.length}`)
    return `${cnt} footprints contain RA ${ra.toFixed(3)} Dec ${dec.toFixed(3)} — identical set`
  })
  await check(`${T} inspecting the target lists all ${valid.length} valid footprints, with honest labels`, async () => {
    await clickPlane(p, [0.0004, 0.0004])
    const cnt = +(await p.getByTestId('probe-count').innerText()), txt = await p.getByTestId('probe-scope').innerText()
    if (cnt !== expectAt(...(await probe(p))).length || cnt !== valid.length || !/whole-detector/.test(await p.getByTestId('inspector').innerText()) || !/not show valid pixels or usable FITS data/.test(txt) || !/Searched 41 valid archive footprints/.test(txt)) throw new Error(`${cnt} ${txt}`)
    return txt.slice(0, 70) + '…'
  })
  await check(`${T} no-overlap location: 0 footprints, nothing invented`, async () => {
    await p.getByRole('button', { name: 'Fit all footprints' }).click()
    const vb = await vbOf(p), pt = [vb[0] + vb[2] * 0.03, vb[1] + vb[3] * 0.5]
    await clickPlane(p, pt)
    const [ra, dec] = await probe(p), cnt = +(await p.getByTestId('probe-count').innerText())
    if (cnt !== 0 || expectAt(ra, dec).length !== 0 || !(await p.getByTestId('probe-none').isVisible())) throw new Error(`count ${cnt}`)
    return `RA ${ra.toFixed(3)} Dec ${dec.toFixed(3)}: 0 (independent check 0)`
  })
  await check(`${T} sorting by date, detector and wavelength`, async () => {
    await clickPlane(p, [0.0004, 0.0004])
    const ids = async () => p.getByTestId('probe-row').evaluateAll(es => es.map(e => e.querySelector('[role=cell]').textContent))
    const byId = Object.fromEntries(valid.map(o => [o.obs_id, o]))
    const asc = await ids(); await p.getByRole('button', { name: 'Sort by Date (UTC)' }).click(); const desc = await ids()
    await p.getByRole('button', { name: 'Sort by λ (µm)' }).click(); const wv = (await ids()).map(i => (byId[i].em_min_um + byId[i].em_max_um) / 2)
    await p.getByRole('button', { name: 'Sort by Detector' }).click(); const det = (await ids()).map(i => byId[i].band)
    const mj = asc.map(i => byId[i].mjd_start)
    if (!mj.every((m, i) => !i || m >= mj[i - 1]) || desc.join() !== [...asc].reverse().join() || !wv.every((w, i) => !i || w >= wv[i - 1]) || !det.every((d, i) => !i || d >= det[i - 1])) throw new Error('order')
    await p.getByRole('button', { name: 'Sort by Date (UTC)' }).click()
    return `date ↑/↓, λ ${wv[0].toFixed(3)}→${wv.at(-1).toFixed(3)} µm, detector ${[...new Set(det)].join('/')}`
  })
  await check(`${T} inspector row selects a loaded observation in viewer + inspector`, async () => {
    const row = p.getByTestId('probe-row').filter({ has: p.getByRole('button', { name: /^Select / }) }).nth(2)
    const url = await row.getAttribute('data-url'), id = (await row.locator('[role=cell]').first().innerText()).trim()
    await row.getByTestId('probe-action').click()
    await p.waitForFunction(i => [...document.querySelectorAll('dt')].find(d => d.textContent.includes('Observation ID'))?.nextElementSibling?.textContent.trim() === i, id, { timeout: 10000 })
    const r2 = p.locator(`[data-testid="probe-row"][data-url="${url}"]`), act = r2.getByTestId('probe-action')
    if ((await r2.getAttribute('aria-current')) !== 'true' || (await act.innerText()) !== 'Selected' || !(await act.isDisabled())) throw new Error('row not marked'); return `${id} → "Selected"`
  })
  await check(`${T} filters: counts, loaded/unloaded/selected presentation; data untouched`, async () => {
    const c = async f => +(await p.getByTestId(`filter-${f}`).locator('span').innerText())
    const all = await c('all'), ld = await c('loaded'), ul = await c('unloaded'), se = await c('selected'), rows0 = await p.getByTestId('map-row').count()
    const st = async () => p.getByTestId('footprint').evaluateAll(es => es.map(e => e.dataset.status))
    await p.getByTestId('filter-loaded').click(); const L = await st()
    await p.getByTestId('filter-unloaded').click(); const U = await st()
    await p.getByTestId('filter-selected').click(); const S = await p.getByTestId('footprint').evaluateAll(es => es.map(e => e.getAttribute('class')))
    const rows1 = await p.getByTestId('map-row').count()
    await p.getByTestId('scope-visible').click(); const vis = +(await p.getByTestId('probe-count').innerText()); await p.getByTestId('scope-all').click()
    const allCnt = +(await p.getByTestId('probe-count').innerText())
    await p.getByTestId('filter-all').click()
    if (all !== valid.length || ld + ul !== all || L.length !== ld || !L.every(s => s === 'ok') || U.length !== ul || U.some(s => s === 'ok') || se !== 1 || S.length !== 1 || !/stroke-accent/.test(S[0]) || rows1 !== rows0 || vis !== 1 || allCnt !== all)
      throw new Error(JSON.stringify({ all, ld, ul, se, L: L.length, U: U.length, S, rows0, rows1, vis, allCnt }))
    return `all ${all} = loaded ${ld} + unloaded ${ul}; selected ${se}; list kept ${rows1} rows; inspector at target: all-scope ${allCnt}, visible-scope ${vis}`
  })
  await check(`${T} isolate fades others, keeps target + displayed field; Show all restores`, async () => {
    const n0 = await p.getByTestId('footprint').count()
    await p.getByRole('button', { name: 'Isolate selected observation' }).click(); await p.waitForTimeout(300)   // 200 ms fade
    const op = await p.getByTestId('footprint').evaluateAll(es => es.map(e => [e.getAttribute('class').includes('stroke-accent') && !e.getAttribute('class').includes('stroke-accent-ink'), +getComputedStyle(e).opacity]))
    const tgt = await p.getByTestId('target-marker').isVisible(), fld = await p.getByTestId('displayed-field').count()
    const sel = op.filter(([s]) => s), faded = op.filter(([s, o]) => !s && o < 0.3).length
    await p.getByRole('button', { name: 'Show all footprints' }).click(); await p.waitForTimeout(300)
    const after = await p.getByTestId('footprint').evaluateAll(es => es.every(e => +getComputedStyle(e).opacity === 1))
    if (op.length !== n0 || sel.length !== 1 || sel[0][1] !== 1 || faded !== n0 - 1 || !tgt || fld !== 1 || !after) throw new Error(JSON.stringify({ n0, sel, faded, tgt, fld, after }))
    return `${n0} kept: 1 prominent, ${faded} faded; Show all → all opaque`
  })
  await check(`${T} density shading agrees with exact counts away from edges; legend; toggle`, async () => {
    await p.getByRole('button', { name: 'Fit all footprints' }).click()
    const r = await p.evaluate(async () => { const s = await import('/src/sky.ts')
      const svg = document.querySelector('[data-testid="map-svg"]'), vb = svg.getAttribute('viewBox').split(' ').map(Number), k = vb[2] / svg.getBoundingClientRect().width
      const polys = [...document.querySelectorAll('[data-testid="footprint"]')].map(e => JSON.parse(e.dataset.points))
      const paths = [...document.querySelectorAll('[data-testid="density-bin"]')]
      const segD = (q, [x, y]) => Math.min(...q.map((a, i) => { const b2 = q[(i + 1) % q.length], dx = b2[0] - a[0], dy = b2[1] - a[1]
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) }))
      let ok = 0, nearEdge = 0, bad = 0
      for (let i = 0; i < 60; i++) for (let j = 0; j < 40; j++) {
        const pt = [vb[0] + (i + 0.37) / 60 * vb[2], vb[1] + (j + 0.61) / 40 * vb[3]], want = s.densityBin(polys.filter(q => s.contains(q, pt)).length)
        const got = paths.find(e => e.isPointInFill(new DOMPoint(...pt)))?.dataset.bin ?? '-1'
        if (+got === want) ok++; else if (Math.min(...polys.map(q => segD(q, pt))) < 2.5 * k) nearEdge++; else bad++ }
      return { ok, nearEdge, bad, ms: +document.querySelector('[data-testid="density"]').dataset.ms } })
    const legend = await p.getByTestId('density-legend').innerText()
    await p.getByTestId('skymap').getByRole('checkbox', { name: 'overlap density', exact: true }).uncheck()
    const off = await p.getByTestId('density').count(), fills = await p.getByTestId('footprint').first().getAttribute('class')
    await p.getByTestId('skymap').getByRole('checkbox', { name: 'overlap density', exact: true }).check()
    if (r.bad || !/1.*2–5.*6–10.*11–20.*21\+/s.test(legend) || off !== 0 || /fill-none/.test(fills)) throw new Error(JSON.stringify({ r, legend, off, fills }))
    return `${r.ok}/2400 grid points exact, ${r.nearEdge} within 2.5 px of an edge, 0 wrong; computed in ${r.ms.toFixed(1)} ms`
  })
  await check(`${T} minimap viewport tracks zoom and pan of the main map`, async () => {
    const same = async () => { const a = await vbOf(p), m = await p.getByTestId('minimap-viewport').evaluate(e => ['x', 'y', 'width', 'height'].map(k => +e.getAttribute(k)))
      return a.every((v, i) => Math.abs(v - m[i]) < 1e-9) }
    await p.getByRole('button', { name: 'Map zoom in' }).click(); await p.getByRole('button', { name: 'Map zoom in' }).click(); const z = await same()
    const r = await p.getByTestId('map-svg').boundingBox()
    await p.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.6); await p.mouse.down(); await p.mouse.move(r.x + r.width * 0.45, r.y + r.height * 0.5, { steps: 6 }); await p.mouse.up()
    const pan = await same(), lbl = await p.getByTestId('minimap-zoom').innerText()
    if (!z || !pan || !/×1\.6/.test(lbl)) throw new Error(JSON.stringify({ z, pan, lbl })); return `rect = main viewBox after zoom and pan; label "${lbl}"`
  })
  await check(`${T} minimap navigation: click jumps, drag moves the viewport, fit/centre buttons`, async () => {
    const svg = p.getByTestId('minimap-svg'), mb = await svg.boundingBox()
    const mvb = await svg.evaluate(e => e.getAttribute('viewBox').split(' ').map(Number))
    // click a minimap point outside the current viewport -> main view centres there
    await p.getByRole('button', { name: 'Reset to target' }).click()
    const sx = mb.x + mb.width * 0.15, sy = mb.y + mb.height * 0.2
    const want = await svg.evaluate((e, [x, y]) => { const q = new DOMPoint(x, y).matrixTransform(e.getScreenCTM().inverse()); return [q.x, q.y] }, [sx, sy])
    await p.mouse.click(sx, sy); const v1 = await vbOf(p), c1 = [v1[0] + v1[2] / 2, v1[1] + v1[3] / 2]
    // drag the viewport rectangle by a known minimap offset -> centre moves by the same plane distance
    const rb = await p.getByTestId('minimap-viewport').boundingBox(), sx0 = rb.x + rb.width / 2, sy0 = rb.y + rb.height / 2
    // expected plane offset of a +20,+10 px drag, from the minimap's own screen transform (it letterboxes: xMidYMid meet)
    const [d0, d1] = await svg.evaluate((e, pts) => pts.map(([x, y]) => { const q = new DOMPoint(x, y).matrixTransform(e.getScreenCTM().inverse()); return [q.x, q.y] }), [[sx0, sy0], [sx0 + 20, sy0 + 10]])
    const scale = (d1[0] - d0[0]) / 20
    await p.mouse.move(sx0, sy0); await p.mouse.down(); await p.mouse.move(sx0 + 20, sy0 + 10, { steps: 5 }); await p.mouse.up()
    const v2 = await vbOf(p), c2 = [v2[0] + v2[2] / 2, v2[1] + v2[3] / 2]
    void mvb
    await p.getByRole('button', { name: 'Minimap centre on target' }).click(); const v3 = await vbOf(p)
    await p.getByRole('button', { name: 'Minimap fit' }).click(); const v4 = await vbOf(p)
    const tolC = scale * 1.5
    if (Math.hypot(c1[0] - want[0], c1[1] - want[1]) > tolC || Math.abs(c2[0] - c1[0] - 20 * scale) > 2 * tolC || Math.abs(c2[1] - c1[1] - 10 * scale) > 2 * tolC
      || Math.abs(v3[0] + v3[2] / 2) > 1e-9 || !(v4[2] > v3[2])) throw new Error(JSON.stringify({ c1, want, c2, v3, v4 }))
    return `jump to (${want.map(x => x.toFixed(2))}); drag +20,+10 px → +${((c2[0] - c1[0]) / scale).toFixed(1)},+${((c2[1] - c1[1]) / scale).toFixed(1)} px; centre/fit ok`
  })
  await check(`${T} zoom (wheel at cursor) and pan`, async () => {
    const r = await p.getByTestId('map-svg').boundingBox(), v0 = await vbOf(p)
    await p.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await p.mouse.wheel(0, -300); await p.waitForTimeout(150); const v1 = await vbOf(p)
    await p.mouse.down(); await p.mouse.move(r.x + r.width / 2 - 100, r.y + r.height / 2, { steps: 5 }); await p.mouse.up(); const v2 = await vbOf(p)
    const shift = (v2[0] - v1[0]) / (v1[2] / r.width)
    if (!(v1[2] < v0[2]) || Math.abs(shift - 100) > 2) throw new Error(JSON.stringify({ v0, v1, v2, shift })); return `width ${v0[2].toFixed(2)}→${v1[2].toFixed(2)}°, drag 100 px → ${shift.toFixed(1)} px`
  })
  await p.getByRole('button', { name: 'Fit all footprints' }).click(); await clickPlane(p, [0.0004, 0.0004])
  await p.screenshot({ path: `${OUT}cov-${scheme}.png`, fullPage: true })
  await p.close()
}

{ // click modes: Inspect (default) never selects or downloads; Select keeps the original click-to-select behaviour
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } }); await p.goto(PAGE); await loaded(p); await toMap(p)
  await check('Inspect mode (default): clicks over unloaded footprints list them but never select or download', async () => {
    if ((await p.getByTestId('mode-inspect').getAttribute('aria-pressed')) !== 'true') throw new Error('Inspect is not the default')
    const before = await insp(p); let frames = 0
    p.on('request', r => { if (r.url().includes('/api/frame')) frames++ })
    await p.getByRole('button', { name: 'Fit all footprints' }).click()
    const polys = await p.getByTestId('footprint').evaluateAll(es => es.filter(e => e.dataset.status !== 'ok').map(e => JSON.parse(e.dataset.points)))
    for (const q of polys.slice(0, 5)) await clickPlane(p, [q.reduce((a, v) => a + v[0], 0) / q.length, q.reduce((a, v) => a + v[1], 0) / q.length])
    await p.waitForTimeout(1500)
    const unloaded = await p.getByTestId('probe-row').filter({ hasText: 'not loaded' }).count()
    if (frames !== 0 || (await insp(p)) !== before || (await p.getByTestId('map-loading').count()) || !unloaded) throw new Error(JSON.stringify({ frames, before, now: await insp(p), unloaded }))
    return `5 inspect clicks: 0 frame requests, selection still ${before}; ${unloaded} unloaded listed with "Load & select"`
  })
  await check('Select mode: click selects the topmost covering observation (original behaviour)', async () => {
    await p.getByTestId('mode-select').click()
    const poly = (await p.getByTestId('footprint').evaluateAll(es => es.filter(e => e.dataset.status === 'ok').map(e => JSON.parse(e.dataset.points))))[0]
    const cx = poly.reduce((a, q) => a + q[0], 0) / poly.length, cy = poly.reduce((a, q) => a + q[1], 0) / poly.length
    const pt = [poly[0][0] + (cx - poly[0][0]) * 0.06, poly[0][1] + (cy - poly[0][1]) * 0.06]
    const probeBefore = await p.getByTestId('probe-coords').evaluate(e => e.dataset.ra)
    await clickPlane(p, pt); await p.waitForTimeout(800)
    const covering = await p.evaluate(async ([pt]) => { const s = await import('/src/sky.ts'); return [...document.querySelectorAll('[data-testid="footprint"]')].filter(e => s.contains(JSON.parse(e.dataset.points), pt)).map(e => e.dataset.obs) }, [pt])
    const obs = await insp(p), probeAfter = await p.getByTestId('probe-coords').evaluate(e => e.dataset.ra)
    if (!covering.includes(obs) || probeAfter !== probeBefore) throw new Error(`${obs} not among ${covering} or probe moved`)
    await p.getByTestId('mode-inspect').click(); return `selected ${obs} (one of ${covering.length} there); the inspected point did not move`
  })
  await p.close() }

{ // unloaded observation chosen from the inspector -> existing loading path, then selected
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } }); await p.goto(PAGE); await loaded(p); await toMap(p)
  await check('inspector: picking an unloaded observation loads it via the normal path, then selects it', async () => {
    await clickPlane(p, [0.0004, 0.0004])
    const row = p.getByTestId('probe-row').filter({ hasText: 'not loaded' }).first(), id = (await row.locator('[role=cell]').first().innerText()).trim()
    const act = row.getByTestId('probe-action')
    if ((await act.innerText()) !== 'Load & select') throw new Error('action label: ' + await act.innerText())
    await act.click()
    await p.waitForFunction(i => [...document.querySelectorAll('dt')].find(d => d.textContent.includes('Observation ID'))?.nextElementSibling?.textContent.trim() === i, id, { timeout: 120000 })
    const st = await p.locator(`[data-testid="probe-row"][aria-current="true"]`).innerText()
    if (!st.includes(id) || !/loaded/.test(st) || /not loaded/.test(st)) throw new Error(st); return `${id} → loaded and selected`
  })
  await p.close() }

{ // missing / invalid footprints are excluded from inspector and density
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  await p.route('**/api/observations*', async r => { const res = await r.fetch(); const j = await res.json()
    j.all_observations[1].footprint = { status: 'missing', vertices: null, frame: null, reason: 'no s_region' }
    j.all_observations[2].footprint = { status: 'invalid', vertices: null, frame: null, reason: 'bad pairs' }
    j.all_observations[3].footprint = { status: 'unavailable', vertices: null, frame: null, reason: 'old cache' }
    await r.fulfill({ response: res, json: j }) })
  await p.route('**/api/frame?*', r => r.fulfill({ status: 504, json: { detail: 'not needed' } }))
  await p.goto(PAGE); await loaded(p); await toMap(p)
  await check('missing/invalid/unavailable footprints excluded from inspector, filters and density', async () => {
    await clickPlane(p, [0.0004, 0.0004])
    const cnt = +(await p.getByTestId('probe-count').innerText()), txt = await p.getByTestId('probe-scope').innerText()
    const all = +(await p.getByTestId('filter-all').locator('span').innerText())
    const topBin = await p.evaluate(() => [...document.querySelectorAll('[data-testid="density-bin"]')].find(e => e.isPointInFill(new DOMPoint(0.0004, 0.0004)))?.dataset.bin)
    if (cnt !== 38 || all !== 38 || !/Searched 38 valid archive footprints \(3 without valid geometry excluded\)/.test(txt) || topBin !== '4') throw new Error(JSON.stringify({ cnt, all, txt, topBin }))
    return `38 of 41 counted; "${txt.slice(0, 75)}…"`
  })
  await p.close() }

{ // RA wraparound on real data: inspector + independent containment
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  await p.route('**/api/frame?*', r => r.fulfill({ status: 504, json: { detail: 'not needed' } }))
  await p.goto(`${APP}?ra=0.15&dec=20&fov=0.1&band=D6&n=2`); await loaded(p); await toMap(p)
  await check('RA wraparound: inspecting across 0°/360° matches independent spherical containment', async () => {
    const api = await (await p.request.get(`${B}/api/observations?ra=0.15&dec=20&band=D6&limit=2&include_all=true`)).json()
    const valid = api.all_observations.filter(o => o.footprint?.status === 'ok'), out = []
    for (const pt of [[0.6, 0.2], [-0.6, -0.3], [0.0004, 0.0004]]) {    // x>0 is west of the target: RA < 0.15 → wraps to ~359.x
      await clickPlane(p, pt); const [ra, dec] = await probe(p)
      const want = valid.filter(o => sphContains(o.footprint.vertices, ra, dec)).length, got = +(await p.getByTestId('probe-count').innerText())
      if (want !== got) throw new Error(`RA ${ra} Dec ${dec}: ${got} vs ${want}`); out.push(`RA ${ra.toFixed(2)}→${got}`) }
    if (!out.some(s => /RA 359/.test(s))) throw new Error('no wrapped point ' + out); return out.join(', ')
  })
  await p.close() }

{ const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await p.goto(`${PAGE.replace('n=12', 'n=8')}`); await loaded(p); await p.evaluate(() => scrollTo(0, 0)); await toMap(p)
  await check('mobile 390 px: minimap inside the map, filters + inspector fit, no horizontal overflow', async () => {
    await p.getByTestId('map-svg').scrollIntoViewIfNeeded()
    const svg = await p.getByTestId('map-svg').boundingBox(); await p.mouse.click(svg.x + svg.width / 2, svg.y + svg.height * 0.55)
    await p.getByTestId('inspector').waitFor()
    const mm = await p.getByTestId('minimap').boundingBox(), f = await p.getByTestId('filter-selected').boundingBox()
    const o = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    await p.screenshot({ path: `${OUT}cov-mobile.png`, fullPage: true })
    if (o > 0 || mm.x < svg.x || mm.x + mm.width > svg.x + svg.width || mm.width > 130 || f.x + f.width > 390) throw new Error(JSON.stringify({ o, mm, f }))
    return `minimap ${Math.round(mm.width)}×${Math.round(mm.height)} inside ${Math.round(svg.width)} px map`
  })
  await check('mobile 390 px: inspector rows are two-line cards — ID, detector, date, λ, status and action visible, no sideways scroll', async () => {
    const r = await p.evaluate(() => {
      const t = document.querySelector('[role="table"][aria-label^="Footprints containing"]'), rows = [...t.querySelectorAll('[data-testid="probe-row"]')]
      const vis = e => { const q = e.getBoundingClientRect(); return q.width > 0 && q.left >= 0 && q.right <= innerWidth }
      return { scroll: t.scrollWidth - t.clientWidth, n: rows.length, allVisible: rows.every(row => [...row.querySelectorAll('[role="cell"]')].every(vis)),
        // visual lines = clusters of cell centres more than 8 px apart (the action button is taller than the text beside it)
        lines: rows.map(row => [...row.querySelectorAll('[role="cell"]')].map(c => { const q = c.getBoundingClientRect(); return (q.top + q.bottom) / 2 })
          .sort((a, b2) => a - b2).filter((y, i, a) => !i || y - a[i - 1] > 8).length),
        header: getComputedStyle(t.querySelector('[role="row"]:not([data-testid])')).display, sort: !!t.querySelector('[aria-label="Sort footprints"]')?.offsetParent,
        sample: rows[0]?.innerText.replace(/\s+/g, ' ') } })
    if (r.scroll > 0 || !r.n || !r.allVisible || r.lines.some(l => l !== 2) || r.header !== 'none' || !r.sort) throw new Error(JSON.stringify(r))
    return `${r.n} cards, each 2 lines, every cell on screen; e.g. "${r.sample}"`
  })
  await p.close() }
report(results)
await b.close()
