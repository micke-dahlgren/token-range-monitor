/** One rate-limit reading: when, which window (0 = 5-hour, 1 = weekly), % used, reset time (ms). */
export type RangeReading = [t: number, kind: 0 | 1, pct: number, resetsAt: number]

/** A stretch of time a session on this computer was open and taking readings: [from, to] in ms. */
export type RangeWatch = [from: number, to: number]

/** One day's use, a day being 24 hours from the weekly reset's time of day: when it began (ms), and how far the weekly figure rose in it, in % of the weekly limit. */
export type RangeDay = [dayStart: number, pct: number]

/** One weekly window's self-check: when it resets (ms), what the projection said was left at each day boundary in it, and what was actually left once it reset. */
export type RangeCheck = { resetsAt: number; at: Array<[t: number, left: number]>; actual?: number }

/**
 * One model response seen here, subagents' included: when, the model's id, the effort it was asked for
 * ('' for none), its tokens weighted by that model's price ratios, and 1 when a subagent made it. Responses recorded
 * by 1.4.0 also carry the project they were made in (that release's projects card, since removed): it is never synced.
 */
export type RangeStep = [t: number, model: string, effort: string, units: number, sub: 0 | 1, project?: string]

/**
 * What the weekly average covers (a window of n units, or since the reset), whether reset countdowns show
 * the finer unit, the model the others' costs compare to (a model id; absent, the default), and whether the
 * weekly card's daily budget outlines are hidden.
 */
export type RangeSettings = { mode: 'window' | 'reset'; n: number; unit: 'h' | 'd' | 'w'; fine: boolean; baseline?: string }

/** The colours the card draws with, as hex. */
export type Palette = {
  card: string; veil: string; fg: string; dim: string; off: string
  barTop: string; barBottom: string; limit: string; over: string; under: string; bad: string
  /** A figure "… to spare": the only place green is used. */
  good: string
  /** A colour per model family. */
  fable: string; opus: string; sonnet: string; haiku: string
  /** Claude's blue (the app's `--accent-100`): the context bar. */
  info: string
  /** The card's surfaces, as the pane's design names them: the card, a raised chip, the inset strip, the panel within. */
  surface: string; raised: string; inset: string; panel: string; line: string
  /** Its inks: muted and faint text, the accent and its tint, what's short and its tint, the neutral solid grey. */
  muted: string; faint: string; accent: string; accentBg: string; badBg: string; solid: string
}

/** The card's palettes for a dark and a light appearance, derived from the theme, and which one the theme itself is. */
export type Palettes = { dark: Palette; light: Palette; own: 'dark' | 'light' }

/**
 * What the pane's "Sync across devices" row shows: off (the person turned nonessential traffic off), signed out,
 * waiting for a sign-in in the browser (its code and page), or signed in (as whom, when it last synced);
 * a quiet note for what went wrong, whether a delete is waiting for its confirming press, and the devices signed in
 * (with the one a "Remove" waits on).
 */
export type RangeSync = {
  status: 'off' | 'signedOut' | 'waiting' | 'signedIn'
  email?: string
  last?: number
  code?: string
  url?: string
  note?: string
  confirmDelete?: boolean
  busy?: boolean
  /** The signed-in account's devices, as the server last listed them (this device first). */
  devices?: RangeDevice[]
  /** The device a "Remove" is waiting on its confirming press for. */
  confirmRemove?: string
}

/** A device signed in to sync, as the pane lists it: the server's id, its name (null: none given), when it was last seen, whether it is this one. */
export type RangeDevice = { id: string; name: string | null; lastSeenAt?: number; current: boolean }

declare module 'claude-code' {
  interface PluginState {
    'token-range-monitor': { readings: RangeReading[]; seen: RangeWatch[]; steps: RangeStep[]; days: RangeDay[]; check: RangeCheck[]; settings: RangeSettings; tick: number; palettes: Palettes; sync: RangeSync; details: string[] }
  }
}
