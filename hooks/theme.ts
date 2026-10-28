/**
 * The card's colours, derived from the person's Claude Code theme rather than
 * fixed: the theme's own tokens (text, inactive, claude, success, ...) set the
 * palette, so a custom theme, or a mod that ships one, carries over to the charts.
 *
 * The charts are SVG images, which can't name theme keys the way a Text can,
 * so each chart carries the palette as CSS variables: one set for a dark
 * appearance and one for a light, chosen by `prefers-color-scheme`.
 */
import type { Palette, Palettes } from '../types'

/** The theme tokens the palette is made from. */
export type Tokens = {
  text: string; inverseText: string; inactive: string; subtle: string; userMessageBackground: string
  claude: string; success: string; error: string; warning: string; suggestion: string
}
const TOKEN_KEYS = ['text', 'inverseText', 'inactive', 'subtle', 'userMessageBackground', 'claude', 'success', 'error', 'warning', 'suggestion'] as const
/** Tokens a theme gives its own hue: kept in the other appearance too. */
const ACCENTS = ['claude', 'success', 'error', 'warning', 'suggestion'] as const

/** Claude Code's built-in presets, as far as the palette needs them. */
const DARK: Tokens = {
  text: 'rgb(255,255,255)', inverseText: 'rgb(0,0,0)', inactive: 'rgb(153,153,153)', subtle: 'rgb(80,80,80)', userMessageBackground: 'rgb(55,55,55)',
  claude: 'rgb(215,119,87)', success: 'rgb(78,186,101)', error: 'rgb(255,107,128)', warning: 'rgb(255,193,7)', suggestion: 'rgb(177,185,249)',
}
const LIGHT: Tokens = {
  text: 'rgb(0,0,0)', inverseText: 'rgb(255,255,255)', inactive: 'rgb(102,102,102)', subtle: 'rgb(175,175,175)', userMessageBackground: 'rgb(240,240,240)',
  claude: 'rgb(215,119,87)', success: 'rgb(44,122,57)', error: 'rgb(171,43,63)', warning: 'rgb(150,108,30)', suggestion: 'rgb(87,105,247)',
}
export const PRESETS: Record<string, Tokens> = {
  dark: DARK,
  light: LIGHT,
  'dark-daltonized': { ...DARK, success: 'rgb(51,153,255)', error: 'rgb(255,102,102)', warning: 'rgb(255,204,0)' },
  'light-daltonized': { ...LIGHT, success: 'rgb(0,102,153)', error: 'rgb(204,0,0)', warning: 'rgb(255,153,51)' },
  'dark-ansi': { ...DARK, text: 'ansi:whiteBright', inactive: 'ansi:white', subtle: 'ansi:blackBright', claude: 'ansi:redBright', success: 'ansi:greenBright', error: 'ansi:redBright', warning: 'ansi:yellowBright', suggestion: 'ansi:blueBright' },
  'light-ansi': { ...LIGHT, text: 'ansi:black', inactive: 'ansi:blackBright', subtle: 'ansi:white', claude: 'ansi:red', success: 'ansi:green', error: 'ansi:red', warning: 'ansi:yellow', suggestion: 'ansi:blue' },
}

/** A theme as the setting and its file describe it: which preset it builds on, and what it changes. */
export type Theme = { base: string; overrides: Partial<Tokens> }

const isDark = (base: string) => !base.startsWith('light')
/** The preset of the other appearance, of the same kind (plain, daltonized, ansi). */
const counterpart = (base: string) => (isDark(base) ? base.replace(/^dark/, 'light') : base.replace(/^light/, 'dark'))

/** Reads a theme file's `{ base, overrides }`, keeping only tokens the palette uses and colours that parse. */
export function parseThemeFile(json: unknown): Theme {
  const o = (json ?? {}) as { base?: unknown; overrides?: Record<string, unknown> }
  const base = typeof o.base === 'string' && PRESETS[o.base] ? o.base : 'dark'
  const overrides: Partial<Tokens> = {}
  for (const k of TOKEN_KEYS) {
    const v = o.overrides?.[k]
    if (typeof v === 'string' && parseColor(v)) overrides[k] = v
  }
  return { base, overrides }
}

/**
 * The tokens for each appearance. The theme's own appearance takes the theme
 * whole; the other takes its counterpart preset with the theme's accents, so
 * the hues it chose carry over while text and background suit that appearance.
 * `auto` has no appearance of its own: each takes its plain preset.
 */
export function tokensFor(theme: Theme | 'auto'): { dark: Tokens; light: Tokens } {
  if (theme === 'auto') return { dark: DARK, light: LIGHT }
  const own = { ...PRESETS[theme.base] ?? DARK, ...theme.overrides }
  const accents: Partial<Tokens> = {}
  for (const k of ACCENTS) if (theme.overrides[k]) accents[k] = theme.overrides[k]
  const other = { ...PRESETS[counterpart(theme.base)] ?? LIGHT, ...accents }
  return isDark(theme.base) ? { dark: own, light: other } : { dark: other, light: own }
}

// ---- colours ----

type RGB = [number, number, number]

const ANSI: Record<string, RGB> = {
  black: [0, 0, 0], red: [205, 49, 49], green: [13, 188, 121], yellow: [229, 229, 16], blue: [36, 114, 200], magenta: [188, 63, 188], cyan: [17, 168, 205], white: [229, 229, 229],
  blackBright: [102, 102, 102], redBright: [241, 76, 76], greenBright: [35, 209, 139], yellowBright: [245, 245, 67], blueBright: [59, 142, 234], magentaBright: [214, 112, 214], cyanBright: [41, 184, 219], whiteBright: [255, 255, 255],
}
const ANSI_ORDER = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

/** Parses the colours a theme file takes: `#rrggbb`, `#rgb`, `rgb(r,g,b)`, `ansi256(n)`, `ansi:<name>`. */
export function parseColor(s: string): RGB | null {
  const t = s.trim()
  let m = /^#([0-9a-f]{6})$/i.exec(t)
  if (m) { const n = parseInt(m[1]!, 16); return [n >> 16, (n >> 8) & 255, n & 255] }
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(t)
  if (m) return [m[1]!, m[2]!, m[3]!].map(h => parseInt(h + h, 16)) as RGB
  m = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(t)
  if (m) return [m[1]!, m[2]!, m[3]!].map(v => Math.min(255, Number(v))) as RGB
  m = /^ansi256\(\s*(\d{1,3})\s*\)$/i.exec(t)
  if (m) return ansi256(Number(m[1]))
  m = /^ansi:(\w+)$/i.exec(t)
  if (m) return ANSI[m[1]!] ?? null
  return null
}

function ansi256(n: number): RGB | null {
  if (n < 0 || n > 255) return null
  if (n < 16) return ANSI[(n < 8 ? ANSI_ORDER[n] : `${ANSI_ORDER[n - 8]}Bright`)!] ?? null
  if (n >= 232) { const v = 8 + (n - 232) * 10; return [v, v, v] }
  const i = n - 16, step = (c: number) => (c === 0 ? 0 : 55 + c * 40)
  return [step(Math.floor(i / 36)), step(Math.floor(i / 6) % 6), step(i % 6)]
}

const hex = (c: RGB) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
/** `a` moved toward `b` by `t` (0 = a, 1 = b). */
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map(i => a[i]! + (b[i]! - a[i]!) * t) as RGB

const luminance = (c: RGB) => {
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
}
export const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}
/** `c` as it is, or moved toward `toward` just enough to reach `min` contrast on `bg`. */
function legible(c: RGB, bg: RGB, toward: RGB, min: number): RGB {
  for (let t = 0; t <= 1; t += 0.05) {
    const x = mix(c, toward, t)
    if (contrast(x, bg) >= min) return x
  }
  return toward
}

// ---- the palette ----

/** Claude's blue: the desktop app's `--accent-100`, hsl(210 70.9% 51.6%). */
export const CLAUDE_BLUE = '#2c84db'

export type PaletteKey = keyof Palette

/** The design's inks for each appearance: what the built-in presets draw with. */
type Inks = Pick<Palette, 'fg' | 'muted' | 'faint' | 'accent' | 'good' | 'solid' | 'fable' | 'opus' | 'sonnet' | 'haiku'>
const DESIGN: { dark: Inks; light: Inks } = {
  dark: { fg: '#f2efeb', muted: '#aaa7a3', faint: '#8e8a85', accent: '#df9a7c', good: '#86c294', solid: '#a9a5a0', fable: '#cdb39c', opus: '#df9a7c', sonnet: '#b9ada1', haiku: '#999590' },
  light: { fg: '#302e2b', muted: '#716b64', faint: '#807970', accent: '#a85f42', good: '#3f7d4c', solid: '#aaa197', fable: '#8f6a52', opus: '#a85f42', sonnet: '#827365', haiku: '#8d8780' },
}
/**
 * The design's tones within a card, as overlays on whatever the card is: a raised chip, the panel inside a
 * card, the inset strip under it, a hairline. Overlays, so they sit right on the app's own card colour.
 */
const TONES = {
  dark: { raised: '#ffffff14', panel: '#ffffff0b', inset: '#0000002e', line: '#ffffff1c' },
  light: { raised: '#0000000f', panel: '#00000008', inset: '#00000009', line: '#0000001a' },
}

const same = (a: RGB, b: RGB) => a.every((v, i) => Math.abs(v - b[i]!) < 1)

/**
 * The card's palette from one appearance's tokens. The card is the theme's message background and the
 * veil behind a label its inverse text colour; the built-in presets' inks are the design's own warm ones,
 * and a theme that sets its own colours carries them over: its text, its Claude colour as the accent and
 * for what's short, its success colour for what lasts. Every colour that carries meaning is nudged toward the text colour until
 * it reads on the card. The older keys (dim, off, barTop, ...) name the same colours for the 1.3 charts.
 */
export function derivePalette(t: Tokens): Palette {
  const c = (s: string, fallback: string) => parseColor(s) ?? parseColor(fallback)!
  const fallback = luminance(c(t.inverseText, '#000')) < 0.5 ? DARK : LIGHT
  const k = Object.fromEntries(TOKEN_KEYS.map(key => [key, c(t[key], fallback[key])])) as Record<keyof Tokens, RGB>
  const card = k.userMessageBackground
  const look = luminance(card) < 0.5 ? 'dark' : 'light'
  const d = DESIGN[look], preset = look === 'dark' ? DARK : LIGHT
  // a token the theme left as its preset has takes the design's ink; one it set is its own
  const ink = (key: keyof Tokens, design: string, own: RGB = k[key]) => (same(k[key], parseColor(preset[key])!) ? parseColor(design)! : own)
  const text = ink('text', d.fg)
  const on = (x: RGB, min: number) => hex(legible(x, card, text, min))
  const accent = on(ink('claude', d.accent), 3)
  // what's short reads in the accent's amber; green is only for a figure "… to spare"
  const bad = accent
  const good = on(ink('success', d.good), 3)
  const muted = on(ink('inactive', d.muted), 4.5)
  const tones = TONES[look]
  return {
    card: hex(card),
    veil: hex(k.inverseText),
    fg: on(text, 7),
    dim: muted,
    off: on(ink('subtle', d.faint), 2.5),
    barTop: accent,
    barBottom: accent,
    limit: on(ink('claude', d.sonnet, mix(k.claude, k.inactive, 0.7)), 3),
    over: accent,
    under: accent,
    bad,
    good,
    surface: hex(card),
    ...tones,
    muted,
    faint: on(ink('subtle', d.faint), 2.5),
    accent,
    accentBg: `${accent}2e`,
    badBg: `${bad}33`,
    solid: on(ink('inactive', d.solid), 2.5),
    fable: on(ink('claude', d.fable, mix(k.claude, k.suggestion, 0.5)), 3),
    opus: accent,
    sonnet: on(ink('claude', d.sonnet, mix(k.claude, k.inactive, 0.7)), 3),
    haiku: on(ink('inactive', d.haiku), 3),
    // Claude's blue, as the app's --accent-100 (hsl(210 70.9% 51.6%)) in both appearances
    info: CLAUDE_BLUE,
  }
}

/**
 * The 1.3 chart's colours inside a card's Details, as the design restyles it: its your-pace line in the solid grey, the safe pace in the second model colour, the bars in the accent.
 */
export function historyPalettes(p: Palettes): Palettes {
  const h = (x: Palette): Palette => ({ ...x, fg: x.solid, dim: x.muted, off: x.faint, limit: x.sonnet })
  return { ...p, dark: h(p.dark), light: h(p.light) }
}

export function palettesFor(theme: Theme | 'auto'): Palettes {
  const t = tokensFor(theme)
  return { dark: derivePalette(t.dark), light: derivePalette(t.light), own: theme === 'auto' || isDark(theme.base) ? 'dark' : 'light' }
}

export const DEFAULT_PALETTES = palettesFor({ base: 'dark', overrides: {} })

/** A colour by name, for a style: `style="fill:${v('fg')}"`. */
export const v = (key: PaletteKey) => `var(--${key})`

/**
 * The `<style>` a chart carries: its theme's own appearance as the default,
 * the other one under `prefers-color-scheme`, so the chart follows the app's
 * appearance where the surface passes it on, and the theme where it doesn't.
 */
export function paletteStyle(p: Palettes): string {
  const vars = (pal: Palette) => Object.entries(pal).map(([key, val]) => `--${key}:${val}`).join(';')
  const other = p.own === 'dark' ? 'light' : 'dark'
  // shown in a frame, a drawing is a page of its own: one that doesn't say it can be dark gets an opaque
  // white backdrop in a dark app, so each says it suits both, and stays see-through
  return `<style>:root{color-scheme:light dark;background:transparent}svg{${vars(p[p.own])}}@media (prefers-color-scheme:${other}){svg{${vars(p[other])}}}</style>`
}

/** The theme a `theme` setting names: a preset, `auto`, or `custom:<slug>`, read by `readFile`. */
export async function resolveTheme(setting: unknown, readFile: (slug: string) => Promise<string | undefined>): Promise<Theme | 'auto'> {
  const name = typeof setting === 'string' ? setting : 'dark'
  if (name === 'auto') return 'auto'
  if (PRESETS[name]) return { base: name, overrides: {} }
  const slug = /^custom:(.+)$/.exec(name)?.[1]
  if (slug) {
    const text = await readFile(slug).catch(() => undefined)
    if (text) {
      try { return parseThemeFile(JSON.parse(text)) } catch { /* fall through to the default */ }
    }
  }
  return { base: 'dark', overrides: {} }
}
