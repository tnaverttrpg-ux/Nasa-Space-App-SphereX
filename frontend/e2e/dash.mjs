// Observation Intelligence Dashboard: browser checks against independently fetched API values.
import { chromium } from 'playwright-core'
import { APP, LAUNCH, ORIGIN, OUT, report } from './lib.mjs'
const S = OUT
const B = `${ORIGIN}`, RA = 269.44629, DEC = 4.767917, FOV = 0.1, N = 12
const URL = `${APP}?ra=${RA}&dec=${DEC}&fov=${FOV}&band=D6&n=${N}`
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
const loaded = p => p.waitForFunction(() => /Loaded \d+\/\d+ frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 300000 })
const toDash = async p => {
  await p.getByRole('tab', { name: 'Dashboard' }).click(); await p.getByTestId('dashboard').waitFor()
  if (await p.getByRole('region', { name: 'Observation viewer' }).isVisible()) throw new Error('viewer still visible under dashboard')
}
const txt = async (p, id) => (await p.getByTestId(id).innerText()).trim()

// independent expectations from the API
const ctx0 = await b.newContext(); const rq = ctx0.request
const obs = await (await rq.get(`${B}/api/observations?ra=${RA}&dec=${DEC}&band=D6&limit=${N}&fov=${FOV}`)).json()
const metas = []
for (const o of obs.observations) metas.push(await (await rq.get(`${B}/api/frame?url=${encodeURIComponent(o.access_url)}&ra=${RA}&dec=${DEC}&fov=${FOV}`)).json())
await ctx0.close()
const covs = metas.map(m => m.coverage_fraction)
const exp = {
  archive: String(obs.total_in_band), mean: `${(covs.reduce((a, c) => a + c, 0) / covs.length * 100).toFixed(1)}%`,
  min: `${(Math.min(...covs) * 100).toFixed(1)}%`, max: `${(Math.max(...covs) * 100).toFixed(1)}%`,
  l1pass: String(metas.filter(m => m.pipeline_qa?.l1_dqa === 'Pass').length), l2pass: String(metas.filter(m => m.pipeline_qa?.l2_dqa === 'Pass').length),
  sat: String(metas.filter(m => (m.pipeline_qa?.detector_streaks ?? 0) > 0).length),
  field: String(metas.filter(m => (m.pipeline_qa?.field_streak_pixels ?? 0) > 0).length),
}

for (const scheme of ['dark', 'light']) {
  const ctx = await b.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 1000 } })
  const p = await ctx.newPage()
  await p.goto(URL); await loaded(p); await toDash(p)
  await check(`[${scheme}] dashboard replaces the viewer (viewer hidden, restored on Viewer tab)`, async () => {
    const v = await p.getByRole('region', { name: 'Observation viewer' }).isVisible()
    await p.getByRole('tab', { name: 'Viewer' }).click(); const back = await p.getByRole('region', { name: 'Observation viewer' }).isVisible()
    await toDash(p); if (v || !back) throw new Error(`hidden=${!v} restored=${back}`)
  })
  await check(`[${scheme}] loaded vs total counts`, async () => {
    const got = { archive: await txt(p, 'dash-archive'), selected: await txt(p, 'dash-selected'), loaded: await txt(p, 'dash-loaded'), failed: await txt(p, 'dash-failed') }
    if (got.archive !== exp.archive || got.selected !== String(N) || got.loaded !== String(N) || got.failed !== '0') throw new Error(JSON.stringify(got))
    if (!/loaded sample/.test(await txt(p, 'dash-scope'))) throw new Error('scope statement missing')
    return JSON.stringify(got)
  })
  await check(`[${scheme}] coverage mean/min/max match API`, async () => {
    const got = { mean: await txt(p, 'dash-cov-mean'), min: await txt(p, 'dash-cov-min'), max: await txt(p, 'dash-cov-max') }
    for (const k of ['mean', 'min', 'max']) if (got[k] !== exp[k]) throw new Error(`${k}: ${got[k]} vs ${exp[k]}`)
    return JSON.stringify(got)
  })
  await check(`[${scheme}] derived masked share = 1 − coverage − off-detector (tooltip)`, async () => {
    const bar = p.getByTestId('dash-bar').first()
    const key = await bar.getAttribute('data-key'); const m = metas.find(x => x.key === key)
    await bar.hover()
    const t = await p.getByTestId('dash-tip').innerText()
    const want = `${(Math.max(0, 1 - m.coverage_fraction - m.off_detector_fraction) * 100).toFixed(1)}%`
    if (!t.includes(`masked (derived)\n${want}`) && !t.replace(/\s+/g, ' ').includes(`masked (derived) ${want}`)) throw new Error(t)
    return `${m.date_obs.slice(0, 16)}: cov ${m.coverage_fraction}, off ${m.off_detector_fraction} -> ${want}`
  })
  await check(`[${scheme}] QA distribution and streak reporting match API`, async () => {
    const got = { l1pass: await txt(p, 'dash-L1DQAFLG-pass'), l2pass: await txt(p, 'dash-L2DQAFLG-pass'), sat: await txt(p, 'dash-sat'), field: await txt(p, 'dash-field-streak') }
    for (const k in got) if (got[k] !== exp[k]) throw new Error(`${k}: ${got[k]} vs ${exp[k]}`)
    const marks = await p.getByTestId('dash-streak-mark').count()
    if (String(marks) !== exp.sat) throw new Error(`streak marks ${marks} vs ${exp.sat}`)
    return JSON.stringify({ ...got, marks })
  })
  await check(`[${scheme}] timeline click selects frame in viewer + inspector`, async () => {
    const target = metas.find(m => m.date_obs.startsWith('2026-05-05')) ?? metas[3]
    await p.locator(`[data-testid="dash-point"][data-key="${target.key}"]`).click()
    const insp = await p.locator('dt', { hasText: 'Observation ID' }).locator('xpath=following-sibling::dd').innerText()
    await p.getByRole('tab', { name: 'Viewer' }).click()
    const shown = await p.getByTestId('frame-date').innerText()
    if (insp.trim() !== target.obsid || !shown.startsWith(target.date_obs.replace('T', ' ').slice(0, 19))) throw new Error(`${insp} / ${shown}`)
    await toDash(p); return `${target.obsid} → viewer ${shown}`
  })
  await check(`[${scheme}] coverage bar click selects frame; keyboard Enter on timeline point works`, async () => {
    const m = metas[1]
    await p.locator(`[data-testid="dash-bar"][data-key="${m.key}"]`).click()
    const a = (await p.locator('dt', { hasText: 'Observation ID' }).locator('xpath=following-sibling::dd').innerText()).trim()
    const m2 = metas[5]
    await p.locator(`[data-testid="dash-point"][data-key="${m2.key}"]`).focus(); await p.keyboard.press('Enter')
    await p.waitForFunction(id => [...document.querySelectorAll('dt')].find(d => d.textContent.includes('Observation ID'))?.nextElementSibling?.textContent.trim() === id, m2.obsid, { timeout: 5000 }).catch(() => {})
    const c = (await p.locator('dt', { hasText: 'Observation ID' }).locator('xpath=following-sibling::dd').innerText()).trim()
    if (a !== m.obsid || c !== m2.obsid) throw new Error(`${a} vs ${m.obsid}; ${c} vs ${m2.obsid}`)
    return `${a}, ${c}`
  })
  await check(`[${scheme}] hover shows metadata tooltip`, async () => {
    await p.getByTestId('dash-point').nth(2).hover()
    const t = (await p.getByTestId('dash-tip').innerText()).replace(/\s+/g, ' ')
    if (!/QA L1\/L2/.test(t) || !/SATSTRKS \(det\.\)/.test(t)) throw new Error(t); return t.slice(0, 90)
  })
  await check(`[${scheme}] dashboard updates when band changes`, async () => {
    await p.getByRole('tab', { name: 'Viewer' }).click()
    await p.locator('#band').selectOption('D3'); await p.getByRole('button', { name: /Search SPHEREx/ }).click()
    await p.waitForFunction(() => /D3/.test(document.querySelector('[aria-label="Current field"]')?.textContent ?? ''), null, { timeout: 60000 })
    await p.getByRole('tab', { name: 'Dashboard' }).click()
    const a = await txt(p, 'dash-archive'), lbl = await p.getByTestId('dash-archive').locator('xpath=preceding-sibling::div').innerText()
    if (!lbl.includes('D3')) throw new Error(lbl); return `D3 archive ${a}`
  })
  await p.screenshot({ path: `${S}dash-${scheme}.png`, fullPage: true })
  await ctx.close()
}

// loading (nothing loaded yet) and failed frames
{ const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } }); const p = await ctx.newPage()
  await p.route('**/api/frame?*', () => {})              // never answers: frames stay loading/queued
  await p.goto(URL); await p.getByRole('tab', { name: 'Dashboard' }).waitFor({ timeout: 60000 }); await toDash(p)
  await check('loading state: 0 loaded, rest downloading/queued, bars shown as not loaded', async () => {
    const got = { loaded: await txt(p, 'dash-loaded'), queued: await txt(p, 'dash-queued'), downloading: await txt(p, 'dash-downloading'), reading: await txt(p, 'dash-reading') }
    const sum = ['loaded', 'queued', 'downloading', 'reading'].reduce((a, k) => a + Number(got[k]), 0)
    if (got.loaded !== '0' || sum !== Number(await txt(p, 'dash-selected'))) throw new Error('counts do not add up: ' + JSON.stringify(got))
    if (await p.getByTestId('dash-bar').count()) throw new Error('bars drawn for unloaded frames')
    if ((await txt(p, 'dash-cov-mean')) !== '—') throw new Error('mean shown without data')
    return JSON.stringify(got)
  })
  await ctx.close() }
{ const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } }); const p = await ctx.newPage()
  await p.route('**/api/frame?*', r => r.fulfill({ status: 502, json: { detail: 'IRSA cutout failed after 5 attempts (last: 503)' } }))
  await p.goto(URL); await loaded(p); await toDash(p)
  await check('failed frames counted and drawn as failed', async () => {
    const f = await txt(p, 'dash-failed'), pts = await p.locator('[data-testid="dash-point"][data-qa="error"]').count()
    if (f !== String(N) || pts !== N) throw new Error(`${f} failed, ${pts} failed points`); return `${f} failed, ${pts} points`
  })
  await ctx.close() }
{ const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }); const p = await ctx.newPage()
  await p.goto(URL); await loaded(p); await toDash(p)
  await check('mobile 390 px: no horizontal overflow, charts fit', async () => {
    const r = await p.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, svgs: [...document.querySelectorAll('[data-testid="dashboard"] svg')].map(s => Math.round(s.getBoundingClientRect().right)).filter(x => x > innerWidth) }))
    await p.screenshot({ path: `${S}dash-mobile.png`, fullPage: true })
    if (r.over > 0 || r.svgs.length) throw new Error(JSON.stringify(r)); return JSON.stringify(r)
  })
  await ctx.close() }
report(results)
await b.close()
