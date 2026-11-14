import { useEffect, useState } from 'react'

export type ThemePref = 'system' | 'dark' | 'light'
// Same key is read by the inline script in index.html before first paint.
export const THEME_KEY = 'spheretrack-theme'

const lightQuery = () => window.matchMedia('(prefers-color-scheme: light)')

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'dark' || v === 'light' ? v : 'system'
  } catch {
    return 'system' // storage blocked: follow the OS
  }
}

/** System preference by default; manual Dark/Light override is persisted, choosing System removes it. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref)
  const [systemLight, setSystemLight] = useState(() => lightQuery().matches)

  useEffect(() => {
    const m = lightQuery()
    const on = () => setSystemLight(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])

  const resolved: 'dark' | 'light' = pref === 'system' ? (systemLight ? 'light' : 'dark') : pref
  useEffect(() => { document.documentElement.dataset.theme = resolved }, [resolved])

  const choose = (p: ThemePref) => {
    setPref(p)
    try {
      if (p === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, p)
    } catch { /* storage blocked: choice lasts for this session only */ }
  }
  return { pref, resolved, choose }
}
