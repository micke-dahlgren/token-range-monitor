import { expect, test } from 'claude-code/testing'

import { contrast, derivePalette, paletteStyle, palettesFor, parseColor, parseThemeFile, PRESETS, resolveTheme } from '../hooks/theme'

const rgb = (hex: string) => parseColor(hex)!

test('theme colours parse in every form a theme file takes', async () => {
  expect(parseColor('#d77757')).toEqual([215, 119, 87])
  expect(parseColor('#fff')).toEqual([255, 255, 255])
  expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3])
  expect(parseColor('ansi256(231)')).toEqual([255, 255, 255])
  expect(parseColor('ansi:redBright')).toEqual([241, 76, 76])
  expect(parseColor('chartreuse')).toBe(null)
})

test('the dark and light palettes come from the presets and read on their card', async () => {
  const { dark, light, own } = palettesFor({ base: 'dark', overrides: {} })
  expect(own).toBe('dark')
  expect(dark.card).toBe('#373737')
  expect(light.card).toBe('#f0f0f0')
  for (const p of [dark, light]) {
    expect(contrast(rgb(p.fg), rgb(p.card))).toBeGreaterThanOrEqual(7)
    expect(contrast(rgb(p.dim), rgb(p.card))).toBeGreaterThanOrEqual(4.5)
    for (const c of [p.limit, p.under, p.bad, p.over]) expect(contrast(rgb(c), rgb(p.card))).toBeGreaterThanOrEqual(3)
  }
})

test("a custom theme's overrides set its own appearance, and its accents carry to the other", async () => {
  const theme = parseThemeFile({ base: 'light', overrides: { claude: '#2255ff', userMessageBackground: '#fdf6e3', bogus: '#000', text: 'nope' } })
  expect(theme).toEqual({ base: 'light', overrides: { claude: '#2255ff', userMessageBackground: '#fdf6e3' } })
  const p = palettesFor(theme)
  expect(p.own).toBe('light')
  expect(p.light.card).toBe('#fdf6e3')
  expect(p.light.barBottom).toBe('#2255ff')
  // the dark appearance keeps the theme's hue on the dark preset's card
  expect(p.dark.card).toBe(derivePalette(PRESETS.dark!).card)
  expect(p.dark.barBottom).not.toBe(derivePalette(PRESETS.dark!).barBottom)
})

test('the theme setting resolves presets, auto and custom files', async () => {
  const files: Record<string, string> = { solar: JSON.stringify({ base: 'dark', overrides: { success: '#00ff00' } }) }
  const read = async (slug: string) => files[slug]
  expect(await resolveTheme('light-daltonized', read)).toEqual({ base: 'light-daltonized', overrides: {} })
  expect(await resolveTheme('auto', read)).toBe('auto')
  expect(await resolveTheme('custom:solar', read)).toEqual({ base: 'dark', overrides: { success: '#00ff00' } })
  expect(await resolveTheme('custom:missing', read)).toEqual({ base: 'dark', overrides: {} })
  expect(await resolveTheme(undefined, read)).toEqual({ base: 'dark', overrides: {} })
})

test("a chart's style defaults to the theme's appearance and switches with the app's", async () => {
  const css = paletteStyle(palettesFor({ base: 'light', overrides: {} }))
  expect(css).toMatch(/^<style>svg\{--card:#f0f0f0;/)
  expect(css).toMatch(/@media \(prefers-color-scheme:dark\)\{svg\{--card:#373737;/)
})
