// Browser checks for loading behaviour: rapid switching, stale responses, cancellation, display-only controls.
// The first check needs real IRSA downloads in flight. It reports SKIP (not PASS, not FAIL) only when the request it was
// waiting for came back as a confirmed transient IRSA outage; the other checks use cached data and always count.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { APP, LAUNCH, ORIGIN, report } from './lib.mjs'
const BASE = `${ORIGIN}`
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }

// Backend "detail" texts (backend/app/archive.py via pyvo) that mean a transient IRSA outage: HTTP 502/503/504 or no
// connection at the SIA2 capabilities or query step, the backend's SIA2 timeout, or a cutout still failing after the
// backend's own retries. IRSA 4xx/500, backend errors and non-JSON proxy errors are not confirmed outages.
const SIA2_DOWN = /^IRSA SIA2 query failed: (50[234] Server Error\b|(\w+: )?(HTTPS?ConnectionPool\(.*(Max retries exceeded|timed out)|\('Connection aborted))/
const CAPS_DOWN = /^- \S+: (HTTP Code: 50[234]\b|503 Service Unavailable\b|Connection failed\b|Request timed out\b)/m  // per-URL lines only: pyvo's footer always mentions "503"
const irsaDown = (path, status, detail) => path.startsWith('/api/observations?')
  ? (status === 504 && detail === 'IRSA SIA2 query timed out') || (status === 502 && (SIA2_DOWN.test(detail)
    || (detail.startsWith('IRSA SIA2 query failed: Unable to access the capabilities endpoint') && CAPS_DOWN.test(detail))))
  : path.startsWith('/api/frame?') && [502, 504].includes(status)
    && /^IRSA cutout failed after \d+ attempts \(last: (50[234]|timeout|network error \(\w+\))\)$/.test(detail)
// Self-check on texts the unchanged backend produced against a local fake IRSA (URLs shortened).
const capsErr = line => `IRSA SIA2 query failed: Unable to access the capabilities endpoint at:\n${line}\n\nThis could mean:\n1. The service URL is incorrect\n2. The service is temporarily unavailable\n3. The service doesn't support this protocol\n4. If a 503 was encountered, retry after the suggested delay.\n`
for (const [path, status, detail, down] of [
  ['/api/observations?', 502, 'IRSA SIA2 query failed: 502 Server Error: Bad Gateway for url: https://irsa.ipac.caltech.edu/SIA?POS=CIRCLE+248.2+66.7+0.0005', true],
  ['/api/observations?', 502, 'IRSA SIA2 query failed: 503 Server Error: Service Unavailable for url: https://irsa.ipac.caltech.edu/SIA?POS=CIRCLE', true],
  ['/api/observations?', 502, capsErr('- https://irsa.ipac.caltech.edu/SIA/capabilities: HTTP Code: 502 Bad Gateway Response body: <html>error</html>'), true],
  ['/api/observations?', 502, capsErr('- https://irsa.ipac.caltech.edu/SIA/capabilities: 503 Service Unavailable (Retry-After: 5)\n- https://irsa.ipac.caltech.edu/capabilities: 404 Not Found'), true],
  ['/api/observations?', 502, capsErr('- https://irsa.ipac.caltech.edu/SIA/capabilities: Connection failed (Possible causes: incorrect URL, DNS issue, or service is down)'), true],
  ['/api/observations?', 502, "IRSA SIA2 query failed: ConnectionError: HTTPSConnectionPool(host='irsa.ipac.caltech.edu', port=443): Max retries exceeded with url: /SIA?POS=CIRCLE (Caused by NewConnectionError(...))", true],
  ['/api/observations?', 504, 'IRSA SIA2 query timed out', true],
  ['/api/frame?', 502, 'IRSA cutout failed after 5 attempts (last: 503)', true],
  ['/api/frame?', 502, 'IRSA cutout failed after 5 attempts (last: network error (ConnectError))', true],
  ['/api/observations?', 502, capsErr('- https://irsa.ipac.caltech.edu/SIA/capabilities: 404 Not Found\n- https://irsa.ipac.caltech.edu/capabilities: 404 Not Found'), false],
  ['/api/observations?', 502, 'IRSA SIA2 query failed: 500 Server Error: Internal Server Error for url: https://irsa.ipac.caltech.edu/SIA?POS=CIRCLE', false],
  ['/api/observations?', 502, "IRSA SIA2 query failed: KeyError: 's_region'", false],
  ['/api/frame?', 502, 'IRSA cutout failed after 5 attempts (last: 500)', false],
  ['/api/frame?', 404, 'IRSA cutout service returned HTTP 404', false],
]) assert.equal(irsaDown(path, status, detail), down, detail)

const b = await chromium.launch(LAUNCH)
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const reqs = []
p.on('request', r => { const u = r.url(); if (u.includes('/api/')) reqs.push(u.replace(BASE, '')) })
const failures = []   // [path, status, detail] promises for every /api/ response >= 500, in arrival order
p.on('response', r => {
  if (r.url().includes('/api/') && r.status() >= 500) failures.push(r.json().catch(() => ({})).then(j => [r.url().replace(BASE, ''), r.status(), String(j?.detail ?? '')]))
})
const loaded = (t = 400000) => p.waitForFunction(() => /Loaded (\d+)\/\1 frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: t })
const WISE = { ra: 133.795129, dec: -7.245147 }
const raIs = ra => u => Math.abs(Number(new URLSearchParams(u.split('?')[1]).get('ra')) - ra) < 1e-6

// A check that depends on live IRSA. fn receives waitingFor(pred): the requests the next step depends on, or null once
// only the app is being tested. A failure is SKIP only if one of those requests returned a confirmed IRSA outage.
const live = async (name, fn) => {
  const from = failures.length
  let waitingFor = null
  try { results.push(['PASS', name, (await fn(pred => { waitingFor = pred })) ?? '']) } catch (e) {
    const hit = waitingFor && (await Promise.all(failures.slice(from))).find(([u, s, d]) => waitingFor(u) && irsaDown(u, s, d))
    const why = hit && (hit[2].split('\n').find(l => CAPS_DOWN.test(l))?.slice(2) ?? hit[2].split('\n')[0]).slice(0, 160)
    results.push(hit ? ['SKIP', name, `IRSA unavailable (external): ${hit[0].split('?')[0]} returned HTTP ${hit[1]} (${why})`]
      : ['FAIL', name, String(e.message).split('\n')[0]])
  }
}

await live('live IRSA integration: rapid preset switching during real downloads ends on the last target with only its frames (no stale overwrite)', async waitingFor => {
  // fresh, never-cached centre each run (near R Dra, FOV 0.17) so real IRSA downloads are genuinely in flight
  const ra = (248.167235 + 0.03 + Math.random() * 0.05).toFixed(6)
  waitingFor(u => u.startsWith('/api/observations?') && raIs(Number(ra))(u))
  await p.goto(`${APP}?ra=${ra}&dec=66.755024&fov=0.17&band=D6&n=12`)
  const st = await p.waitForFunction(() => /downloading from IRSA|Archive request failed/.exec(document.querySelector('[role="status"]')?.textContent ?? '')?.[0], null, { timeout: 30000 })
  if (await st.jsonValue() !== 'downloading from IRSA') throw new Error(`archive search failed: ${await p.locator('section[role="alert"] p').innerText()}`)
  waitingFor(raIs(WISE.ra))   // the switch waits on the WISE 0855 search and frames (cached unless the cache is cold)
  await p.getByRole('button', { name: /^Barnard's Star/ }).first().click()
  await p.waitForTimeout(250)
  await p.getByRole('button', { name: /^WISE 0855/ }).first().click()
  await loaded()
  waitingFor(null)   // from here on every failure is the app's
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
  await p.goto(`${APP}?ra=${WISE.ra}&dec=${WISE.dec}&fov=0.17&band=D6&n=12`)   // own cached start: independent of the live check
  await loaded(120000)
  for (let i = 0; i < 2; i++) await p.getByRole('button', { name: 'Next frame' }).click()   // "Previous frame" is disabled on frame 1
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
  await p.goto(`${APP}?ra=${WISE.ra}&dec=${WISE.dec}&fov=0.1&band=D6&n=12`)
  await loaded(120000)
  const s = await p.locator('[role="status"]').innerText()
  if (!/from cache/.test(s)) throw new Error(s)
  return s.replace(/\s+/g, ' ')
})
report(results)
await b.close()
