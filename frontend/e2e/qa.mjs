// Browser checks of the Pipeline QA inspector section across every Barnard D6 frame, both themes.
import { chromium } from 'playwright-core'
import { LAUNCH, ORIGIN, OUT, report } from './lib.mjs'
const S = OUT
const ADV = 'The pipeline reports satellite streak activity. Reported streaks may lie outside this displayed field, and additional unflagged linear trails may remain. Inspect linear residuals across multiple observations before interpreting them as astronomical sources.'
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
for (const scheme of ['dark', 'light']) {
  const p = await (await b.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 1000 } })).newPage()
  await p.goto(`${ORIGIN}/?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12`)
  await p.waitForFunction(() => /Loaded \d+\/\d+ frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 500000 })
  const qa = p.getByRole('region', { name: 'Pipeline QA' })
  const n = Number((await p.getByTestId('frame-date').locator('xpath=following-sibling::div').innerText()).match(/\/(\d+)/)[1])
  // The viewer shows a new frame one render before the side panels follow (App receives it through onSelect).
  // So wait until the panels describe the frame on screen (their DATE-AVG = the viewer's date), then read every
  // value in ONE synchronous snapshot, which cannot straddle a re-render.
  const dd = (root, k) => { let e = [...root.querySelectorAll('dt')].find(d => d.textContent.includes(k))?.nextElementSibling; while (e && e.tagName !== 'DD') e = e.nextElementSibling; return e?.innerText.trim() }
  const settled = () => p.waitForFunction(src => {
    const dd = new Function(`return ${src}`)(), shown = document.querySelector('[data-testid="frame-date"]')?.textContent.slice(0, 19)
    return !!shown && dd(document, 'DATE-AVG') === shown && !!document.querySelector('section[aria-label="Pipeline QA"]')
  }, dd.toString(), { timeout: 30000 })
  const snapshot = () => p.evaluate(src => {
    const dd = new Function(`return ${src}`)(), q = document.querySelector('section[aria-label="Pipeline QA"]')
    return { date: document.querySelector('[data-testid="frame-date"]').textContent.slice(0, 16), l1: dd(q, 'L1DQAFLG'), l2: dd(q, 'L2DQAFLG'),
      sat: dd(q, 'SATSTRKS)'), px: dd(q, 'SATSTRKS_PXS'), field: dd(q, 'STREAK-flagged pixels'), adv: document.querySelectorAll('[data-testid="streak-advisory"]').length }
  }, dd.toString())
  const seen = []
  for (let i = 0; i < n; i++) {
    await settled()
    seen.push(await snapshot())
    if (i < n - 1) await p.getByRole('button', { name: 'Next frame' }).click()
  }
  await check(`[${scheme}] every frame read once, after the panels caught up with the viewer`, async () => {
    if (new Set(seen.map(r => r.date)).size !== n) throw new Error('frames not stepped one by one: ' + seen.map(r => r.date)); return `${n} distinct frames`
  })
  await check(`[${scheme}] advisory shown iff SATSTRKS > 0 (all ${n} frames)`, async () => {
    const bad = seen.filter(r => (Number(r.sat.replace(/,/g, '')) > 0) !== (r.adv === 1))
    if (bad.length) throw new Error(JSON.stringify(bad))
    return `${seen.filter(r => r.adv).length} with advisory, ${seen.filter(r => !r.adv).length} without`
  })
  await check(`[${scheme}] 2026-05-05 frame: Pass/Pass, 1 streak, 3,616 px detector-wide, 0 in field`, async () => {
    const r = seen.find(r => r.date.startsWith('2026-05-05 02:00'))
    if (!r || r.l1 !== 'Pass' || r.l2 !== 'Pass' || r.sat !== '1' || r.px !== '3,616' || r.field !== '0' || r.adv !== 1) throw new Error(JSON.stringify(r))
    return JSON.stringify(r)
  })
  await check(`[${scheme}] advisory text exact; QA-Pass disclaimer present`, async () => {
    await qa.getByText(ADV, { exact: true }).waitFor()
    await qa.getByText(/does not certify the image is free of artefacts/).waitFor()
  })
  await check(`[${scheme}] detector-wide and field counts labelled separately`, async () => {
    await qa.getByText('Whole detector · reported by pipeline').waitFor(); await qa.getByText('Displayed field · from FITS FLAGS').waitFor()
  })
  await qa.screenshot({ path: `${S}qa-${scheme}.png` })
  await check(`[${scheme}] demo frames show no Pipeline QA section`, async () => {
    await p.goto(`${ORIGIN}/?demo=1`); await p.getByText(/DEMO MODE\./).waitFor()
    if (await p.getByRole('region', { name: 'Pipeline QA' }).count()) throw new Error('QA shown for synthetic data')
  })
  await p.close()
}
report(results)
await b.close()
