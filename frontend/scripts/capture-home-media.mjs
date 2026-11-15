// Regenerates the homepage feature screenshots (public/media/screens/*.png, converted to .webp separately) from the
// running Explorer showing REAL cached SPHEREx data for Barnard's Star (D6). Prerequisites: both servers running and
// the Barnard's Star D6 frames already cached (open the Explorer link below once). Run: node scripts/capture-home-media.mjs
// Env: E2E_BASE, E2E_CHANNEL, CAPTURE_THEME (dark|light, default dark).
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ORIGIN = process.env.E2E_BASE ?? 'http://localhost:5180'
const OUT = fileURLToPath(new URL('../public/media/screens/', import.meta.url)); mkdirSync(OUT, { recursive: true })
const PAGE = `${ORIGIN}/explorer?ra=269.44629&dec=4.767917&fov=0.1&band=D6&n=12`
const b = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'msedge', headless: true })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: process.env.CAPTURE_THEME ?? 'dark' })
await ctx.addInitScript(() => localStorage.setItem('spheretrack-guide-dismissed', '1'))
const p = await ctx.newPage()
const downloads = []
p.on('response', async r => { if (r.url().includes('/api/frame?')) { try { const j = await r.json(); if (j.timing?.source !== 'grid') downloads.push(j.timing?.source) } catch { /* non-JSON */ } } })
const settle = async () => { await p.waitForFunction(() => [...document.images].every(i => i.complete)); await p.waitForTimeout(400) }
const shot = async name => { await settle(); await p.screenshot({ path: `${OUT}${name}.png` }); console.log('saved', name) }

await p.goto(PAGE)
await p.waitForFunction(() => /Loaded (\d+)\/\1 frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 120000 })
if (downloads.length) throw new Error('frames were not all cached: ' + downloads)
await shot('viewer')

await p.getByRole('tab', { name: 'Difference' }).click(); await p.getByText('Red = brighter in observation A').waitFor({ timeout: 60000 })
await shot('difference')

await p.getByRole('tab', { name: 'Sequence' }).click()
const fig = p.locator('section[aria-label="Observation viewer"] figure').first(); const box = await fig.boundingBox()
await p.mouse.click(box.x + box.width * 0.5 + 3, box.y + (box.height - 26) * 0.5 + 3)   // just beside the target
await p.getByRole('region', { name: /pixel/i }).first().waitFor().catch(() => {})
await p.waitForTimeout(800); await shot('pixel')

await p.getByRole('tab', { name: 'Dashboard' }).click(); await p.waitForTimeout(500); await shot('dashboard')

await p.getByRole('tab', { name: 'Sky map' }).click(); await p.getByTestId('skymap').waitFor()
const svg = await p.getByTestId('map-svg').boundingBox(); await p.mouse.click(svg.x + svg.width * 0.5 + 2, svg.y + svg.height * 0.5 + 2)
await p.getByTestId('inspector').waitFor(); await p.mouse.move(0, 0); await shot('skymap')

// Pipeline QA on the frame with the trail (2026-05-05), QA section scrolled into view
await p.getByRole('tab', { name: 'Viewer' }).click()
for (let i = 0; i < 12 && !(await p.getByTestId('frame-date').innerText()).startsWith('2026-05-05'); i++) await p.getByRole('button', { name: 'Next frame' }).click()
if (!(await p.getByTestId('frame-date').innerText()).startsWith('2026-05-05')) throw new Error('trail frame not in sample')
await p.getByRole('region', { name: 'Pipeline QA' }).scrollIntoViewIfNeeded(); await shot('qa')
await b.close()
