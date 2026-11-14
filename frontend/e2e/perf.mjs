// Browser checks for loading behaviour: rapid switching, stale responses, cancellation, display-only controls.
import { chromium } from 'playwright-core'
import { LAUNCH, ORIGIN, report } from './lib.mjs'
const BASE = `${ORIGIN}`
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const reqs = []
p.on('request', r => { const u = r.url(); if (u.includes('/api/')) reqs.push(u.replace(BASE, '')) })
const loaded = (t = 400000) => p.waitForFunction(() => /Loaded (\d+)\/\1 frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: t })
const WISE = { ra: 133.795129, dec: -7.245147 }

await check('rapid preset switching ends on the last target with only its frames (no stale overwrite)', async () => {
  // Start on an uncached field (FOV 0.17 → cutouts not on disk) so real IRSA downloads are in flight.
  // fresh, never-cached centre each run (near R Dra) so real IRSA downloads are genuinely in flight
  const ra = (248.167235 + 0.03 + Math.random() * 0.05).toFixed(6)
  await p.goto(`${BASE}/?ra=${ra}&dec=66.755024&fov=0.17&band=D6&n=12`)
  await p.waitForFunction(() => /downloading from IRSA/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 30000 })
  await p.getByRole('button', { name: /^Barnard's Star/ }).first().click()
  await p.waitForTimeout(250)
  await p.getByRole('button', { name: /^WISE 0855/ }).first().click()
  await loaded()
  const field = await p.getByLabel('Current field').innerText()
  if (!field.includes('133.79513')) throw new Error('toolbar field ' + field)
  // Every displayed frame must be a WISE 0855 observation: walk the sequence and compare obs ids with the archive list.
  const obs = await (await p.request.get(`${BASE}/api/observations?ra=${WISE.ra}&dec=${WISE.dec}&band=D6&limit=12&fov=0.17`)).json()
  const ids = new Set(obs.observations.map(o => o.obs_id))
  const seen = []
  const n = Number((await p.getByTestId('frame-date').locator('xpath=following-sibling::div').innerText()).match(/\/(\d+)/)[1])
  for (let i = 0; i < n; i++) {
    seen.push((await p.locator('dt', { hasText: 'Observation ID' }).locator('xpath=following-sibling::dd').innerText()).trim())
    if (i < n - 1) await p.getByRole('button', { name: 'Next frame' }).click()
  }
  const bad = seen.filter(x => !ids.has(x))
  if (bad.length) throw new Error('stale frames from previous target: ' + bad.join(','))
  return `${seen.length} frames, all WISE 0855 observations; field ${field.replace(/\s+/g, ' ')}`
})

await check('display-only controls trigger no archive/frame requests', async () => {
  const before = reqs.length
  await p.getByLabel('Intensity stretch').selectOption('linear'); await p.getByLabel('Colour map').selectOption('gray')
  for (const v of ['3', '6', '9', '1']) await p.getByLabel(/Playback speed/).fill(v)
  for (const v of ['0.3', '0.05', '0.25', '0.12']) await p.locator('#fov').fill(v)        // FOV slider: no fetch until Search
  await p.locator('#nmax').fill('20'); await p.getByLabel('Band').selectOption('D3')
  await p.getByRole('button', { name: 'Previous frame' }).click()  // frame selection uses loaded frames
  await p.getByRole('button', { name: 'Previous frame' }).click()
  await p.waitForTimeout(800)
  const extra = reqs.slice(before)
  const data = extra.filter(u => u.startsWith('/api/observations') || u.startsWith('/api/frame?'))
  const png = extra.filter(u => u.includes('.png'))
  await p.getByLabel('Intensity stretch').selectOption('asinh'); await p.getByLabel('Colour map').selectOption('inferno')
  if (data.length) throw new Error('unexpected data requests: ' + data.join(' '))
  return `0 data requests; ${png.length} PNG re-renders (stretch/colour map only)`
})

await check('progress counts are real: cached vs downloaded reported', async () => {
  await p.goto(`${BASE}/?ra=${WISE.ra}&dec=${WISE.dec}&fov=0.1&band=D6&n=12`)
  await loaded(120000)
  const s = await p.locator('[role="status"]').innerText()
  if (!/from cache/.test(s)) throw new Error(s)
  return s.replace(/\s+/g, ' ')
})
report(results)
await b.close()
