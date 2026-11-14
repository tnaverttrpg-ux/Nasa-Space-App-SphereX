// Browser checks for the intensity histogram (real Barnard D6 frames), both themes + mobile.
import { chromium } from 'playwright-core'
import { LAUNCH, ORIGIN, OUT, report } from './lib.mjs'
const S = OUT
const URL = `${ORIGIN}/?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12`
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const fmt = v => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : v.toPrecision(3))
const b = await chromium.launch(LAUNCH)
const loaded = p => p.waitForFunction(() => /Loaded \d+\/\d+ frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 300000 })
const curKey = p => p.evaluate(() => {
  const d = document.querySelector('[data-testid="frame-date"]').textContent.slice(0, 19)
  const img = [...document.querySelectorAll('figure img')].find(i => i.alt.includes(d))
  return img.getAttribute('src').match(/frame\/([^.]+)\.png/)[1]
})
const panel = p => p.getByRole('region', { name: 'Intensity histogram' })
const shown = async p => Object.fromEntries(await Promise.all(['hist-n', 'hist-median', 'hist-mean', 'hist-sigma', 'hist-p1', 'hist-p99.7', 'hist-display']
  .map(async id => [id, (await panel(p).getByTestId(id).innerText()).trim()])))

for (const scheme of ['dark', 'light']) {
  const ctx = await b.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 1000 } })
  const p = await ctx.newPage()
  await p.goto(URL); await loaded(p)
  await check(`[${scheme}] histogram appears for a real observation with 128 bars`, async () => {
    await panel(p).getByTestId('hist-svg').waitFor({ timeout: 20000 })
    const bars = await panel(p).locator('svg rect').count()
    if (bars < 128) throw new Error(`${bars} rects`); return `${bars} rects (128 bins + display band)`
  })
  const seen = []
  await check(`[${scheme}] statistics match /api/frame/{key}/stats for 4 frames, and change with the frame`, async () => {
    for (let i = 0; i < 4; i++) {
      const key = await curKey(p)
      const api = await (await p.request.get(`${ORIGIN}/api/frame/${key}/stats`)).json()
      await p.waitForFunction(() => !!document.querySelector('[data-testid="hist-n"]'))
      const ui = await shown(p)
      const exp = { 'hist-n': api.n_valid.toLocaleString('en-US'), 'hist-median': fmt(api.stats.median), 'hist-mean': fmt(api.stats.mean), 'hist-sigma': fmt(api.stats.robust_sigma),
        'hist-p1': fmt(api.stats.percentiles['1']), 'hist-p99.7': fmt(api.stats.percentiles['99.7']), 'hist-display': `${fmt(api.display_limits.min)} … ${fmt(api.display_limits.max)}` }
      for (const k in exp) if (ui[k] !== exp[k]) throw new Error(`${key} ${k}: ui ${ui[k]} vs api ${exp[k]}`)
      seen.push(`${ui['hist-n']}/${ui['hist-median']}`)
      await p.getByRole('button', { name: 'Next frame' }).click()
    }
    if (new Set(seen).size < 2) throw new Error('histogram did not change between frames ' + seen)
    return seen.join('  ')
  })
  await check(`[${scheme}] hover tooltip reports bin range and pixel count`, async () => {
    let box = null
    for (let k = 0; k < 40 && !box; k++) { box = await panel(p).getByTestId('hist-svg').boundingBox().catch(() => null); if (!box) await p.waitForTimeout(250) }
    await p.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5)
    const t = await panel(p).getByTestId('hist-hover').innerText()
    if (!/^\[.+\) · [\d,]+ px \(/.test(t)) throw new Error(t); return t
  })
  await check(`[${scheme}] theme colours applied (bars + display band)`, async () => {
    await panel(p).getByTestId('hist-svg').waitFor({ timeout: 20000 })
    const c = await panel(p).locator('svg rect').evaluateAll(rs => [getComputedStyle(rs[0]).fill, getComputedStyle(rs[5]).fill])
    return c.join(' | ')
  })
  await panel(p).screenshot({ path: `${S}hist-${scheme}.png` })
  await ctx.close()
}

// loading, error + retry, empty data: each page starts with its interception mode already active (deterministic)
const EMPTY = { key: 'x', quantity: 'aligned-grid surface brightness', unit: 'MJy / sr', calibrated_photometry: false, demo: false,
  n_grid: 100, n_valid: 0, n_off_detector: 60, n_masked_or_invalid: 40, display_limits: null, stats: null, histogram: null }
async function pageWith(initial) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } })
  const p = await ctx.newPage(); const st = { mode: initial }
  await p.route('**/api/frame/*/stats*', async r => {
    if (st.mode === 'slow') { await new Promise(res => setTimeout(res, 2500)); return r.continue() }
    if (st.mode === 'fail') return r.fulfill({ status: 500, json: { detail: 'stats backend error' } })
    if (st.mode === 'empty') return r.fulfill({ json: EMPTY })
    return r.continue()
  })
  await p.goto(URL); await panel(p).waitFor({ timeout: 120000 })
  return { p, st, ctx }
}
{ const { p, ctx } = await pageWith('slow')
  await check('loading state shown while stats are computed', async () => { await panel(p).getByTestId('hist-loading').waitFor({ timeout: 5000 }); await panel(p).getByTestId('hist-svg').waitFor({ timeout: 30000 }) })
  await ctx.close() }
{ const { p, st, ctx } = await pageWith('fail')
  await check('error state with retry that recovers', async () => {
    await panel(p).getByRole('alert').waitFor({ timeout: 10000 })
    const msg = await panel(p).getByRole('alert').innerText()
    st.mode = 'pass'; await panel(p).getByRole('button', { name: /Retry/ }).click()
    await panel(p).getByTestId('hist-svg').waitFor({ timeout: 10000 }); return msg.replace(/\s+/g, ' ')
  })
  await ctx.close() }
{ const { p, ctx } = await pageWith('empty')
  await check('empty valid-data handled', async () => panel(p).getByTestId('hist-empty').innerText({ timeout: 10000 }))
  await ctx.close() }

const m = await (await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage()
await m.goto(URL); await loaded(m)
await check('responsive at 390 px: histogram fits, no horizontal overflow', async () => {
  await panel(m).getByTestId('hist-svg').waitFor({ timeout: 20000 })
  const r = await m.evaluate(() => { const s = document.querySelector('[data-testid="hist-svg"]').getBoundingClientRect(); return { w: Math.round(s.width), right: Math.round(s.right), vw: innerWidth, over: document.documentElement.scrollWidth - innerWidth } })
  if (r.over > 0 || r.right > r.vw) throw new Error(JSON.stringify(r)); return JSON.stringify(r)
})
report(results)
await b.close()
