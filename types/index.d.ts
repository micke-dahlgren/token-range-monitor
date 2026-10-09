/** One rate-limit reading: when, which window (0 = 5-hour, 1 = weekly), % used, reset time (ms). */
export type RangeReading = [t: number, kind: 0 | 1, pct: number, resetsAt: number]

/** A stretch of time a session on this computer was open and taking readings: [from, to] in ms. */
export type RangeWatch = [from: number, to: number]

/** What the weekly average covers (a window of n units, or since the reset), and whether reset countdowns show the finer unit. */
export type RangeSettings = { mode: 'window' | 'reset'; n: number; unit: 'h' | 'd' | 'w'; fine: boolean }

declare module 'claude-code' {
  interface PluginState {
    'token-range-monitor': { readings: RangeReading[]; seen: RangeWatch[]; settings: RangeSettings; tick: number }
  }
}
