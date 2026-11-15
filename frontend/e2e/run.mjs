// Runs browser suites one after another, each in its own Node process, then prints a summary.
//   npm run test:e2e              every suite in this folder
//   npm run test:e2e -- qa skymap only the named suites
// Prerequisites (checked first): see lib.mjs.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ORIGIN } from './lib.mjs'

const dir = new URL('./', import.meta.url)
const all = readdirSync(dir).filter(f => f.endsWith('.mjs') && !['lib.mjs', 'run.mjs'].includes(f)).map(f => f.slice(0, -4)).sort()
const asked = process.argv.slice(2)
const unknown = asked.filter(s => !all.includes(s))
if (unknown.length) { console.error(`Unknown suite(s): ${unknown.join(', ')}. Available: ${all.join(', ')}`); process.exit(2) }
const suites = asked.length ? asked : all

for (const [what, url] of [['Vite dev server (npm run dev)', ORIGIN], ['backend via the Vite proxy (uvicorn on :8000)', `${ORIGIN}/api/health`]]) {
  try { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`) }
  catch (e) { console.error(`Not reachable: ${what} at ${url} (${e.cause?.code ?? e.message}). Start both servers first (start.bat), see e2e/lib.mjs.`); process.exit(2) }
}

const run = s => new Promise(resolve => {
  const t0 = Date.now(), c = spawn(process.execPath, [fileURLToPath(new URL(`${s}.mjs`, dir))], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  c.stdout.on('data', d => { out += d; process.stdout.write(d) })
  c.on('close', code => resolve({ s, code, secs: (Date.now() - t0) / 1000, tally: [...out.matchAll(/^(\d+)\/(\d+) passed(?:, (\d+) skipped)?$/gm)].at(-1)?.slice(1).map(v => Number(v ?? 0)) }))   // some suites print diagnostics after it
})

const rows = []
for (const s of suites) { console.log(`\n=== ${s}`); rows.push(await run(s)) }
const res = r => r.tally ? `${r.tally[0]}/${r.tally[1]}${r.tally[2] ? ` +${r.tally[2]} skip` : ''}` : 'crashed'
const W = Math.max(7, ...rows.map(r => res(r).length))
console.log(`\n${'Suite'.padEnd(12)} ${'Result'.padEnd(W)}       Time`)
for (const r of rows) console.log(`${r.s.padEnd(12)} ${res(r).padEnd(W)} ${r.code === 0 ? 'ok  ' : 'FAIL'}  ${r.secs.toFixed(0).padStart(4)} s`)
const sum = i => rows.reduce((a, r) => a + (r.tally?.[i] ?? 0), 0), bad = rows.filter(r => r.code !== 0)
console.log(`\n${sum(0)}/${sum(1)} checks passed in ${rows.length} suites${sum(2) ? `; ${sum(2)} skipped: external service confirmed unavailable (see SKIP lines)` : ''}${bad.length ? `; failing: ${bad.map(r => r.s).join(', ')}` : ''}`)
process.exitCode = bad.length ? 1 : 0
