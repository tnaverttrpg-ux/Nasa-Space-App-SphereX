// Shared settings for the browser suites in this folder.
// Prerequisites: backend on :8000 (`.venv\Scripts\python -m uvicorn app.main:app --port 8000` in backend/) and the
// Vite dev server (`npm run dev`, :5180, proxies /api to the backend) — or just run start.bat from the repo root.
// Suites use real IRSA data; the first run downloads and caches it, later runs read the cache.
// Env: E2E_BASE (default http://localhost:5180), E2E_CHANNEL (playwright browser channel, default msedge).
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ORIGIN = process.env.E2E_BASE ?? 'http://localhost:5180'
/** Screenshot folder (git-ignored), with a trailing slash. */
export const OUT = fileURLToPath(new URL('./screenshots/', import.meta.url)).replace(/\\/g, '/')
mkdirSync(OUT, { recursive: true })
export const LAUNCH = { channel: process.env.E2E_CHANNEL ?? 'msedge', headless: true, timeout: 300000 }

/** Print each check, a pass count line (read by run.mjs) and set a failing exit code if anything failed. */
export function report(results) {
  console.log(results.map(r => r.join(' | ')).join('\n'))
  const failed = results.filter(r => r[0] === 'FAIL').length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exitCode = failed || !results.length ? 1 : 0
}
