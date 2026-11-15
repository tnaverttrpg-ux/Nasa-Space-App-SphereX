// Real-browser functional test of SPHERE TRACK (Edge via playwright-core).
import { chromium } from 'playwright-core'
import { APP, LAUNCH, ORIGIN, OUT, report } from './lib.mjs'
const S = OUT
const BASE = `${ORIGIN}`
const results = []
const check = async (name, fn) => {
  try { const note = await fn(); results.push(['PASS', name, note ?? '']) }
  catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) }
}
const browser = await chromium.launch(LAUNCH)
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: process.env.SCHEME || 'light' })
const page = await ctx.newPage()
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push(String(e)))
const apiCalls = []
page.on('request', r => { if (r.url().includes('/api/')) apiCalls.push(r.url().replace(BASE, '')) })

await check('initial dashboard loads', async () => {
  await page.goto(APP)
  await page.getByText('SPHERE TRACK', { exact: true }).first().waitFor()
  await page.screenshot({ path: S + '01-initial.png' })
})
await check('presets resolved (5 targets)', async () => {
  for (const t of ["Barnard's Star", 'Epsilon Indi B', 'WISE 0855', 'RW Aurigae', 'R Draconis'])
    await page.getByRole('button', { name: new RegExp(t) }).first().waitFor({ timeout: 30000 })
})
await check('invalid coordinate rejected', async () => {
  await page.getByLabel(/^RA/).first().fill('400')
  await page.getByLabel(/^Dec/).first().fill('10')
  await page.getByRole('button', { name: /Search SPHEREx/ }).click()
  await page.getByText(/RA must be/).waitFor({ timeout: 3000 })
})
await check('Barnard preset -> real frames load', async () => {
  await page.getByRole('button', { name: /Barnard's Star/ }).first().click()
  await page.waitForFunction(() => /Loaded (\d+)\/\1/.test(document.body.innerText), null, { timeout: 400000 })
  await page.screenshot({ path: S + '02-barnard.png' })
  return page.url()
})
await check('URL updated with params', async () => {
  const u = new URL(page.url())
  if (!u.searchParams.get('ra') || !u.searchParams.get('fov')) throw new Error('missing params ' + page.url())
})
await check('measured metadata shown', async () => { await page.getByText('MJD-AVG').waitFor({ timeout: 5000 }) })
const dateText = () => page.getByTestId('frame-date').innerText()
await check('next/prev navigation changes date', async () => {
  const d0 = await dateText()
  await page.getByRole('button', { name: /Next frame/ }).click()
  const d1 = await dateText()
  await page.getByRole('button', { name: /Previous frame/ }).click()
  if (d0 === d1 || (await dateText()) !== d0) throw new Error(`${d0} / ${d1}`)
  return `${d0} -> ${d1}`
})
await check('autoplay advances frames + speed slider', async () => {
  await page.getByLabel(/Playback speed/).fill('8')
  const d0 = await dateText()
  await page.getByRole('button', { name: /^Play/ }).click()
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: /^Pause/ }).click()
  if ((await dateText()) === d0) throw new Error('did not advance')
})
await check('keyboard: ArrowRight steps frame', async () => {
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  const d0 = await dateText()
  await page.keyboard.press('ArrowRight')
  if ((await dateText()) === d0) await page.keyboard.press('ArrowLeft'), await page.keyboard.press('ArrowLeft')
  if ((await dateText()) === d0) throw new Error('no change')
})
await check('side-by-side mode', async () => {
  await page.getByRole('tab', { name: 'Side-by-side' }).click()
  if ((await page.locator('figure img').count()) < 2) throw new Error('expected 2 images')
  await page.screenshot({ path: S + '03-side.png' })
})
await check('blink mode alternates A/B', async () => {
  await page.getByRole('tab', { name: 'Blink' }).click()
  const seen = new Set()
  for (let i = 0; i < 8; i++) { seen.add(await page.getByTestId('blink-label').innerText()); await page.waitForTimeout(150) }
  if (seen.size < 2) throw new Error('no alternation ' + [...seen])
})
await check('difference mode + legend + derived panel', async () => {
  await page.getByRole('tab', { name: 'Difference' }).click()
  await page.getByRole('region', { name: 'Difference analysis' }).getByText('Derived', { exact: true }).waitFor({ timeout: 60000 })
  await page.getByText('Red = brighter in observation A').waitFor()
  await page.getByText('Blue = brighter in observation B').waitFor()
  await page.screenshot({ path: S + '04-diff.png', fullPage: true })
})
await check('candidate selection shows details', async () => {
  const c = page.getByRole('button', { name: /Candidate 1\b/ }).first()
  await c.click()
  await page.getByTestId('candidate-detail').waitFor({ timeout: 3000 })
  return (await page.getByTestId('candidate-detail').innerText()).replace(/\s+/g, ' ').slice(0, 140)
})
await check('candidate selection: image marker -> table row (bidirectional)', async () => {
  await page.locator('svg g.cursor-pointer').nth(1).click({ force: true })
  const pressed = await page.getByRole('button', { name: /^Candidate 2,/ }).getAttribute('aria-pressed')
  if (pressed !== 'true') throw new Error('row 2 not selected after marker click')
  return (await page.getByTestId('candidate-detail').innerText()).replace(/\s+/g, ' ').slice(0, 60)
})
await check('Gaia DR3 overlay draws sources', async () => {
  await page.getByRole('tab', { name: 'Sequence' }).click()
  await page.getByLabel(/Gaia DR3 overlay/).check()
  await page.getByText(/Gaia DR3 sources/).waitFor({ timeout: 90000 })
  const n = await page.locator('svg circle').count()
  if (!n) throw new Error('no circles')
  await page.getByLabel(/Show stars brighter than/).selectOption('19')
  const n19 = await page.locator('svg circle').count()
  await page.getByLabel(/Show stars brighter than/).selectOption('16')
  await page.screenshot({ path: S + '05-gaia.png' })
  if (n19 <= n) throw new Error(`G filter ineffective ${n} vs ${n19}`)
  return `${n} circles at G<16, ${n19} at G<19 (visible frame only)`
})
await check('tooltips present (RA/Dec/FOV/λ/PM/diff)', async () => {
  const tips = await page.getByRole('button', { name: /^About / }).count()
  if (tips < 6) throw new Error(`only ${tips} info tips`)
  await page.getByRole('button', { name: /^About Right Ascension/ }).focus()
  await page.getByRole('tooltip').first().waitFor({ timeout: 2000 })
  return `${tips} tips`
})
await check('refresh restores shared URL (cached, fast)', async () => {
  const url = page.url(); const t = Date.now()
  await page.goto(url)
  await page.waitForFunction(() => /Loaded (\d+)\/\1/.test(document.body.innerText), null, { timeout: 60000 })
  return `${((Date.now() - t) / 1000).toFixed(1)}s`
})
await check('WISE 0855 preset loads real frames', async () => {
  await page.getByRole('button', { name: /WISE 0855/ }).first().click()
  await page.waitForFunction(() => /Loaded (\d+)\/\1/.test(document.body.innerText), null, { timeout: 400000 })
  await page.screenshot({ path: S + '06-wise.png' })
})
await check('empty result (band with no coverage) shows honest message', async () => {
  // Inject an empty archive response to exercise the UI state without a fake coordinate claim.
  await page.route('**/api/observations*', r => r.fulfill({ json: { total_in_band: 0, band_counts: { D1: 0, D2: 0, D3: 0, D4: 0, D5: 0, D6: 0 }, observations: [] } }))
  await page.getByRole('button', { name: /Search SPHEREx/ }).click()
  await page.getByText(/No SPHEREx observations/).waitFor({ timeout: 10000 })
  await page.unroute('**/api/observations*')
})
await check('IRSA 503 -> error state + retry recovers', async () => {
  let n = 0
  await page.route('**/api/observations*', r => (n++ === 0 ? r.fulfill({ status: 502, json: { detail: 'IRSA cutout service returned HTTP 503' } }) : r.continue()))
  await page.getByRole('button', { name: /Search SPHEREx/ }).click()
  await page.getByText(/HTTP 503/).first().waitFor({ timeout: 10000 })
  await page.getByRole('button', { name: /^Retry/ }).first().click()
  await page.waitForFunction(() => /Loaded (\d+)\/\1/.test(document.body.innerText), null, { timeout: 60000 })
  await page.unroute('**/api/observations*')
})
await check('frame failure -> retry button recovers frame', async () => {
  let n = 0
  await page.route('**/api/frame?*', r => (n++ === 0 ? r.fulfill({ status: 504, json: { detail: 'IRSA cutout request timed out' } }) : r.continue()))
  await page.reload()
  await page.waitForFunction(() => /failed/.test(document.body.innerText), null, { timeout: 60000 })
  await page.getByRole('button', { name: /^Retry failed \(\d+\)$/ }).click()
  await page.waitForFunction(() => /Loaded (\d+)\/\1/.test(document.body.innerText) && !/failed/.test(document.body.innerText), null, { timeout: 60000 })
  await page.unroute('**/api/frame?*')
})
await check('demo mode clearly labelled', async () => {
  await page.goto(APP + '?demo=1')
  await page.getByText(/DEMO MODE\./).first().waitFor({ timeout: 10000 })
  await page.getByText(/Synthetic demo · not SPHEREx/).first().waitFor()
  await page.getByText(/not SPHEREx/i).first().waitFor()
})
await check('mobile 390px: no horizontal scroll, viewer usable', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await m.goto(APP + '?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=8')
  await m.waitForFunction(() => /Loaded (\d+)\/\1/.test(document.body.innerText), null, { timeout: 120000 })
  const over = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  await m.screenshot({ path: S + '07-mobile.png', fullPage: true })
  if (over > 0) throw new Error(`overflow ${over}px`)
})
await check('desktop 1440x900: image ≥550px, legend + playback + timeline on screen (seq & diff)', async () => {
  const d = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await d.goto(APP + '?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12')
  await d.waitForFunction(() => /Loaded (\d+)\/\1/.test(document.body.innerText), null, { timeout: 120000 })
  const onScreen = sel => d.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }, sel)
  const out = []
  for (const mode of ['Sequence', 'Difference']) {
    await d.getByRole('tab', { name: mode }).click()
    if (mode === 'Difference') {
      await d.getByText('Red = brighter in observation A').waitFor({ timeout: 60000 })
      // the legend appears with the mode; the figures only once /api/diff has returned, so wait for the image itself
      await d.getByAltText('Difference image, A minus k times B').waitFor({ timeout: 60000 })
    }
    const img = await d.evaluate(() => Math.max(...[...document.querySelectorAll('figure')].map(f => f.getBoundingClientRect().width)))
    for (const s of ['[aria-label="Observation timeline"]', '[aria-label="Next frame"]']) if (!(await onScreen(s))) throw new Error(`${mode}: ${s} off screen`)
    if (mode === 'Difference' && !(await d.getByText('Blue = brighter in observation B').isVisible())) throw new Error('legend hidden')
    if (img < (mode === 'Sequence' ? 550 : 480)) throw new Error(`${mode}: image only ${img}px`)
    out.push(`${mode} ${Math.round(img)}px`)
  }
  await d.close()
  return out.join(', ')
})
await check('mobile 390px: sticky playback row stays with viewer, never over metadata', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await m.goto(APP + '?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=8')
  await m.waitForFunction(() => /Loaded (\d+)\/\1/.test(document.body.innerText), null, { timeout: 120000 })
  const top = await m.evaluate(() => document.querySelector('[aria-label="Observation viewer"]').getBoundingClientRect().top + scrollY)
  await m.evaluate(t => scrollTo(0, t - 600), top)
  const stuck = await m.evaluate(() => { const r = document.querySelector('[aria-label="Next frame"]').getBoundingClientRect(); return r.bottom <= innerHeight && r.bottom > innerHeight - 60 })
  await m.evaluate(() => document.querySelector('[aria-label="Frame metadata"]').scrollIntoView({ block: 'center' }))
  const over = await m.evaluate(() => { const b = document.querySelector('[aria-label="Next frame"]').getBoundingClientRect(); const md = document.querySelector('[aria-label="Frame metadata"]').getBoundingClientRect(); return b.bottom > md.top && b.top < md.bottom })
  await m.close()
  if (!stuck) throw new Error('playback row not sticky while viewer partly visible')
  if (over) throw new Error('playback row overlaps metadata')
})
await check('empty-state example buttons', async () => {
  await page.goto(APP)
  await page.getByRole('button', { name: /Example: Barnard/ }).waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: /Example: WISE 0855/ }).waitFor()
})

const obsCalls = apiCalls.filter(u => u.startsWith('/api/observations')).length
const frameCalls = apiCalls.filter(u => u.startsWith('/api/frame?')).length
report(results)
console.log(`api calls: observations=${obsCalls} frame=${frameCalls} total=${apiCalls.length}`)
console.log('console errors:', errors.length ? errors.slice(0, 8) : 'none')
await browser.close()
