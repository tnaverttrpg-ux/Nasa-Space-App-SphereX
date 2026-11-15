import { chromium } from 'playwright-core'
import { APP, LAUNCH, OUT, report } from './lib.mjs'
const S = OUT
const BASE = `${APP}?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12`
const DARK_BG = 'rgb(23, 25, 26)', LIGHT_BG = 'rgb(214, 215, 211)'
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
const state = p => p.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, saved: localStorage.getItem('spheretrack-theme'),
  checked: document.querySelector('input[name="theme"]:checked')?.value }))
const expect = (s, theme, bg, saved, checked) => {
  if (s.theme !== theme || s.bg !== bg || s.saved !== saved || s.checked !== checked) throw new Error(JSON.stringify(s))
  return JSON.stringify(s)
}
const ctxFor = scheme => b.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 900 } })

await check('1. System + OS dark → Graphite Dark', async () => {
  const c = await ctxFor('dark'); const p = await c.newPage(); await p.goto(BASE); await p.waitForSelector('input[name="theme"]')
  const r = expect(await state(p), 'dark', DARK_BG, null, 'system'); await c.close(); return r
})
await check('2. System + OS light → Muted Grey Light', async () => {
  const c = await ctxFor('light'); const p = await c.newPage(); await p.goto(BASE); await p.waitForSelector('input[name="theme"]')
  const r = expect(await state(p), 'light', LIGHT_BG, null, 'system'); await c.close(); return r
})
await check('no flash: theme set by inline script before app JS runs', async () => {
  const c = await ctxFor('light'); const p = await c.newPage()
  await c.addInitScript(() => localStorage.setItem('spheretrack-theme', 'dark'))
  await p.route('**/src/main.tsx', r => r.abort())  // block React entirely
  await p.goto(BASE)
  const s = await p.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }))
  await c.close()
  if (s.theme !== 'dark') throw new Error(JSON.stringify(s))
  return `without React: data-theme=${s.theme}`
})

const c = await ctxFor('dark'); const p = await c.newPage(); await p.goto(BASE)
await p.waitForFunction(() => /Loaded (\d+)\/\1/.test(document.body.innerText), null, { timeout: 120000 })
const bar = () => p.evaluate(() => { const h = document.querySelector('header').getBoundingClientRect(); const f = document.querySelector('figure').getBoundingClientRect(); return `${h.height}|${f.width}|${f.left}` })
const bar0 = await bar()
await p.screenshot({ path: S + 'th-dark.png' })

await check('3. Manual Light override (OS dark)', async () => {
  await p.locator('label[title="Theme: Light"]').click(); return expect(await state(p), 'light', LIGHT_BG, 'light', 'light')
})
await check('no layout shift on theme change', async () => { const b1 = await bar(); if (b1 !== bar0) throw new Error(`${bar0} vs ${b1}`); return b1 })
await p.screenshot({ path: S + 'th-light.png' })
await check('4. Manual Dark override', async () => { await p.locator('label[title="Theme: Dark"]').click(); return expect(await state(p), 'dark', DARK_BG, 'dark', 'dark') })
await check('6. Reload with saved manual preference (Light, OS dark)', async () => {
  await p.locator('label[title="Theme: Light"]').click(); await p.reload(); await p.waitForSelector('input[name="theme"]')
  return expect(await state(p), 'light', LIGHT_BG, 'light', 'light')
})
await check('OS change while manual override → override kept', async () => {
  await p.emulateMedia({ colorScheme: 'light' }); await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(100)
  return expect(await state(p), 'light', LIGHT_BG, 'light', 'light')
})
await check('5. Switch back to System → override removed, follows OS (dark)', async () => {
  await p.locator('label[title="Theme: System"]').click(); return expect(await state(p), 'dark', DARK_BG, null, 'system')
})
await check('7. OS preference changes while System active → live update', async () => {
  await p.emulateMedia({ colorScheme: 'light' }); await p.waitForTimeout(100)
  const a = expect(await state(p), 'light', LIGHT_BG, null, 'system')
  await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(100)
  return a + ' → ' + expect(await state(p), 'dark', DARK_BG, null, 'system')
})
await check('keyboard: arrow keys move theme selection', async () => {
  await p.getByLabel('System theme').focus(); await p.keyboard.press('ArrowRight')
  const s = await state(p); await p.locator('label[title="Theme: System"]').click()
  if (s.checked !== 'dark') throw new Error(JSON.stringify(s)); return 'System → Dark via ArrowRight'
})
await check('science image untouched in light theme (no filter, black well)', async () => {
  await p.locator('label[title="Theme: Light"]').click()
  const r = await p.evaluate(() => { const i = document.querySelector('figure img'); return { filter: getComputedStyle(i).filter, mix: getComputedStyle(i).mixBlendMode, well: getComputedStyle(i.closest('.aspect-square')).backgroundColor } })
  await p.locator('label[title="Theme: System"]').click()
  if (r.filter !== 'none' || r.mix !== 'normal' || r.well !== 'rgb(0, 0, 0)') throw new Error(JSON.stringify(r)); return JSON.stringify(r)
})
await check('toast + tooltip follow theme (light)', async () => {
  await p.locator('label[title="Theme: Light"]').click()
  await p.getByRole('button', { name: /^About Right Ascension/ }).focus()
  const tip = await p.getByRole('tooltip').first().evaluate(e => getComputedStyle(e).backgroundColor)
  await p.locator('label[title="Theme: System"]').click()
  if (tip !== 'rgb(240, 240, 235)') throw new Error('tooltip bg ' + tip); return `tooltip ${tip}`
})
// Light-theme screenshots of diff + mobile for visual review
await p.locator('label[title="Theme: Light"]').click()
await p.getByRole('tab', { name: 'Difference' }).click(); await p.getByRole('button', { name: /^Candidate 1,/ }).click()
await p.screenshot({ path: S + 'th-light-diff.png' })
await p.locator('label[title="Theme: Dark"]').click(); await p.screenshot({ path: S + 'th-dark-diff.png' })
await p.locator('label[title="Theme: System"]').click()
await c.close()
const m = await (await b.newContext({ colorScheme: 'light', viewport: { width: 390, height: 844 }, isMobile: true })).newPage()
await m.goto(BASE.replace('n=12', 'n=8')); await m.waitForFunction(() => /Loaded (\d+)\/\1/.test(document.body.innerText), null, { timeout: 120000 })
await check('mobile 390 light: no horizontal overflow, selector visible', async () => {
  const o = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth); const v = await m.getByLabel('Light theme').isVisible({ timeout: 1000 }).catch(() => false)
  await m.screenshot({ path: S + 'th-mobile-light.png' })
  if (o > 0) throw new Error('overflow ' + o)
  if (!v) throw new Error('theme selector not visible')   // was computed but never asserted (found by lint)
  return `overflow 0, selector in toolbar`
})
report(results)
await b.close()
