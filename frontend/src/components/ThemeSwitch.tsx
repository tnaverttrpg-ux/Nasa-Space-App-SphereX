import { Monitor, Moon, Sun } from 'lucide-react'
import type { ThemePref } from '../theme'

const OPTIONS: [ThemePref, string, typeof Sun][] = [['system', 'System', Monitor], ['dark', 'Dark', Moon], ['light', 'Light', Sun]]

/** Native radio group (arrow keys move the selection); fixed width so switching never shifts the layout. */
export default function ThemeSwitch({ pref, onChange }: { pref: ThemePref; onChange: (p: ThemePref) => void }) {
  return (
    <fieldset className="flex h-7 shrink-0 rounded-sm border border-line-strong">
      <legend className="sr-only">Colour theme</legend>
      {OPTIONS.map(([v, label, Icon]) => (
        <label key={v} title={`Theme: ${label}`} className="relative flex w-7 cursor-pointer items-center justify-center text-ink-3 hover:text-ink has-[:checked]:bg-accent/15 has-[:checked]:text-accent-ink has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
          <input type="radio" name="theme" value={v} checked={pref === v} onChange={() => onChange(v)} className="sr-only" aria-label={`${label} theme`} />
          <Icon size={13} aria-hidden />
        </label>
      ))}
    </fieldset>
  )
}
