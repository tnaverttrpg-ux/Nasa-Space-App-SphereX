// Advanced viewer navigation: zoom/pan/sync/difference display controls. Reads real CSS transforms.
import { chromium } from 'playwright-core'
import { LAUNCH, ORIGIN, OUT, report } from './lib.mjs'
const S = OUT
const URL = `${ORIGIN}/?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12`
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
const loaded = p => p.waitForFunction(() => /Loaded \d+\/\d+ frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 300000 })
// visible viewports and their normalised view {s, x, y} from the computed transform matrix
const views = p => p.evaluate(() => [...document.querySelectorAll('[data-viewport]')].filter(el => el.offsetParent && getComputedStyle(el.closest('[aria-hidden]') ?? el).opacity !== '0' && el.getBoundingClientRect().width > 0)
  .filter(el => !el.parentElement.closest('.opacity-0')).map(el => {
    const r = el.getBoundingClientRect(), l = el.querySelector('[data-testid="view-layer"]')
    const m = new DOMMatrixReadOnly(getComputedStyle(l).transform)
    return { s: +m.a.toFixed(4), x: +(m.e / r.width).toFixed(4), y: +(m.f / r.height).toFixed(4), w: r.width, left: r.left, top: r.top }
  }))
const settle = p => p.waitForTimeout(220)   // 90 ms CSS transition
const vp = p => p.locator('[data-viewport]').filter({ visible: true }).first()

for (const scheme of ['dark', 'light']) {
  const ctx = await b.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 1000 } })
  const p = await ctx.newPage()
  await p.goto(URL); await loaded(p)
  const T = `[${scheme}]`

  await check(`${T} zoom limits (×1 … ×24), buttons disable at limits`, async () => {
    for (let i = 0; i < 20; i++) await p.getByRole('button', { name: 'Zoom in' }).click({ force: true }).catch(() => {})
    const hi = await p.getByTestId('zoom-level').innerText(), inDis = await p.getByRole('button', { name: 'Zoom in' }).isDisabled()
    for (let i = 0; i < 25; i++) await p.getByRole('button', { name: 'Zoom out' }).click({ force: true }).catch(() => {})
    const lo = await p.getByTestId('zoom-level').innerText(), outDis = await p.getByRole('button', { name: 'Zoom out' }).isDisabled()
    if (hi !== '×24.0' || lo !== '×1.0' || !inDis || !outDis) throw new Error(`${hi} ${lo} ${inDis} ${outDis}`)
    return `${hi} → ${lo}`
  })
  await check(`${T} wheel zoom keeps the point under the cursor fixed`, async () => {
    const box = await vp(p).boundingBox(); const u = 0.27, w = 0.31
    await settle(p); const [v0] = await views(p)
    await p.mouse.move(box.x + u * box.width, box.y + w * box.height)
    for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, -240); await p.waitForTimeout(40) }
    await settle(p); const [v1] = await views(p)
    const c0 = [(u - v0.x) / v0.s, (w - v0.y) / v0.s], c1 = [(u - v1.x) / v1.s, (w - v1.y) / v1.s]
    if (!(v1.s > 2) || Math.hypot(c0[0] - c1[0], c0[1] - c1[1]) > 0.003) throw new Error(JSON.stringify({ v0, v1, c0, c1 }))
    return `×${v1.s.toFixed(2)}; image point under cursor ${c0.map(v => v.toFixed(3))} → ${c1.map(v => v.toFixed(3))}`
  })
  await check(`${T} drag pans by the dragged distance (clamped inside image)`, async () => {
    const box = await vp(p).boundingBox(); const [v0] = await views(p)
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down()
    await p.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40, { steps: 6 }); await p.mouse.up()
    await settle(p); const [v1] = await views(p)
    const dx = (v1.x - v0.x) * box.width, dy = (v1.y - v0.y) * box.height
    if (Math.abs(dx + 60) > 1.5 || Math.abs(dy + 40) > 1.5) throw new Error(`moved ${dx.toFixed(1)}, ${dy.toFixed(1)} px`)
    // clamp: drag far beyond the edge, image must still cover the box
    await p.mouse.move(box.x + 10, box.y + 10); await p.mouse.down(); await p.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 4 }); await p.mouse.up()
    await settle(p); const [v2] = await views(p)
    if (v2.x > 1e-6 || v2.y > 1e-6 || v2.x < 1 - v2.s - 1e-6) throw new Error('not clamped ' + JSON.stringify(v2))
    return `Δ ${dx.toFixed(1)}, ${dy.toFixed(1)} px; clamped at x=${v2.x}`
  })
  await check(`${T} image and SVG overlay stay aligned while zoomed`, async () => {
    const r = await vp(p).evaluate(el => { const i = el.querySelector('[data-testid="view-layer"] img:not([aria-hidden])').getBoundingClientRect(), s = el.querySelector('[data-testid="view-layer"] svg').getBoundingClientRect(); return [i.x - s.x, i.y - s.y, i.width - s.width, i.height - s.height] })
    if (r.some(v => Math.abs(v) > 0.5)) throw new Error(r.join(',')); return `Δ ${r.map(v => v.toFixed(2)).join(', ')} px`
  })
  await check(`${T} keyboard: + zooms, arrows pan without stepping frames, 0 fits`, async () => {
    const date0 = await p.getByTestId('frame-date').innerText()
    await vp(p).focus(); await p.keyboard.press('+'); await settle(p)
    const [a] = await views(p); await p.keyboard.press('ArrowRight'); await settle(p); const [bv] = await views(p)
    const date1 = await p.getByTestId('frame-date').innerText()
    await p.keyboard.press('0'); await settle(p); const [c] = await views(p)
    if (date1 !== date0 || !(bv.x < a.x) || c.s !== 1 || c.x !== 0) throw new Error(JSON.stringify({ date0, date1, a, bv, c }))
    return `frame unchanged (${date0.slice(0, 16)}); fit → ×${c.s}`
  })
  await check(`${T} Fit button and double-click reset`, async () => {
    await p.getByRole('button', { name: 'Zoom in' }).click(); await p.getByRole('button', { name: 'Zoom in' }).click(); await settle(p)
    await p.getByRole('button', { name: /Fit to view/ }).click(); await settle(p); const [a] = await views(p)
    await p.getByRole('button', { name: 'Zoom in' }).click(); await settle(p)
    await vp(p).dblclick(); await settle(p); const [c] = await views(p)
    if (a.s !== 1 || c.s !== 1 || a.x !== 0 || c.y !== 0) throw new Error(JSON.stringify({ a, c })); return 'both → ×1'
  })
  await check(`${T} playback controls unaffected (Next frame still steps)`, async () => {
    const d0 = await p.getByTestId('frame-date').innerText(); await p.getByRole('button', { name: 'Next frame' }).click()
    const d1 = await p.getByTestId('frame-date').innerText(); if (d0 === d1) throw new Error('did not step'); return `${d0.slice(0, 10)} → ${d1.slice(0, 10)}`
  })
  // --- synchronisation
  await p.getByRole('button', { name: 'Zoom in' }).click(); await p.getByRole('button', { name: 'Zoom in' }).click(); await settle(p)
  const seqView = (await views(p))[0]
  await check(`${T} switching to Side-by-side keeps the view; both panels identical`, async () => {
    await p.getByRole('tab', { name: 'Side-by-side' }).click(); await settle(p)
    const v = await views(p)
    if (v.length !== 2 || v.some(x => Math.abs(x.s - seqView.s) > 1e-3 || Math.abs(x.x - seqView.x) > 1e-3)) throw new Error(JSON.stringify({ seqView, v }))
    return `2 panels ×${v[0].s}`
  })
  await check(`${T} wheel on A and drag on B move both panels together`, async () => {
    const [ba, bb] = await p.locator('[data-viewport]').filter({ visible: true }).evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }))
    await p.mouse.move(ba.x + ba.w * 0.7, ba.y + ba.h * 0.4); await p.mouse.wheel(0, -300); await settle(p)
    await p.mouse.move(bb.x + bb.w / 2, bb.y + bb.h / 2); await p.mouse.down(); await p.mouse.move(bb.x + bb.w / 2 + 30, bb.y + bb.h / 2 + 20, { steps: 4 }); await p.mouse.up(); await settle(p)
    const v = await views(p)
    if (v.length !== 2 || Math.abs(v[0].s - v[1].s) > 1e-4 || Math.abs(v[0].x - v[1].x) > 1e-4 || Math.abs(v[0].y - v[1].y) > 1e-4) throw new Error(JSON.stringify(v))
    return `A=B: ×${v[0].s} (${v[0].x}, ${v[0].y})`
  })
  await check(`${T} resetting one panel resets both`, async () => {
    const [, bb] = await p.locator('[data-viewport]').filter({ visible: true }).all()
    await bb.dblclick(); await settle(p); const v = await views(p)
    if (v.some(x => x.s !== 1 || x.x !== 0 || x.y !== 0)) throw new Error(JSON.stringify(v)); return 'both ×1'
  })
  await p.getByRole('button', { name: 'Zoom in' }).click(); await p.getByRole('button', { name: 'Zoom in' }).click(); await settle(p)
  const sideView = (await views(p))[0]
  await check(`${T} Blink keeps the view and still alternates A/B`, async () => {
    await p.getByRole('tab', { name: 'Blink' }).click(); await settle(p)
    const seen = new Set(); for (let i = 0; i < 8; i++) { seen.add(await p.getByTestId('blink-label').innerText()); await p.waitForTimeout(150) }
    const [v] = await views(p)
    if (seen.size < 2 || Math.abs(v.s - sideView.s) > 1e-3) throw new Error(JSON.stringify({ seen: [...seen], v, sideView })); return `×${v.s}, alternated ${[...seen]}`
  })
  // --- difference display controls
  await check(`${T} Difference keeps the view (diff + both thumbnails synced)`, async () => {
    await p.getByRole('tab', { name: 'Difference' }).click()
    await p.getByRole('button', { name: /^Candidate 1,/ }).waitFor({ timeout: 60000 }); await settle(p)
    const v = await views(p)
    if (v.length !== 3 || v.some(x => Math.abs(x.s - sideView.s) > 1e-3 || Math.abs(x.x - v[0].x) > 1e-4)) throw new Error(JSON.stringify(v)); return `3 panels ×${v[0].s}`
  })
  const candTexts = () => p.getByRole('button', { name: /^Candidate \d+,/ }).allInnerTexts()
  await check(`${T} default contrast ±5σ; contrast change re-renders only the picture (candidates identical, debounced)`, async () => {
    const leg0 = await p.getByTestId('diff-scale-legend').innerText(), c0 = await candTexts()
    await p.getByRole('button', { name: /^Candidate 2,/ }).click()
    const detail0 = await p.getByTestId('candidate-detail').innerText()
    const png0 = await p.locator('img[alt^="Difference image"]').getAttribute('src')
    let diffReqs = 0; const onReq = r => { if (r.url().includes('/api/diff')) diffReqs++ }; p.on('request', onReq)
    const slider = p.getByLabel('Difference display contrast in sigma')
    for (const v of ['6', '8', '9.5', '11', '12']) { await slider.fill(v); await p.waitForTimeout(30) }
    await p.waitForFunction(() => /±12σ/.test(document.querySelector('[data-testid="diff-scale-legend"]')?.textContent ?? ''), null, { timeout: 15000 })
    p.off('request', onReq)
    const c1 = await candTexts(), detail1 = await p.getByTestId('candidate-detail').innerText()
    const png1 = await p.locator('img[alt^="Difference image"]').getAttribute('src')
    const cap = await p.locator('figure', { has: p.locator('img[alt^="Difference image"]') }).locator('figcaption').innerText()
    if (!/±5σ/.test(leg0) || JSON.stringify(c0) !== JSON.stringify(c1) || detail0 !== detail1 || png0 === png1 || !/display ±12σ/.test(cap) || diffReqs > 2)
      throw new Error(JSON.stringify({ leg0, same: JSON.stringify(c0) === JSON.stringify(c1), detail: detail0 === detail1, pngChanged: png0 !== png1, cap, diffReqs }))
    return `legend ±5σ → ±12σ; ${c1.length} candidates identical; selection kept; ${diffReqs} request(s) for 5 slider moves`
  })
  await check(`${T} candidate set independent of contrast at the extremes (1σ vs 20σ)`, async () => {
    const slider = p.getByLabel('Difference display contrast in sigma')
    await slider.fill('1'); await p.waitForFunction(() => /±1σ/.test(document.querySelector('[data-testid="diff-scale-legend"]')?.textContent ?? ''), null, { timeout: 15000 }); const lo = await candTexts()
    await slider.fill('20'); await p.waitForFunction(() => /±20σ/.test(document.querySelector('[data-testid="diff-scale-legend"]')?.textContent ?? ''), null, { timeout: 15000 }); const hi = await candTexts()
    await p.getByRole('button', { name: 'default 5σ' }).click()
    if (JSON.stringify(lo) !== JSON.stringify(hi)) throw new Error('candidates changed'); return `${lo.length} candidates at 1σ and 20σ`
  })
  await check(`${T} opacity blends over observation A and is labelled as a visual aid`, async () => {
    await p.getByLabel('Difference image opacity over observation A').fill('0.5')
    const fig = p.locator('figure', { has: p.locator('img[alt^="Difference image"]') })
    const op = await fig.locator('img[alt^="Difference image"]').evaluate(e => getComputedStyle(e).opacity)
    const under = await fig.locator('img[aria-hidden]').count(), cap = await fig.locator('figcaption').innerText()
    const note = await p.getByText(/visual aid, not pure red\/blue/).isVisible()
    await p.getByLabel('Difference image opacity over observation A').fill('1')
    const under1 = await fig.locator('img[aria-hidden]').count()
    if (op !== '0.5' || under !== 1 || !/over A \(50%\)/.test(cap) || !note || under1 !== 0) throw new Error(JSON.stringify({ op, under, cap, note, under1 }))
    return `opacity ${op}, underlay A present, label "${cap.split('\n')[0]}"`
  })
  await check(`${T} dragging across a candidate marker pans, does not select it`, async () => {
    await p.getByRole('button', { name: 'Zoom in' }).click(); await settle(p)
    const sel0 = await p.getByRole('button', { name: /^Candidate \d+,/, pressed: true }).count()
    const mk = await p.locator('img[alt^="Difference image"]').locator('xpath=following-sibling::*[name()="svg"]//*[name()="g" and contains(@class,"cursor-pointer")]').first().boundingBox()
    await p.mouse.move(mk.x + mk.width / 2, mk.y + mk.height / 2); await p.mouse.down(); await p.mouse.move(mk.x - 40, mk.y - 25, { steps: 5 }); await p.mouse.up()
    const sel1 = await p.getByRole('button', { name: /^Candidate \d+,/, pressed: true }).count()
    const detail = await p.getByTestId('candidate-detail').count()
    if (sel1 !== sel0) throw new Error(`selection changed ${sel0} → ${sel1}`); return `selection unchanged (${sel1} selected, detail panels ${detail})`
  })
  await p.screenshot({ path: `${S}nav-${scheme}.png` })
  await ctx.close()
}

// mobile: layout + real two-finger pinch via CDP touch events
{ const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const p = await ctx.newPage()
  await p.goto(URL); await loaded(p)
  await check('mobile 390 px: no horizontal overflow, zoom controls visible', async () => {
    const o = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), vis = await p.getByRole('button', { name: 'Zoom in' }).isVisible()
    if (o > 0 || !vis) throw new Error(`overflow ${o}, controls ${vis}`); return 'overflow 0'
  })
  await check('mobile two-finger pinch zooms in', async () => {
    const bx = await vp(p).boundingBox(); const cx = bx.x + bx.width / 2, cy = bx.y + bx.height / 2
    const cdp = await ctx.newCDPSession(p)
    const touch = (type, d) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }] })
    await touch('touchStart', 20); for (const d of [30, 45, 60, 80]) await touch('touchMove', d); await touch('touchEnd', 0)
    await settle(p); const [v] = await views(p)
    if (!(v.s > 1.5)) throw new Error('scale ' + v.s); return `pinch → ×${v.s.toFixed(2)}`
  })
  await p.screenshot({ path: `${S}nav-mobile.png` })
  await ctx.close() }
report(results)
await b.close()
