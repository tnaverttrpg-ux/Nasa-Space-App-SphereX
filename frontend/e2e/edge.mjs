// Browser check of the three UX additions on the Barnard D6 frame 2025W33_2C_0321_3 at FOV 0.5 (both themes).
import { chromium } from 'playwright-core'
import { APP, LAUNCH, OUT, report } from './lib.mjs'
const S = OUT
const results = []
const check = async (name, fn) => { try { results.push(['PASS', name, (await fn()) ?? '']) } catch (e) { results.push(['FAIL', name, String(e.message).split('\n')[0]]) } }
const b = await chromium.launch(LAUNCH)
for (const scheme of ['dark', 'light']) {
  const p = await (await b.newContext({ colorScheme: scheme, viewport: { width: 1440, height: 1000 } })).newPage()
  await p.goto(`${APP}?ra=269.44629&dec=4.767917&fov=0.5&band=D6&n=10`)  // smallest sample containing _3
  await p.waitForFunction(() => /Loaded \d+\/\d+ frames/.test(document.querySelector('[role="status"]')?.textContent ?? ''), null, { timeout: 500000 })
  // step to the 2025-08-15 20:50 frame
  for (let i = 0; i < 30; i++) {
    if ((await p.getByTestId('frame-date').innerText()).startsWith('2025-08-15 20:50')) break
    await p.getByRole('button', { name: 'Next frame' }).click()
  }
  await check(`[${scheme}] frame 2025-08-15 20:50 shown`, async () => (await p.getByTestId('frame-date').innerText()))
  await check(`[${scheme}] detector-edge row shows 37 px`, async () => {
    const v = await p.locator('dt', { hasText: 'Target → detector edge' }).locator('xpath=following-sibling::dd').innerText()
    if (!/^37 px/.test(v)) throw new Error(v); return v.replace(/\s+/g, ' ')
  })
  await check(`[${scheme}] coverage tooltip text`, async () => {
    await p.getByRole('button', { name: 'About Field coverage' }).focus()
    const t = await p.getByRole('tooltip').innerText()
    if (!t.includes('Percentage of the displayed field containing valid observed data after excluding masked pixels. Areas outside the detector are not observed.')) throw new Error(t)
    return `coverage ${await p.locator('dt', { hasText: 'Field coverage' }).locator('xpath=following-sibling::dd').innerText()}`
  })
  await check(`[${scheme}] legend shows both no-data swatches`, async () => {
    await p.getByText('masked (FITS flags)').waitFor(); await p.getByText('outside detector (not observed)').waitFor()
  })
  await check(`[${scheme}] rendered pixels: hatched dark grey off-detector band at top, light grey mask specks`, async () => {
    const img = p.locator('figure img[alt*="2025-08-15 20:50"]').first()
    const src = await img.getAttribute('src')
    const png = await p.evaluate(async s => {
      const im = new Image(); im.src = s; await im.decode()
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight
      const g = c.getContext('2d'); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data
      const at = (x, y) => [...d.slice((y * c.width + x) * 4, (y * c.width + x) * 4 + 3)].join(',')
      let off = 0, hatch = 0, mask = 0
      for (let i = 0; i < d.length; i += 4) { const k = `${d[i]},${d[i + 1]},${d[i + 2]}`; if (k === '46,47,50') off++; else if (k === '66,68,72') hatch++; else if (k === '118,120,124') mask++ }
      return { w: c.width, h: c.height, top: at(10, 5), off, hatch, mask }
    }, src)
    if (!png.off || !png.hatch || !png.mask) throw new Error(JSON.stringify(png))
    const frac = (png.off + png.hatch) / (png.w * png.h)
    return `${png.w}x${png.h}; off-detector ${(frac * 100).toFixed(1)}% (backend 37.2%), masked specks ${png.mask} px; top-left pixel ${png.top}`
  })
  await p.locator('figure', { has: p.locator('img[alt*="2025-08-15 20:50"]') }).first().screenshot({ path: `${S}edge-${scheme}.png` })
  await p.close()
}
report(results)
await b.close()
