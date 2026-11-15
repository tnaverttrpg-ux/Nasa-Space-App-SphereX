import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Home from './Home'

// Two pages, chosen by path (no router dependency): "/explorer" is the scientific app, everything else the homepage.
// Shared links from before the homepage existed ("/?ra=…", "/?demo=1") still open the Explorer with their selection.
const EXPLORER = '/explorer'
const SHARED_KEYS = ['ra', 'dec', 'demo']
if (!location.pathname.startsWith(EXPLORER) && SHARED_KEYS.some(k => new URLSearchParams(location.search).has(k)))
  history.replaceState(null, '', EXPLORER + location.search + location.hash)

// The Explorer is a separate chunk, so the homepage never downloads it.
const App = lazy(() => import('./App'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname.startsWith(EXPLORER)
      ? <Suspense fallback={<p className="p-4 font-mono text-[12px] text-ink-3">Loading Explorer…</p>}><App /></Suspense>
      : <Home />}
  </StrictMode>,
)
