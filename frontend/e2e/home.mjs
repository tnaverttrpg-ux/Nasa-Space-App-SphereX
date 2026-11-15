// Public homepage + routing: rendering, hero provenance, screenshot lightbox, navigation into the Explorer, shared-URL
// compatibility, first-use guide, themes, mobile, reduced motion, accessibility basics, and no archive traffic.
import { chromium } from 'playwright-core'
import { APP, LAUNCH, ORIGIN, OUT, report } from './lib.mjs'

const BARNARD = 'ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12'
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
const loaded = p => p.waitForFunction(() => /Loaded (\d+)\/\1 frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 300000 })
const API = /irsa|caltech|esa\.int|g-vo|unistra/   // archive/catalogue hosts
const jump = (p, y) => p.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), y)   // the page scrolls smoothly; tests jump
// WCAG relative-luminance contrast of an element's text against its first opaque ancestor background
const contrast = (p, sel) => p.evaluate(sel => {
  const rgb = s => s.match(/[\d.]+/g).map(Number)
  const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const e = document.querySelector(sel); let bg = null
  for (let n = e; n && !bg; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length < 4 || c[3] === 1) if (c.length === 3 || c[3] === 1) bg = c.slice(0, 3) }
  const [a, z] = [lum(rgb(getComputedStyle(e).color).slice(0, 3)), lum(bg ?? [255, 255, 255])].sort((x, y) => y - x)
  return (a + 0.05) / (z + 0.05)
}, sel)

for (const scheme of ['dark', 'light']) {
  const T = `[${scheme}]`
  const ctx = await b.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  const traffic = []; p.on('request', r => traffic.push(r.url()))
  await p.goto(ORIGIN + '/'); await p.waitForLoadState('networkidle')

  await check(`${T} homepage renders: headline, description, both calls to action, real hero image with provenance`, async () => {
    const h1 = await p.getByRole('heading', { level: 1 }).innerText()
    const hero = await p.locator('#main img').first().evaluate(i => ({ w: i.naturalWidth, alt: i.alt, src: i.getAttribute('src') }))
    const cap = await p.locator('#main figcaption').first().innerText()
    const launch = await p.getByRole('link', { name: 'Launch Explorer' }).first().getAttribute('href')
    await p.getByRole('link', { name: 'Discover how it works' }).waitFor()
    if (h1 !== 'Explore the changing infrared sky.' || hero.w !== 293 || !/Barnard/.test(hero.alt) || !/2025W33_2C_0321_1/.test(cap) || !/SPHEREx DR1, NASA\/IPAC IRSA/.test(cap) || launch !== '/explorer')
      throw new Error(JSON.stringify({ h1, hero, cap: cap.slice(0, 80), launch }))
    return `${hero.src} (${hero.w} px, pixelated) · caption names observation, date, λ, field and renderer`
  })
  await check(`${T} sections present: how it works (3 steps), 6 features, investigation, science, footer disclaimer`, async () => {
    const steps = await p.locator('#how ol > li').count(), feats = await p.locator('#features figure').count()
    const inv = await p.locator('#investigation').innerText(), foot = await p.locator('footer').innerText()
    if (steps !== 3 || feats !== 6 || !/not.*been matched to any catalogued satellite/s.test(inv) || !/not endorsed by, sponsored by or affiliated with NASA/.test(foot) || !/to be added by the team/.test(foot))
      throw new Error(JSON.stringify({ steps, feats })); return '3 steps, 6 features, identity not claimed, non-endorsement, team placeholder'
  })
  await check(`${T} no archive or API traffic from the homepage, even after scrolling everything into view`, async () => {
    for (let y = 0; y < 8000; y += 500) { await jump(p, y); await p.waitForTimeout(60) }
    await p.waitForLoadState('networkidle')
    const api = traffic.filter(u => u.includes('/api/') || /irsa|caltech|esa\.int|g-vo|unistra/.test(u))
    if (api.length) throw new Error(api.join(', ')); return `${traffic.length} requests, all static assets/fonts; 0 to /api or archives`
  })
  await check(`${T} lazy media: below-the-fold images deferred, then all load when scrolled to`, async () => {
    const r = await p.evaluate(() => [...document.querySelectorAll('#main img')].map(i => ({ lazy: i.loading === 'lazy', ok: i.complete && i.naturalWidth > 0, src: i.getAttribute('src') })))
    const lazy = r.filter(x => x.lazy)
    if (lazy.length !== 8 || !r.every(x => x.ok)) throw new Error(JSON.stringify(r.filter(x => !x.ok))); return `${lazy.length} lazy (6 screenshots + 2 investigation frames), all loaded after scrolling`
  })
  await check(`${T} "Discover how it works" scrolls to the steps; header stays at the top`, async () => {
    await jump(p, 0); await p.getByRole('link', { name: 'Discover how it works' }).click()
    await p.waitForFunction(() => { const r = document.getElementById('how').getBoundingClientRect(); return r.top >= 0 && r.top < 120 }, null, { timeout: 5000 })
    const head = await p.locator('header').first().boundingBox()
    if (!p.url().endsWith('#how') || head.y !== 0) throw new Error(`${p.url()} header y ${head.y}`); return 'anchor #how in view, sticky header at y = 0'
  })
  await check(`${T} contrast ≥ 4.5:1 for body, captions, eyebrow, links and both buttons`, async () => {
    const sels = { 'body text': '#main p.text-ink-2', caption: '#main figcaption', eyebrow: '#main p.font-mono', 'primary button': '#main a.bg-cta', 'secondary button': 'a[href="#how"].border', 'footer text': 'footer p.text-ink-2', 'header link': 'nav a' }
    const out = {}; for (const [k, s] of Object.entries(sels)) out[k] = +(await contrast(p, s)).toFixed(2)
    const low = Object.entries(out).filter(([, v]) => v < 4.5)
    if (low.length) throw new Error(JSON.stringify(out)); return Object.entries(out).map(([k, v]) => `${k} ${v}`).join(', ')
  })
  await check(`${T} hero caption is compact; secondary provenance sits in a keyboard-operable disclosure`, async () => {
    await jump(p, 0)
    const cap = (await p.getByTestId('hero-caption').innerText()).replace(/\s+/g, ' ')
    const need = ['Barnard’s Star', '2025W33_2C_0321_1', '2025-08-15 20:46 UTC', 'detector D6', 'λ 4.923 µm at target', '0.5° × 0.5° field', 'SPHEREx DR1', 'NASA/IPAC IRSA']
    const missing = need.filter(x => !cap.includes(x))
    const prov = p.getByTestId('hero-provenance'), summary = p.locator('#main figure').first().locator('summary')
    const hiddenBefore = !(await prov.isVisible())
    await summary.focus(); await p.keyboard.press('Enter')
    const shown = (await prov.innerText()).replace(/\s+/g, ' ')
    const detail = ['RA 269.44629°, Dec +4.76792° (ICRS)', '6.15″', 'north up, east left', 'asinh stretch', 'masked by the FITS quality flags', 'pipeline version 7.0.5', 'DATE-AVG 2025-08-15T20:46:08']
    const missingDetail = detail.filter(x => !shown.includes(x))
    await p.keyboard.press('Enter'); const hiddenAfter = !(await prov.isVisible())
    if (missing.length || cap.length > 160 || /RA 269/.test(cap) || !hiddenBefore || missingDetail.length || !hiddenAfter)
      throw new Error(JSON.stringify({ missing, len: cap.length, hiddenBefore, missingDetail, hiddenAfter }))
    return `${cap.length} visible characters; Enter on "Full provenance" reveals coordinates, grid, orientation, rendering and pipeline; Enter hides them`
  })
  await check(`${T} "See the Barnard’s Star investigation": small link under the hero actions, opens the investigation`, async () => {
    await jump(p, 0)
    const link = p.locator('section[aria-labelledby="hero-title"]').getByRole('link', { name: /See the Barnard.s Star investigation/ })
    const href = await link.getAttribute('href'), lb = await link.boundingBox(), bb = await p.getByRole('link', { name: 'Discover how it works' }).boundingBox()
    await link.click()
    await p.waitForFunction(() => { const r = document.getElementById('investigation').getBoundingClientRect(); return r.top >= 0 && r.top < 120 }, null, { timeout: 5000 })
    if (href !== '#investigation' || !(lb.y >= bb.y + bb.height) || lb.height > 30 || !p.url().endsWith('#investigation')) throw new Error(JSON.stringify({ href, lb, bb, url: p.url() }))
    return `text link ${Math.round(lb.height)} px tall below the buttons → #investigation in view`
  })
  await check(`${T} investigation wording: measured displacement and exposure, no categorical asteroid claim`, async () => {
    const inv = (await p.locator('#investigation').innerText()).replace(/\s+/g, ' ')
    const need = ['about 2.1° of sky', 'about 1,250 detector pixels, both ends inside the detector', 'one exposure of about 115 seconds', '01:59:29–02:01:24 UTC',
      'TRANSIENT on 16%', 'HALO on 50%', '0.6% and 1.1%', 'second, separate detector', 'Pass / Pass', '1 · 3,616 px', 'not been matched to any catalogued satellite', 'does not identify the object']
    const missing = need.filter(x => !inv.includes(x))
    if (missing.length || /any asteroid/i.test(inv)) throw new Error(JSON.stringify({ missing, asteroidClaim: /any asteroid/i.test(inv) }))
    return 'about 2.1° within one ~115 s exposure; flags, cross-detector evidence and QA kept; no "faster than any asteroid"'
  })
  await check(`${T} screenshot lightbox: all 6 open enlarged (same image, aspect kept, themed), Escape closes and returns focus`, async () => {
    await jump(p, 0)
    const shots = p.getByTestId('shot'), n = await shots.count(), out = []
    const panelBg = await p.evaluate(() => { const d = document.createElement('div'); d.className = 'bg-panel'; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c })
    for (let i = 0; i < n; i++) {
      const s = shots.nth(i), id = await s.getAttribute('data-id'), thumbAlt = await s.locator('img').getAttribute('alt')
      await s.scrollIntoViewIfNeeded(); await s.click()
      await p.locator('dialog[open] img').waitFor(); await p.waitForFunction(() => document.querySelector('dialog[open] img')?.complete)
      const r = await p.evaluate(() => {
        const d = document.querySelector('dialog[open]'), im = d.querySelector('img'), b = im.getBoundingClientRect()
        return { modal: d.matches(':modal'), src: im.getAttribute('src'), alt: im.alt, ratio: b.width / b.height, natural: im.naturalWidth / im.naturalHeight, natW: im.naturalWidth,
          focus: d.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null, bg: getComputedStyle(d).backgroundColor,
          locked: document.documentElement.style.overflow, inView: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight }
      })
      // the page releases its scroll lock in the dialog's "close" event, which fires just after `open` is removed: wait for both
      await p.keyboard.press('Escape')
      const released = await p.waitForFunction(() => !document.querySelector('dialog[open]') && document.documentElement.style.overflow === '', null, { timeout: 3000 }).then(() => true, () => false)
      const back = await p.evaluate(() => ({ id: document.activeElement?.dataset.id }))
      if (!r.modal || r.src !== `/media/screens/${id}.webp` || r.alt !== thumbAlt || r.alt.length < 60 || Math.abs(r.ratio / r.natural - 1) > 0.01 || r.natW !== 1200
        || r.focus !== 'Close enlarged screenshot' || r.bg !== panelBg || r.locked !== 'hidden' || !r.inView || !released || back.id !== id)
        throw new Error(JSON.stringify({ id, r, back, panelBg }))
      out.push(`${id} ${r.ratio.toFixed(3)}`)
    }
    if (n !== 6) throw new Error(`${n} screenshots`)
    return `6/6 modal, themed (${panelBg}); aspect ${out.join(', ')}; focus on Close, page scroll locked, Escape restores focus`
  })
  await check(`${T} lightbox keyboard and pointer: Enter and Space open, focus stays inside, Close and backdrop close; still no archive traffic`, async () => {
    const s = p.getByTestId('shot').first(); await s.scrollIntoViewIfNeeded()
    await s.focus(); await p.keyboard.press('Enter'); await p.locator('dialog[open] img').waitFor()
    const trapped = []
    for (let k = 0; k < 4; k++) { await p.keyboard.press('Tab'); trapped.push(await p.evaluate(() => document.activeElement === document.body || !!document.querySelector('dialog[open]')?.contains(document.activeElement))) }
    await p.getByRole('button', { name: 'Close enlarged screenshot' }).click()
    const byButton = await p.evaluate(() => !document.querySelector('dialog[open]'))
    await s.focus(); await p.keyboard.press('Space'); await p.locator('dialog[open] img').waitFor()
    await p.mouse.click(8, 8)   // outside the dialog box: the backdrop
    const byBackdrop = await p.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 3000 }).then(() => true, () => false)
    // close and reopen the same screenshot in one task: the dialog's late, asynchronous "close" event must not undo the reopen
    await s.click(); await p.locator('dialog[open] img').waitFor()
    const reopen = await p.evaluate(() => new Promise(res => {
      const d = document.querySelector('dialog')
      d.addEventListener('close', () => requestAnimationFrame(() => res(d.open && !!d.querySelector('img') && document.documentElement.style.overflow === 'hidden')), { once: true })
      d.querySelector('[aria-label="Close enlarged screenshot"]').click(); document.querySelector('[data-testid="shot"]').click()
    }))
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog[open]') && document.documentElement.style.overflow === '')
    const api = traffic.filter(u => u.includes('/api/') || API.test(u))
    if (trapped.includes(false) || !byButton || !byBackdrop || !reopen || api.length) throw new Error(JSON.stringify({ trapped, byButton, byBackdrop, reopen, api }))
    return 'Enter and Space open it; Tab never reaches the page behind; Close and backdrop close it; an immediate reopen stays open; 0 archive/API requests'
  })
  await check(`${T} theme follows the system and the manual choice carries into the Explorer`, async () => {
    const theme = await p.evaluate(() => document.documentElement.dataset.theme)
    const other = scheme === 'dark' ? 'Light' : 'Dark'
    await p.getByRole('radio', { name: `${other} theme` }).check({ force: true })
    const after = await p.evaluate(() => document.documentElement.dataset.theme)
    await p.goto(APP); const inExplorer = await p.evaluate(() => document.documentElement.dataset.theme)
    await p.getByRole('radio', { name: 'System theme' }).check({ force: true })
    if (theme !== scheme || after !== other.toLowerCase() || inExplorer !== after) throw new Error(JSON.stringify({ theme, after, inExplorer }))
    return `system ${theme} → manual ${after} → Explorer ${inExplorer}`
  })
  await p.screenshot({ path: `${OUT}home-${scheme}.png` })
  await ctx.close()
}

{ const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage()
  const api = []; p.on('request', r => { if (r.url().includes('/api/')) api.push(new URL(r.url()).pathname) })
  await p.goto(ORIGIN + '/')
  await check('Launch Explorer opens /explorer in its start state (guide shown, no search started)', async () => {
    await p.getByRole('link', { name: 'Launch Explorer' }).first().click(); await p.waitForURL('**/explorer')
    await p.getByRole('heading', { name: 'Quick guide' }).waitFor({ timeout: 15000 })
    await p.getByText('SPHERE TRACK', { exact: true }).waitFor()
    await p.waitForTimeout(1000)
    const searches = api.filter(u => /observations|frame/.test(u))
    if (searches.length) throw new Error(searches.join(', ')); return `requests: ${[...new Set(api)].join(', ') || 'none'} (presets only, no archive search)`
  })
  await check('guide: dismiss is remembered across reloads; the Guide button reopens it', async () => {
    await p.getByRole('button', { name: 'Got it' }).click()
    await p.reload(); await p.getByRole('button', { name: /Search SPHEREx/ }).waitFor()
    const after = await p.getByRole('heading', { name: 'Quick guide' }).count()
    await p.getByRole('button', { name: 'Guide' }).click(); const reopened = await p.getByRole('heading', { name: 'Quick guide' }).isVisible()
    const expanded = await p.getByRole('button', { name: 'Guide' }).getAttribute('aria-expanded')
    if (after !== 0 || !reopened || expanded !== 'true') throw new Error(JSON.stringify({ after, reopened, expanded })); return 'hidden after reload; reopens on demand (aria-expanded)'
  })
  await check('Explorer brand links back to the homepage', async () => {
    await p.getByTitle('SPHERE TRACK home page').click(); await p.waitForURL(ORIGIN + '/')
    await p.getByRole('heading', { name: 'Explore the changing infrared sky.' }).waitFor(); return new URL(p.url()).pathname
  })
  await ctx.close() }

{ const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage()
  await check('legacy shared link /?ra=…&dec=… opens the Explorer with the original selection', async () => {
    await p.goto(`${ORIGIN}/?${BARNARD}`); await loaded(p)
    const u = new URL(p.url()), field = (await p.getByLabel('Current field').innerText()).replace(/\s+/g, ' ')
    if (u.pathname !== '/explorer' || u.search !== `?${BARNARD}` || !/269\.44629 \+4\.76792 6\.0′ · D6/.test(field) || await p.getByRole('heading', { name: 'Quick guide' }).count())
      throw new Error(`${p.url()} | ${field}`); return `${u.pathname}${u.search} → ${field} (no guide over a shared view)`
  })
  await check('legacy demo link /?demo=1 opens the Explorer in labelled demo mode', async () => {
    await p.goto(`${ORIGIN}/?demo=1`); await p.getByText(/DEMO MODE\./).waitFor({ timeout: 30000 })
    if (new URL(p.url()).pathname !== '/explorer') throw new Error(p.url()); return p.url().replace(ORIGIN, '')
  })
  await check('direct /explorer?… link loads and keeps its URL; refresh restores it', async () => {
    await p.goto(`${APP}?${BARNARD}`); await loaded(p); await p.reload(); await loaded(p)
    if (p.url() !== `${APP}?${BARNARD}`) throw new Error(p.url()); return p.url().replace(ORIGIN, '')
  })
  await check('unknown paths show the homepage instead of a blank page', async () => {
    await p.goto(`${ORIGIN}/no-such-page`); await p.getByRole('heading', { level: 1 }).waitFor()
    return await p.getByRole('heading', { level: 1 }).innerText()
  })
  await ctx.close() }

{ const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage()
  await p.goto(ORIGIN + '/')
  await check('accessibility basics: one h1, no skipped heading levels, landmarks, alt text, skip link first', async () => {
    const r = await p.evaluate(() => {
      const levels = [...document.querySelectorAll('h1,h2,h3,h4')].map(h => +h.tagName[1])
      return { h1: levels.filter(l => l === 1).length, skips: levels.filter((l, i) => i && l - levels[i - 1] > 1).length,
        landmarks: ['header', 'main', 'footer', 'nav'].filter(t => document.querySelector(t)).length,
        noAlt: [...document.images].filter(i => !i.hasAttribute('alt')).length,
        contentImgsWithoutText: [...document.querySelectorAll('#main img')].filter(i => !i.alt.trim()).length }
    })
    await p.keyboard.press('Tab'); const first = await p.evaluate(() => document.activeElement?.textContent)
    await p.keyboard.press('Enter'); const hash = new URL(p.url()).hash
    if (r.h1 !== 1 || r.skips || r.landmarks !== 4 || r.noAlt || r.contentImgsWithoutText || first !== 'Skip to content' || hash !== '#main') throw new Error(JSON.stringify({ ...r, first, hash }))
    return `1 h1, no skipped levels, 4 landmarks, every image has alt; Tab → "${first}" → ${hash}`
  })
  await check('keyboard: Launch Explorer reachable by Tab and activates with Enter', async () => {
    await p.goto(ORIGIN + '/'); let found = false
    for (let i = 0; i < 15 && !found; i++) { await p.keyboard.press('Tab'); found = await p.evaluate(() => document.activeElement?.textContent?.trim() === 'Launch Explorer') }
    if (!found) throw new Error('not reached'); await p.keyboard.press('Enter'); await p.waitForURL('**/explorer'); return 'focus ring on the button, Enter opens /explorer'
  })
  await ctx.close() }

{ const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage()
  await check('smooth scrolling is homepage-only: the Explorer keeps instant programmatic scrolling', async () => {
    await p.goto(ORIGIN + '/'); const home = await p.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)
    await p.goto(APP); await p.getByRole('button', { name: /Search SPHEREx/ }).waitFor()
    const app = await p.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)
    if (home !== 'smooth' || app !== 'auto') throw new Error(JSON.stringify({ home, app })); return `homepage ${home}, Explorer ${app}`
  })
  await ctx.close() }

{ const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }); const p = await ctx.newPage()
  await p.goto(ORIGIN + '/')
  await check('reduced motion: no entrance animation and no smooth scrolling', async () => {
    const r = await p.evaluate(() => ({ anim: getComputedStyle(document.querySelector('.fade-up')).animationName, scroll: getComputedStyle(document.documentElement).scrollBehavior }))
    if (r.anim !== 'none' || r.scroll !== 'auto') throw new Error(JSON.stringify(r)); return JSON.stringify(r)
  })
  await ctx.close() }

{ const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const p = await ctx.newPage()
  await p.goto(ORIGIN + '/'); await p.waitForLoadState('networkidle')
  await check('mobile 390 px: no horizontal overflow, readable headline, large tap targets, hero image fits', async () => {
    for (let y = 0; y < 12000; y += 700) await jump(p, y)
    await jump(p, 0)
    const r = await p.evaluate(() => {
      const btn = [...document.querySelectorAll('#main a')].find(a => a.textContent.trim() === 'Launch Explorer').getBoundingClientRect()
      const img = document.querySelector('#main img').getBoundingClientRect()
      return { over: document.documentElement.scrollWidth - innerWidth, h1: parseFloat(getComputedStyle(document.querySelector('h1')).fontSize), btnH: btn.height, imgR: img.right }
    })
    await p.screenshot({ path: `${OUT}home-mobile.png`, fullPage: false })
    if (r.over > 0 || r.h1 < 32 || r.btnH < 44 || r.imgR > 390) throw new Error(JSON.stringify(r)); return `overflow 0, h1 ${r.h1}px, button ${r.btnH}px tall`
  })
  await check('mobile 390 px: screenshot lightbox fits the screen, 44 px close target, no horizontal overflow', async () => {
    const s = p.getByTestId('shot').nth(2); await s.scrollIntoViewIfNeeded(); await s.tap()
    await p.locator('dialog[open] img').waitFor(); await p.waitForFunction(() => document.querySelector('dialog[open] img')?.complete)
    const r = await p.evaluate(() => {
      const d = document.querySelector('dialog[open]').getBoundingClientRect(), i = document.querySelector('dialog[open] img').getBoundingClientRect()
      const c = document.querySelector('dialog[open] button').getBoundingClientRect()
      return { d: [d.left, d.right], img: [i.left, i.right, i.width / i.height], close: [c.width, c.height], over: document.documentElement.scrollWidth - innerWidth }
    })
    await p.getByRole('button', { name: 'Close enlarged screenshot' }).tap()
    const closed = await p.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 3000 }).then(() => true, () => false)
    if (r.d[0] < 0 || r.d[1] > 390 || r.img[0] < 0 || r.img[1] > 390 || Math.abs(r.img[2] / 1.6 - 1) > 0.01 || r.close[0] < 44 || r.close[1] < 44 || r.over > 0 || !closed)
      throw new Error(JSON.stringify({ ...r, closed }))
    return `dialog ${Math.round(r.d[1] - r.d[0])} px wide, image aspect ${r.img[2].toFixed(3)}, close ${r.close.map(Math.round).join('×')} px, closes on tap`
  })
  await check('mobile 390 px: Launch Explorer works by tap', async () => {
    await p.getByRole('link', { name: 'Launch Explorer' }).first().tap(); await p.waitForURL('**/explorer')
    const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    if (over > 0) throw new Error('explorer overflow ' + over); return 'opened /explorer, no overflow'
  })
  await ctx.close() }

report(results)
await b.close()
