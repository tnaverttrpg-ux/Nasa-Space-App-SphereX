// Pixel inspector: exact screen→grid mapping under zoom/pan, modes, marker placement, states.
import { chromium } from 'playwright-core'
import { APP, LAUNCH, ORIGIN, OUT, report } from './lib.mjs'
const BASE = `${APP}?ra=269.44629&dec=4.767917&band=D6`
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
const loaded = p => p.waitForFunction(() => /Loaded \d+\/\d+ frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 300000 })
const settle = p => p.waitForTimeout(220)
const panel = p => p.getByRole('region', { name: 'Pixel inspector' })
// geometry of the n-th visible viewport: box, view (from the computed transform) and grid size
const geo = (p, i = 0) => p.evaluate(i => {
  const vps = [...document.querySelectorAll('[data-viewport]')].filter(el => el.getBoundingClientRect().width > 0 && !el.closest('.opacity-0') && !el.closest('.hidden'))
  const el = vps[i], r = el.getBoundingClientRect(), m = new DOMMatrixReadOnly(getComputedStyle(el.querySelector('[data-testid="view-layer"]')).transform)
  return { left: r.left, top: r.top, w: r.width, h: r.height, s: m.a, x: m.e / r.width, y: m.f / r.height, n: el.querySelector('[data-testid="view-layer"] img:not([aria-hidden])').naturalWidth }
}, i)
const screenOf = (g, gx, gy) => ({ x: g.left + (g.x + g.s * (gx + 0.5) / g.n) * g.w, y: g.top + (g.y + g.s * (gy + 0.5) / g.n) * g.h })
async function clickGrid(p, gx, gy, i = 0) { const g = await geo(p, i); const s = screenOf(g, gx, gy); await p.mouse.click(s.x, s.y); return g }
const shown = async p => { await panel(p).getByTestId('pixel-result').waitFor({ timeout: 15000 }); return (await panel(p).getByTestId('pixel-grid').innerText()).trim() }
const waitGrid = (p, txt) => p.waitForFunction(t => document.querySelector('[data-testid="pixel-grid"]')?.textContent.trim() === t, txt, { timeout: 15000 })
const curKey = p => p.evaluate(() => { const d = document.querySelector('[data-testid="frame-date"]').textContent.slice(0, 19); return [...document.querySelectorAll('figure img')].find(i => i.alt.includes(d)).getAttribute('src').match(/frame\/([^.]+)\.png/)[1] })

for (const scheme of ['dark', 'light']) {
  const T = `[${scheme}]`
  const p = await (await b.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 1000 } })).newPage()
  await p.goto(`${BASE}&fov=0.1&n=12`); await loaded(p)
  await check(`${T} empty state before any click`, async () => { await panel(p).getByTestId('pixel-empty').waitFor({ timeout: 5000 }) })
  await check(`${T} click-to-inspect at fit: grid pixel, sky and native values match the API`, async () => {
    await clickGrid(p, 12, 40); await waitGrid(p, '12, 40')
    const key = await curKey(p), api = await (await p.request.get(`${ORIGIN}/api/frame/${key}/pixel?x=12&y=40`)).json()
    const sky = await panel(p).getByTestId('pixel-sky').innerText(), nat = await panel(p).getByTestId('pixel-native').innerText()
    if (!sky.startsWith(api.sky.ra.toFixed(6)) || !nat.startsWith(`${api.native.ix}, ${api.native.iy}`)) throw new Error(`${sky} | ${nat} vs ${JSON.stringify(api.native)}`)
    return `(12,40) → ${sky}; native ${nat}`
  })
  await check(`${T} marker drawn on the selected pixel (screen position)`, async () => {
    const g = await geo(p), want = screenOf(g, 12, 40)
    const r = await p.locator('[data-testid="pixel-marker"] rect').nth(1).first().boundingBox()
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2
    if (Math.hypot(cx - want.x, cy - want.y) > 1.5) throw new Error(`marker ${cx.toFixed(1)},${cy.toFixed(1)} vs ${want.x.toFixed(1)},${want.y.toFixed(1)}`)
    return `marker centre within ${Math.hypot(cx - want.x, cy - want.y).toFixed(2)} px`
  })
  await check(`${T} correct pixel under zoom (×4, cursor-anchored)`, async () => {
    const g0 = await geo(p); await p.mouse.move(g0.left + g0.w * 0.62, g0.top + g0.h * 0.35)
    for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(40) } await settle(p)
    const g = await geo(p); if (g.s < 3) throw new Error('zoom ' + g.s)
    // pick a pixel that is visible in the zoomed view
    const gx = Math.floor(((0.5 - g.x) / g.s) * g.n), gy = Math.floor(((0.4 - g.y) / g.s) * g.n)
    await clickGrid(p, gx, gy); await waitGrid(p, `${gx}, ${gy}`); return `×${g.s.toFixed(2)} → (${gx}, ${gy})`
  })
  await check(`${T} correct pixel after panning; a drag never selects`, async () => {
    const before = await shown(p), g0 = await geo(p)
    await p.mouse.move(g0.left + g0.w * 0.5, g0.top + g0.h * 0.5); await p.mouse.down(); await p.mouse.move(g0.left + g0.w * 0.5 + 70, g0.top + g0.h * 0.5 + 45, { steps: 6 }); await p.mouse.up(); await settle(p)
    const afterDrag = await shown(p); if (afterDrag !== before) throw new Error(`drag changed selection ${before} → ${afterDrag}`)
    const g = await geo(p), gx = Math.floor(((0.3 - g.x) / g.s) * g.n), gy = Math.floor(((0.7 - g.y) / g.s) * g.n)
    await clickGrid(p, gx, gy); await waitGrid(p, `${gx}, ${gy}`); return `drag kept ${before}; after pan → (${gx}, ${gy})`
  })
  await check(`${T} stepping frames keeps the sky pixel and updates to the new frame`, async () => {
    await p.getByRole('button', { name: /Fit to view/ }).click(); await settle(p)
    await clickGrid(p, 20, 21); await waitGrid(p, '20, 21')
    const lbl0 = await panel(p).locator('span.truncate').innerText()
    await p.getByRole('button', { name: 'Next frame' }).click()
    await p.waitForFunction(l => { const s = document.querySelector('[aria-label="Pixel inspector"] span.truncate'); return s && s.textContent !== l }, lbl0, { timeout: 15000 })
    const lbl1 = await panel(p).locator('span.truncate').innerText(), g = await shown(p)
    if (g !== '20, 21') throw new Error(g); return `${lbl0.slice(0, 26)} → ${lbl1.slice(0, 26)} (pixel ${g})`
  })
  await check(`${T} Side-by-side: click B inspects B; marker shown in both panels`, async () => {
    await p.getByRole('tab', { name: 'Side-by-side' }).click(); await settle(p)
    await clickGrid(p, 33, 9, 1); await waitGrid(p, '33, 9')
    const lbl = await panel(p).locator('span.truncate').innerText(), markers = await p.locator('[data-testid="pixel-marker"][data-x="33"][data-y="9"]').filter({ visible: true }).count()
    if (!lbl.startsWith('B ·') || markers < 2) throw new Error(`${lbl} markers ${markers}`); return `${lbl.slice(0, 30)}; ${markers} markers`
  })
  await check(`${T} Blink: click inspects the frame being shown`, async () => {
    await p.getByRole('tab', { name: 'Blink' }).click(); await settle(p)
    const showing = await p.getByTestId('blink-label').innerText(); await clickGrid(p, 7, 7); await waitGrid(p, '7, 7')
    const lbl = await panel(p).locator('span.truncate').innerText()
    if (!/^[AB] ·/.test(lbl)) throw new Error(lbl); return `showing ${showing} at click → inspector "${lbl.slice(0, 3)}"`
  })
  await check(`${T} Difference: click inspects A; candidate marker still selects the candidate only`, async () => {
    await p.getByRole('tab', { name: 'Difference' }).click(); await p.getByRole('button', { name: /^Candidate 1,/ }).waitFor({ timeout: 60000 }); await settle(p)
    await clickGrid(p, 25, 30); await waitGrid(p, '25, 30')
    const lbl = await panel(p).locator('span.truncate').innerText()
    const mk = await p.locator('img[alt^="Difference image"]').locator('xpath=following-sibling::*[name()="svg"]//*[name()="g" and contains(@class,"cursor-pointer")]').nth(1).boundingBox()
    await p.mouse.click(mk.x + mk.width / 2, mk.y + mk.height / 2)
    const pressed = await p.getByRole('button', { name: /^Candidate 2,/ }).getAttribute('aria-pressed'), still = await shown(p)
    if (!lbl.startsWith('A ·') || pressed !== 'true' || still !== '25, 30') throw new Error(JSON.stringify({ lbl, pressed, still }))
    return `inspector "${lbl.slice(0, 3)}"; candidate 2 selected; pixel selection unchanged (${still})`
  })
  await check(`${T} Clear removes selection and marker`, async () => {
    await panel(p).getByRole('button', { name: 'Clear pixel selection' }).click()
    await panel(p).getByTestId('pixel-empty').waitFor({ timeout: 3000 })
    if (await p.locator('[data-testid="pixel-marker"]').count()) throw new Error('marker still drawn')
  })
  await p.screenshot({ path: `${OUT}pixel-${scheme}.png` })
  await p.close()
}

{ // off-detector pixel on the detector-edge frame (2025W33_2C_0321_3 at FOV 0.5)
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  await p.goto(`${BASE}&fov=0.5&n=10`); await loaded(p)
  for (let i = 0; i < 12 && !(await p.getByTestId('frame-date').innerText()).startsWith('2025-08-15 20:50'); i++) await p.getByRole('button', { name: 'Next frame' }).click()
  await check('off-detector click: classified "Off detector", no native pixel, detector outside', async () => {
    await clickGrid(p, 40, 10); await waitGrid(p, '40, 10')
    const st = await panel(p).getByTestId('pixel-state').innerText(), why = await panel(p).getByTestId('pixel-native-unavailable').innerText(), det = await panel(p).getByTestId('pixel-detector').innerText()
    if (!/Off detector/.test(st) || !/outside the detector/.test(why) || !/outside/.test(det)) throw new Error(`${st} | ${why} | ${det}`)
    return `${st} | ${why} | ${det}`
  })
  await check('masked pixel (saturated core): masking flag shown on the native pixel', async () => {
    const n = (await geo(p)).n, c = (n - 1) / 2; await clickGrid(p, c, c); await waitGrid(p, `${c}, ${c}`)
    const st = await panel(p).getByTestId('pixel-state').innerText(), names = await panel(p).getByTestId('pixel-flag-names').innerText()
    if (!/Masked/.test(st) || !/OVERFLOW/.test(names)) throw new Error(`${st} | ${names}`); return `${st} | ${names.replace(/\s+/g, ' ')}`
  })
  await p.close() }

{ // loading + error + retry via interception
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } }); const st = { mode: 'slow' }
  await p.route('**/api/frame/*/pixel*', async r => {
    if (st.mode === 'slow') { await new Promise(res => setTimeout(res, 1500)); return r.continue() }
    if (st.mode === 'fail') return r.fulfill({ status: 500, json: { detail: 'pixel backend error' } })
    return r.continue()
  })
  await p.goto(`${BASE}&fov=0.1&n=12`); await loaded(p)
  await check('loading state while the pixel is looked up', async () => { await clickGrid(p, 3, 3); await panel(p).getByTestId('pixel-loading').waitFor({ timeout: 1000 }); await waitGrid(p, '3, 3') })
  await check('error state with retry', async () => {
    st.mode = 'fail'; await clickGrid(p, 4, 9); await panel(p).getByRole('alert').waitFor({ timeout: 5000 })
    st.mode = 'pass'; await panel(p).getByRole('button', { name: /Retry/ }).click(); await waitGrid(p, '4, 9')
  })
  await check('rapid clicks: only the last pixel is shown (stale responses dropped)', async () => {
    st.mode = 'slow'
    for (const [x, y] of [[1, 1], [2, 2], [3, 5], [9, 9]]) { await clickGrid(p, x, y); await p.waitForTimeout(60) }
    await waitGrid(p, '9, 9'); await p.waitForTimeout(1800); const g = await shown(p)
    if (g !== '9, 9') throw new Error('stale overwrite: ' + g); return 'final 9, 9'
  })
  await p.close() }

{ // mobile tap
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
  await p.goto(`${BASE}&fov=0.1&n=8`); await loaded(p)
  await check('mobile: tap inspects the tapped pixel; no horizontal overflow', async () => {
    // wait until the mobile auto-scroll to the viewer has finished (rect stable), then tap
    let g = await geo(p); for (let k = 0; k < 20; k++) { await p.waitForTimeout(150); const g2 = await geo(p); if (Math.abs(g2.top - g.top) < 0.5) break; g = g2 }
    const s = screenOf(g, 30, 30); await p.touchscreen.tap(s.x, s.y); await waitGrid(p, '30, 30')
    const o = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (o > 0) throw new Error('overflow ' + o); return 'tap → (30, 30)'
  })
  await p.close() }
report(results)
await b.close()
