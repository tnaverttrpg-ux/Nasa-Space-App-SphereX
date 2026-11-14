// Non-blocking retry: tabs stay usable, retries survive view switches, progress is inline, toasts sit below the toolbar.
import { chromium } from 'playwright-core'
import { LAUNCH, ORIGIN, report } from './lib.mjs'
const PAGE = `${ORIGIN}/?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12`
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
const done = p => p.waitForFunction(() => /Loaded \d+\/\d+ frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 90000 })
const tabFree = (p, name) => p.evaluate(n => {
  const t = [...document.querySelectorAll('[role="tab"]')].find(e => e.textContent.trim() === n)
  const r = t.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return hit === t || t.contains(hit)
}, name)
// resting position of toasts (after the ~400 ms entrance animation) relative to the toolbar's bottom edge,
// plus: does any toast intercept a toolbar control right now (theme switch, tabs)?
const toastBelowToolbar = async p => { await p.waitForTimeout(700); return p.evaluate(() => {
  const h = document.querySelector('header').getBoundingClientRect().bottom
  return [...document.querySelectorAll('[data-sonner-toast]')].map(t => Math.round(t.getBoundingClientRect().top - h))
}) }
const toolbarCovered = p => p.evaluate(() => [...document.querySelectorAll('header [role="tab"], header input[name="theme"] + svg, header label')]
  .some(el => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit && hit.closest('[data-sonner-toast]') }))
// failing: which frame URLs fail on first load; hold: delay before a retry is served (ms); retryFails: retries also fail
async function setup(ctxOpts, { failing = () => true, hold = 4000, retryFails = false } = {}) {
  const ctx = await b.newContext(ctxOpts); const p = await ctx.newPage()
  const st = { phase: 'initial', reqs: [] }
  await p.route('**/api/frame?*', async r => {
    const u = new URL(r.request().url()).searchParams.get('url')
    if (st.phase === 'initial') return failing(u) ? r.fulfill({ status: 504, json: { detail: 'IRSA cutout request timed out' } }) : r.continue()
    st.reqs.push(u)
    await new Promise(res => setTimeout(res, hold))
    return retryFails ? r.fulfill({ status: 502, json: { detail: 'IRSA cutout service returned HTTP 503' } }) : r.continue().catch(() => {})
  })
  await p.goto(PAGE); await done(p); st.phase = 'retry'
  return { ctx, p, st }
}

for (const scheme of ['dark', 'light']) {
  const T = `[${scheme}]`
  { const { ctx, p, st } = await setup({ colorScheme: scheme, viewport: { width: 1440, height: 900 } })
    await p.getByRole('button', { name: /^Retry failed \(12\)$/ }).click()
    await check(`${T} retry runs in background: inline progress, no blocking toast, tabs clickable`, async () => {
      const prog = await p.getByTestId('retry-progress').innerText({ timeout: 3000 })
      const free = [await tabFree(p, 'Dashboard'), await tabFree(p, 'Viewer')], toasts = await p.locator('[data-sonner-toast]').count()
      const covered = await toolbarCovered(p)
      if (!/Retrying\s+12/.test(prog) || free.includes(false) || covered) throw new Error(JSON.stringify({ prog, free, toasts, covered }))
      return `${prog.replace(/\s+/g, ' ').trim()}; tabs clickable; ${toasts} toast(s) present, none covering the toolbar`
    })
    await check(`${T} Viewer → Dashboard during retry`, async () => {
      await p.getByRole('tab', { name: 'Dashboard' }).click(); await p.getByTestId('dashboard').waitFor({ timeout: 2000 })
      const prog = await p.getByTestId('retry-progress').isVisible(), dl = await p.getByTestId('dash-loaded').innerText()
      if (!prog) throw new Error('retry stopped'); return `dashboard shown; loaded ${dl}; retry still running`
    })
    await check(`${T} Dashboard → Viewer during retry (retry not restarted)`, async () => {
      const before = st.reqs.length
      await p.getByRole('tab', { name: 'Viewer' }).click(); await p.getByRole('region', { name: 'Observation viewer' }).waitFor({ state: 'visible', timeout: 2000 })
      await p.getByRole('tab', { name: 'Dashboard' }).click(); await p.getByRole('tab', { name: 'Viewer' }).click()
      if (st.reqs.length !== before || !(await p.getByTestId('retry-progress').isVisible())) throw new Error(`requests ${before} → ${st.reqs.length}`)
      return `${st.reqs.length} retry requests, unchanged by 3 view switches`
    })
    await check(`${T} retry completes while Dashboard is open`, async () => {
      await p.getByRole('tab', { name: 'Dashboard' }).click()
      await p.getByTestId('retry-progress').waitFor({ state: 'detached', timeout: 30000 })
      const loaded = await p.getByTestId('dash-loaded').innerText(), failed = await p.getByTestId('dash-failed').innerText()
      const off = await toastBelowToolbar(p)
      if (loaded !== '12' || failed !== '0' || off.some(o => o < 0)) throw new Error(JSON.stringify({ loaded, failed, off }))
      return `loaded ${loaded}, failed ${failed}; success toast ${off[0] ?? '-'} px below toolbar; each frame requested once: ${new Set(st.reqs).size === st.reqs.length}`
    })
    await ctx.close() }

  { const { ctx, p } = await setup({ colorScheme: scheme, viewport: { width: 1440, height: 900 } }, { hold: 1500, retryFails: true })
    await check(`${T} retry failure: error toast below toolbar, frames stay failed, tabs usable`, async () => {
      await p.getByRole('button', { name: /^Retry failed \(12\)$/ }).click()
      await p.getByText(/still failing/).waitFor({ timeout: 20000 })
      const off = await toastBelowToolbar(p), free = await tabFree(p, 'Dashboard')
      await p.getByRole('tab', { name: 'Dashboard' }).click(); const f = await p.getByTestId('dash-failed').innerText()
      if (off.some(o => o < 0) || !free || f !== '12' || await p.getByTestId('retry-progress').count()) throw new Error(JSON.stringify({ off, free, f }))
      return `toast ${off.join(',')} px below toolbar; ${f} failed; Retry button available again: ${await p.getByRole('tab', { name: 'Viewer' }).click().then(() => p.getByRole('button', { name: /^Retry failed \(12\)$/ }).isVisible())}`
    })
    await ctx.close() }
}

{ // half the frames load, half fail: loaded frames stay usable during the retry; concurrent retries are deduplicated
  let k = 0; const fails = new Map()
  const { ctx, p, st } = await setup({ viewport: { width: 1440, height: 900 } }, { failing: u => { if (!fails.has(u)) fails.set(u, k++ % 2 === 0); return fails.get(u) }, hold: 5000 })
  await check('loaded observations stay accessible during retry (viewer + dashboard)', async () => {
    await p.getByRole('button', { name: /^Retry failed \(6\)$/ }).click()
    const d0 = await p.getByTestId('frame-date').innerText(); await p.getByRole('button', { name: 'Next frame' }).click()
    const d1 = await p.getByTestId('frame-date').innerText()
    await p.getByRole('tab', { name: 'Dashboard' }).click(); const loaded = await p.getByTestId('dash-loaded').innerText()
    await p.getByRole('tab', { name: 'Viewer' }).click()
    if (d0 === d1 || loaded !== '6') throw new Error(JSON.stringify({ d0, d1, loaded })); return `stepped ${d0.slice(11, 16)} → ${d1.slice(11, 16)} while retrying; dashboard loaded ${loaded}`
  })
  await check('simultaneous retries: a second "retry" of in-flight frames sends no duplicate requests', async () => {
    const n0 = st.reqs.length
    // timeline dots for failed frames are now 'loading'; clicking Retry again (if shown) or a dot must not re-request
    const again = p.getByRole('button', { name: /^Retry failed \(\d+\)$/ })
    if (await again.count()) await again.click()
    await p.getByTestId('retry-progress').waitFor({ state: 'detached', timeout: 30000 })
    const dup = st.reqs.length - new Set(st.reqs).size
    if (dup) throw new Error(`${dup} duplicate requests`); return `${st.reqs.length} retry requests for 6 frames, 0 duplicates (${n0} were in flight)`
  })
  await ctx.close() }

{ const { ctx, p } = await setup({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await check('mobile 390 px: tabs reachable during retry, toast below toolbar, no overflow', async () => {
    await p.getByRole('button', { name: /^Retry failed \(12\)$/ }).click()
    await p.getByTestId('retry-progress').waitFor({ timeout: 3000 })
    await p.evaluate(() => scrollTo(0, 0))
    const free = await tabFree(p, 'Dashboard')
    await p.getByRole('tab', { name: 'Dashboard' }).click(); await p.getByTestId('dashboard').waitFor({ timeout: 2000 })
    await p.getByTestId('retry-progress').waitFor({ state: 'detached', timeout: 30000 })
    const off = await toastBelowToolbar(p), over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    if (!free || off.some(o => o < 0) || over > 0) throw new Error(JSON.stringify({ free, off, over })); return `tabs free; toast ${off.join(',')} px below toolbar; overflow ${over}`
  })
  await ctx.close() }
report(results)
await b.close()
