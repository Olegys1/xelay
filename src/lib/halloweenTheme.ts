export type BaseTheme = 'light' | 'dark'
export type Theme = BaseTheme | 'halloween'

export const THEME_STORAGE_KEY = 'xelay_theme'
export const BASE_THEME_STORAGE_KEY = 'xelay_theme_base'
export const HALLOWEEN_THEME_CHOICE_KEY = 'xelay_halloween_2026_theme_choice'

// Kyiv: 18 October 2026, 12:00 — 3 November 2026, 00:00.
export const HALLOWEEN_THEME_START = Date.parse('2026-10-18T09:00:00Z')
export const HALLOWEEN_THEME_END = Date.parse('2026-11-02T22:00:00Z')

export function isHalloweenThemeAvailable(now = Date.now()): boolean {
  return Number.isFinite(now) && now >= HALLOWEEN_THEME_START && now < HALLOWEEN_THEME_END
}

export function parseBaseTheme(value: string | null | undefined): BaseTheme | null {
  return value === 'light' || value === 'dark' ? value : null
}

export interface HalloweenThemeChoice { campaign: 'halloween-2026'; theme: Theme; chosenAt: number }

export function parseHalloweenThemeChoice(value: string | null | undefined): HalloweenThemeChoice | null {
  try {
    const row = JSON.parse(value || 'null')
    if (row?.campaign !== 'halloween-2026' || !['light', 'dark', 'halloween'].includes(row.theme)
      || !Number.isSafeInteger(row.chosenAt) || !isHalloweenThemeAvailable(row.chosenAt)) return null
    return { campaign: 'halloween-2026', theme: row.theme, chosenAt: row.chosenAt }
  } catch { return null }
}

export function resolveSavedTheme(saved: string | null | undefined, base: string | null | undefined, systemDark: boolean, now = Date.now(), choiceValue?: string | null): { theme: Theme; base: BaseTheme } {
  const previous = parseBaseTheme(saved) || parseBaseTheme(base) || (systemDark ? 'dark' : 'light')
  const choice = parseHalloweenThemeChoice(choiceValue)
  // The launch sets the seasonal default once. An explicit in-season choice wins thereafter.
  const theme = isHalloweenThemeAvailable(now) ? choice?.theme || 'halloween' : previous
  return { theme, base: parseBaseTheme(theme) || previous }
}

export function nextHalloweenThemeBoundary(now = Date.now()): number | null {
  if (now < HALLOWEEN_THEME_START) return HALLOWEEN_THEME_START
  if (now < HALLOWEEN_THEME_END) return HALLOWEEN_THEME_END
  return null
}
