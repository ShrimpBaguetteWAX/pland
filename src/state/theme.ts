import { useEffect, useState } from 'react'

/*
 * Light (the tabletop as it was built) or dark (the couch mode's palette). Kept in this browser;
 * applied as data-theme on <html> before the first render (see main.tsx), so there is no flash.
 */
export type Theme = 'light' | 'dark'
const KEY = 'pd-army.theme'

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(storedTheme)
  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }, [theme])
  return [theme, set]
}
