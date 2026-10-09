/** One rate-limit reading: when, which window (0 = 5-hour, 1 = weekly), % used, reset time (ms). */
export type RangeReading = [t: number, kind: 0 | 1, pct: number, resetsAt: number]

/** A stretch of time a session on this computer was open and taking readings: [from, to] in ms. */
export type RangeWatch = [from: number, to: number]

/** What the weekly average covers (a window of n units, or since the reset), and whether reset countdowns show the finer unit. */
export type RangeSettings = { mode: 'window' | 'reset'; n: number; unit: 'h' | 'd' | 'w'; fine: boolean }

/** The colours the card draws with, as hex. */
export type Palette = {
  card: string; veil: string; fg: string; dim: string; off: string
  barTop: string; barBottom: string; limit: string; over: string; under: string; bad: string
}

/** The card's palettes for a dark and a light appearance, derived from the theme, and which one the theme itself is. */
export type Palettes = { dark: Palette; light: Palette; own: 'dark' | 'light' }

declare module 'claude-code' {
  interface PluginState {
    'token-range-monitor': { readings: RangeReading[]; seen: RangeWatch[]; settings: RangeSettings; tick: number; palettes: Palettes }
  }
}
