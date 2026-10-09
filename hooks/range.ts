import type { Palettes, RangeReading, RangeSettings } from '../types'
import { DEFAULT_PALETTES, paletteStyle, v } from './theme'
import type { PaletteKey } from './theme'

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

export type Kind = 'five' | 'week'
const KIND = { five: 0, week: 1 } as const
const SPAN = { five: 5 * HOUR, week: 7 * DAY }
/** How far back one reading's increase is spread when readings are far apart. */
const SPREAD = 10 * MIN
/** Readings older than this are dropped: enough for a 2-week window plus slack. */
export const KEEP = 22 * DAY

export const DEFAULT_SETTINGS: RangeSettings = { mode: 'reset', n: 1, unit: 'd', fine: false }
export const UNIT_HOURS = { h: 1, d: 24, w: 168 } as const
/** The longest window on offer per unit: a day in hours, the week's own length in days. */
export const UNIT_MAX = { h: 24, d: 7 } as const

export const windowHours = (s: Pick<RangeSettings, 'n' | 'unit'>) => Math.min(s.n * UNIT_HOURS[s.unit], KEEP / HOUR - 24)
export const windowName = (s: Pick<RangeSettings, 'n' | 'unit'>) => `${s.n}${s.unit}`

/** What an average covers: the last `hours`, or the time since the reset. */
export type Average = { type: 'hours'; hours: number } | { type: 'reset' }

/**
 * Least data behind any average before it is an estimate. The weekly figure moves
 * in coarse steps, so under six hours one step reads as a huge rate.
 */
export const MIN_RECORDED_H = { week: 6, five: 5 / 60 }
/** The shortest window on offer per unit: in hours the weekly least, since anything shorter can't give an estimate. */
export const UNIT_MIN = { h: MIN_RECORDED_H.week, d: 1 } as const
/** `n` held to what the unit offers. */
export const clampWindow = (n: number, unit: 'h' | 'd') => Math.min(UNIT_MAX[unit], Math.max(UNIT_MIN[unit], Math.round(n)))
/** Least time since the reset before its average is an estimate: just after a reset a few % projects wildly. */
export const MIN_SINCE_RESET_H = { week: 6, five: 0.25 }

export const chosenAverage = (s: RangeSettings): Average =>
  s.mode === 'window' ? { type: 'hours', hours: windowHours(s) } : { type: s.mode }

/** Hours of usage on record for this limit: from its first reading to now. */
export function recordedHours(readings: readonly RangeReading[], kind: Kind, now: number): number {
  const first = ofKind(readings, kind)[0]
  return first ? Math.max(0, (now - first[0]) / HOUR) : 0
}

/** Parses `2d`, `6h`, `1w`, `3 days`; null when it is none of those. */
export function parseWindow(text: string): Pick<RangeSettings, 'n' | 'unit'> | null {
  const m = /^\s*(\d{1,3})\s*(h|hours?|d|days?|w|weeks?)\s*$/i.exec(text)
  if (!m) return null
  const n = Number(m[1] ?? 0)
  const unit = (m[2] ?? '').charAt(0).toLowerCase() as RangeSettings['unit']
  if (n < 1 || n * UNIT_HOURS[unit] > 168) return null
  return { n, unit }
}

const sameWindow = (a: RangeReading, b: RangeReading) => Math.abs(a[3] - b[3]) < 5 * MIN
const sameWindowAs = (r: RangeReading, resetsAt: number) => Math.abs(r[3] - resetsAt) < 5 * MIN

export function ofKind(readings: readonly RangeReading[], kind: Kind): RangeReading[] {
  return readings.filter(r => r[1] === KIND[kind]).sort((a, b) => a[0] - b[0])
}

/** Merges reading lists, dropping duplicates and anything older than KEEP. */
export function merge(lists: ReadonlyArray<readonly RangeReading[]>, now: number): RangeReading[] {
  const seen = new Set<string>()
  const out: RangeReading[] = []
  for (const list of lists) {
    for (const r of list) {
      const id = `${r[0]}:${r[1]}:${r[2]}`
      if (r[0] < now - KEEP || seen.has(id)) continue
      seen.add(id)
      out.push(r)
    }
  }
  return out.sort((a, b) => a[0] - b[0])
}

/**
 * A stretch of time some session on this computer was getting fresh figures:
 * its turns were getting responses from Claude, each carrying the account's
 * current usage. An open but idle session gets none, so it isn't watching.
 * [from, to] in ms.
 */
export type Watch = [number, number]

/**
 * Two fresh figures further apart than this leave a hole: nothing here was
 * watching in between. Long enough to span a pause while you read or type,
 * short enough that an idle hour counts as away.
 */
export const WATCH_GAP = 15 * MIN

/** Whether [a, b] lies wholly inside the watched spans. */
export function isWatched(seen: readonly Watch[], a: number, b: number): boolean {
  let t = a
  for (const [s, e] of [...seen].sort((x, y) => x[0] - y[0])) {
    if (s > t + WATCH_GAP) break
    t = Math.max(t, e)
    if (t >= b - WATCH_GAP) return true
  }
  return t >= b - WATCH_GAP
}

/** Adds a heartbeat at `now`: extends the last span when it is recent, else starts one. */
export function heartbeat(seen: readonly Watch[], now: number): Watch[] {
  const last = seen[seen.length - 1]
  const kept = seen.filter(w => w[1] >= now - KEEP)
  if (last && now - last[1] <= WATCH_GAP) return [...kept.slice(0, -1), [last[0], now]]
  return [...kept, [now, now]]
}

export type Increment = {
  start: number
  end: number
  amount: number
  /** Set when the rise came over a gap this computer didn't watch: the gap's start and where the rise was placed. Drawn as the gap's block. */
  hole?: [number, number]
  /** For a rise seen while watching: when the reading before it was taken, so the rise came somewhere after. */
  from?: number
}

/**
 * Usage gained between readings. Within one window only rises past the highest
 * reading so far count, so rounding wobble isn't counted twice; across a reset,
 * the new window's whole reading counts.
 *
 * Where it goes in time: while this computer was watching, a rise sits in the
 * minutes before the reading that saw it. A rise over a gap the computer
 * wasn't watching came from elsewhere (another computer, claude.ai): it goes
 * into the account's current 5-hour window when that opened inside the gap,
 * since a 5-hour window opens with the first message of a stretch of work;
 * with no such clue it is spread evenly over the gap.
 */
export function increments(readings: readonly RangeReading[], kind: Kind, seen: readonly Watch[] = []): Increment[] {
  const rs = ofKind(readings, kind)
  const fives = ofKind(readings, 'five')
  const out: Increment[] = []
  let high = rs[0]?.[2] ?? 0
  let reached = rs[0]?.[0] ?? 0
  for (let i = 1; i < rs.length; i++) {
    const a = rs[i - 1]!, b = rs[i]!
    let amount: number
    let start: number
    let hole: [number, number] | undefined
    if (b[0] - a[0] <= SPREAD || isWatched(seen, a[0], b[0])) {
      start = b[0] - Math.min(b[0] - a[0], SPREAD)
    } else {
      let five: RangeReading | undefined
      for (const f of fives) if (f[0] <= b[0] + MIN) five = f
      const fiveStart = five && five[3] > b[0] ? five[3] - SPAN.five : undefined
      start = fiveStart !== undefined && fiveStart > a[0] ? fiveStart : a[0]
      hole = [a[0], start > a[0] ? start : b[0]]
    }
    // the rise came after the figure first reached its last point: readings repeat while it stays put
    let from = reached
    if (sameWindow(a, b)) {
      amount = b[2] - high
      high = Math.max(high, b[2])
    } else {
      amount = b[2]
      high = b[2]
      start = Math.max(start, b[3] - SPAN[kind])
      from = Math.max(a[0], b[3] - SPAN[kind])
    }
    if (amount > 0) {
      out.push({ start: Math.min(start, b[0] - 1), end: b[0], amount, ...(hole ? { hole } : { from }) })
      reached = b[0]
    }
  }
  return out
}

/**
 * Rises placed where the work behind them happened. A limit is read in whole
 * points, so on its own a rise only says which reading saw it: every bar of
 * one point would be the same height. Each rise seen while watching is shared
 * among the responses made since the figure reached its previous point, by their weight
 * (`points`: when, and how much work), so the total stays Anthropic's and the
 * shape is the work's. A rise with no responses behind it, or over a gap,
 * stays as it was.
 */
export function refine(incs: readonly Increment[], points: ReadonlyArray<readonly [number, number]>): Increment[] {
  const pts = [...points].sort((a, b) => a[0] - b[0])
  const out: Increment[] = []
  let k = 0
  for (const inc of [...incs].sort((a, b) => a.end - b.end)) {
    if (inc.hole || inc.from === undefined) { out.push(inc); continue }
    while (k < pts.length && pts[k]![0] <= inc.from) k++
    let j = k, total = 0
    while (j < pts.length && pts[j]![0] <= inc.end) total += pts[j++]![1]
    if (total <= 0) { out.push(inc); continue }
    for (let i = k; i < j; i++) {
      const [t, w] = pts[i]!
      if (w > 0) out.push({ start: t - MIN, end: t, amount: inc.amount * w / total })
    }
  }
  return out
}

export function usedBetween(incs: readonly Increment[], from: number, to: number): number {
  let sum = 0
  for (const inc of incs) {
    const overlap = Math.min(inc.end, to) - Math.max(inc.start, from)
    if (overlap > 0) sum += inc.amount * overlap / (inc.end - inc.start)
  }
  return sum
}

export type Model = {
  kind: Kind
  /** % used now, and when the window resets (ms). */
  pct: number
  resetsAt: number
  /** Hours until the reset. */
  left: number
  /** Average and limit, in % per hour. */
  rate: number
  limit: number
  /** % projected to be left at the reset; negative means short by that much. */
  arrive: number
  over: boolean
  /** Hours until 100% at this rate (Infinity at rate 0), and how long before the reset that is. */
  runsOutIn: number
  early: number
  /** What the average covers, from when (ms), and for how many hours. */
  average: Average
  from: number
  winH: number
  /** When recording of this limit began (ms): before it the chart has no bars. */
  recordedFrom: number
  /**
   * Usage since the reset from before recording began, when the average runs
   * from the reset and the record begins inside this window: % used by the
   * first reading, and when that was (ms). Drawn as one block up to then.
   */
  before: { pct: number; until: number } | null
  /** Why there is no estimate, when there isn't enough behind the average; then the rate and what follows from it mean nothing. */
  noData: string | null
  increments: Increment[]
}

/**
 * The projection for one limit at `now`, from the latest reading and the
 * average `avg`. With too little behind that average (a window longer than
 * the record, or just after a reset) there is no estimate: `noData` says why.
 */
export function project(readings: readonly RangeReading[], kind: Kind, now: number, avg: Average, seen: readonly Watch[] = []): Model | null {
  const rs = ofKind(readings, kind)
  const last = rs[rs.length - 1]
  if (!last) return null
  let pct = last[2], resetsAt = last[3]
  if (resetsAt <= now) {
    if (kind === 'five') return null            // no active 5-hour window
    while (resetsAt <= now) resetsAt += SPAN.week
    pct = 0
  }
  const incs = increments(readings, kind, seen)
  const recordedFrom = rs[0]![0]
  const from = avg.type === 'reset' ? resetsAt - SPAN[kind] : now - avg.hours * HOUR
  const winH = Math.max((now - from) / HOUR, 1 / 60)
  // since the reset, Anthropic's own figure is exact; otherwise add up what was recorded
  const recordedH = (now - recordedFrom) / HOUR
  const sinceResetH = (now - (resetsAt - SPAN[kind])) / HOUR
  const noData = avg.type === 'reset'
    ? sinceResetH < MIN_SINCE_RESET_H[kind] ? `No estimate this soon after ${kind === 'five' ? 'the 5-hour window opened' : 'the reset'}. About ${dur(MIN_SINCE_RESET_H[kind] - sinceResetH)} to go.` : null
    : avg.hours < MIN_RECORDED_H[kind] ? tooShort(kind) : avg.hours > recordedH ? needsMore(avg, recordedH) : null
  const rate = noData ? 0 : (avg.type === 'reset' ? pct : usedBetween(incs, from, now)) / winH
  const left = (resetsAt - now) / HOUR
  const remaining = 100 - pct
  const proj = pct + rate * left
  const runsOutIn = rate > 0 ? remaining / rate : Infinity
  // the window's first reading, when nothing was recorded before it, holds all usage up to then
  const first = rs[0]!
  const before = avg.type === 'reset' && sameWindowAs(first, resetsAt) && first[0] > from ? { pct: first[2], until: first[0] } : null
  return {
    kind, pct, resetsAt, left, rate, limit: remaining / left, arrive: 100 - proj, over: proj > 100,
    runsOutIn, early: Math.max(0, left - runsOutIn), average: avg, from, winH, recordedFrom, before, noData, increments: incs,
  }
}

/** Bar size in minutes so the window holds at most 48 bars. */
export const bucketMinutes = (winMin: number) =>
  [1, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440].find(b => winMin / b <= 48) ?? 1440

/**
 * Usage rate per bar from the average's start to now, in % per `perHours`
 * hours: about `bucketMin` minutes a bar, the bars filling the span exactly.
 */
export function bars(m: Model, now: number, bucketMin: number, perHours: number): number[] {
  const n = Math.max(1, Math.round(m.winH * 60 / bucketMin)), width = (now - m.from) / n, out: number[] = []
  // usage seen as it happened; what came in over a gap is drawn as that gap's block instead
  const seen = m.increments.filter(i => !i.hole)
  for (let i = 0; i < n; i++) {
    const s = m.from + i * width
    out.push(usedBetween(seen, s, s + width) / (width / HOUR) * perHours)
  }
  return out
}

// ---- words ----

export const signed = (x: number) => (Math.round(x) >= 0 ? '+' : '−') + Math.abs(Math.round(x)) + '%'
export const fx = (v: number, d = 1) => v.toFixed(d)

export function dur(h: number): string {
  if (!isFinite(h)) return '—'
  if (h >= 24) return Math.round(h % 24) % 24 === 0 ? `${Math.round(h / 24)}d` : `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`
  if (h >= 1) {
    const m = Math.round(h % 1 * 60)
    // a whole number of hours reads plainly: "8h", not "8h 00m"
    return m === 0 || m === 60 ? `${Math.round(h)}h` : `${Math.floor(h)}h ${String(m).padStart(2, '0')}m`
  }
  return `${Math.max(0, Math.round(h * 60))}m`
}

/** "Resets in 3.7 days" / "Resets in 89 hours", and for the 5-hour window hours / minutes. */
export function resetsIn(m: Model, fine: boolean): string {
  if (m.kind === 'week') return fine ? `Resets in ${Math.round(m.left)} hours` : `Resets in ${fx(m.left / 24)} days`
  // under an hour, hours read as "0.4 hours": minutes then, whichever unit was picked
  const minutes = Math.round(m.left * 60)
  if (fine || m.left < 1) return `Resets in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  return `Resets in ${fx(m.left)} hours`
}

/** The name of an average, as its button shows it. */
export const averageName = (avg: Average) =>
  avg.type === 'reset' ? 'Since reset' : avg.hours < 1 ? `${Math.round(avg.hours * 60)}m` : windowName(hoursToWindow(avg.hours))

const hoursToWindow = (h: number): Pick<RangeSettings, 'n' | 'unit'> =>
  h % 24 === 0 ? { n: h / 24, unit: 'd' } : { n: h, unit: 'h' }

/** One line on what the average covers. */
export function averageNote(m: Model): string {
  if (m.noData) return m.noData
  if (m.average.type === 'reset') {
    const since = m.kind === 'five' ? `the 5-hour window opened` : `the reset`
    return m.recordedFrom > m.from
      ? `Average since ${since} ${dur(m.winH)} ago, from Anthropic's figure.`
      : `Average since ${since} ${dur(m.winH)} ago.`
  }
  return `Average over the last ${averageName(m.average)}.`
}

/** Why an average can't be picked yet, and when it can. */
export const needsMore = (avg: { type: 'hours'; hours: number }, recordedH: number) =>
  `${averageName(avg)} needs ${dur(avg.hours)} of recorded usage. ${dur(recordedH)} recorded so far, about ${dur(avg.hours - recordedH)} to go.`

/** For a window shorter than a limit's least data: no estimate, whatever is on record. */
const tooShort = (kind: Kind) =>
  `${kind === 'week' ? 'Weekly' : '5-hour'} estimates need at least ${dur(MIN_RECORDED_H[kind])} of data. Set the window to ${dur(MIN_RECORDED_H[kind])} or more.`

export const runsOut = (m: Model) => `Runs out in ${dur(m.runsOutIn)}, ${dur(m.early)} early`

/** What's projected to be left at the reset, or "No data" without an estimate. */
export const leftText = (m: Model) => (m.noData ? 'No data' : signed(m.arrive))
export const isShort = (m: Model) => m.over && !m.noData

export const rateText = (m: Model, perHour: number) =>
  m.kind === 'week' ? `${fx(perHour * 24)}%/day` : `${fx(perHour)}%/h`

// ---- drawing ----

/** The card's colours, as CSS variables a chart's <style> sets from the person's theme (see theme.ts). */
export const C = Object.fromEntries(
  (['card', 'veil', 'fg', 'dim', 'off', 'barTop', 'barBottom', 'limit', 'over', 'under', 'bad', 'fable', 'opus', 'sonnet', 'haiku'] as const).map(k => [k, v(k)]),
) as Record<PaletteKey, string>
/** IBM Plex for words, Plex Mono for figures that line up; the system's own faces where Plex can't load. */
export const FONT = "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
export const MONO = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace"
const FONTS = `<style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600&amp;display=swap');</style>`

/**
 * Every text style in the drawings, by role: size in rem (1rem = 16px), weight,
 * and colour as a palette key, so it follows the theme. Change one here and
 * the layout around it follows. A colour that carries state (the green or red
 * figure, the limit line's label) stays that state's colour.
 */
export const TEXT: Record<Role, { rem: number; weight: number; color: PaletteKey; mono?: boolean }> = {
  /** The card's title, "This week". */
  title: { rem: 1.2, weight: 500, color: 'fg' },
  /** The run-out warning under the title. */
  warning: { rem: 0.85, weight: 400, color: 'over' },
  /** A figure's caption: "Average", small and mono. */
  caption: { rem: 0.6875, weight: 500, color: 'dim', mono: true },
  /** A figure: "19.4%/day". */
  figure: { rem: 0.9375, weight: 500, color: 'fg', mono: true },
  /** The axes, the unit line and notes inside the plot. */
  axis: { rem: 0.7, weight: 400, color: 'dim', mono: true },
  /** The labels on the average and limit lines. */
  line: { rem: 0.8125, weight: 500, color: 'fg', mono: true },
  /** The reset countdown beside the title: "Resets in 6.1 days". */
  countdown: { rem: 0.75, weight: 400, color: 'dim' },
  /** The note under a card: "Average since the reset 23h ago, ...". */
  note: { rem: 0.78, weight: 400, color: 'dim' },
}
type Role = 'title' | 'warning' | 'caption' | 'figure' | 'axis' | 'line' | 'countdown' | 'note'
const px = (role: Role) => TEXT[role].rem * 16
/** About how wide a text runs, for laying out around it: mono is 0.6em a character. */
const textWidth = (str: string, role: Role) =>
  str.length * px(role) * (TEXT[role].mono ? 0.6 : TEXT[role].weight >= 600 ? 0.62 : 0.58)
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
/**
 * The width a drawing tells the app it has. The app shows each drawing in a
 * frame as wide as its slot, up to this; inside, the drawing fills the frame
 * (`:root{width:100%}`) and is laid out in percentages and pixels, never a
 * viewBox, so it stretches to any width while its text stays the size set.
 */
const FRAME_W = 2000
/** A drawing of `content`, `height` pixels tall, filling whatever width its frame has. */
export function drawing(content: string, height: number, pal: Palettes = DEFAULT_PALETTES): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_W}" height="${Math.ceil(height)}">${FONTS}<style>:root{width:100%;height:100%;overflow:hidden}</style>${paletteStyle(pal)}${content}</svg>`
}
/** A drawing's height: what its frame is given. */
export const drawingHeight = (svg: string) => Number(/^<svg [^>]* height="(\d+)">/.exec(svg)![1])
/** A share of the width, as a length. */
export const pct = (f: number) => `${(f * 100).toFixed(3)}%`
/** Content placed with its origin at a share of the width (1: the right edge); it draws at negative x to sit left of it. */
export const at = (f: number, content: string) => `<svg x="${pct(f)}" y="0" width="1" height="1" overflow="visible">${content}</svg>`

/** A text in its role's style; `fill` and `weight` only where state sets them. */
const text = (x: number | string, y: number, s: string, o: { role?: Role; fill?: string; anchor?: string; weight?: number } = {}) => {
  const t = TEXT[o.role ?? 'axis']
  return `<text x="${typeof x === 'number' ? x.toFixed(1) : x}" y="${y.toFixed(1)}" text-anchor="${o.anchor ?? 'start'}" style="fill:${o.fill ?? C[t.color]}" font-family="${t.mono ? MONO : FONT}" font-size="${t.rem}rem" font-weight="${o.weight ?? t.weight}">${esc(s)}</text>`
}

/**
 * The card's head: the title, the run-out line when the projection goes over,
 * and the three figures. The reset countdown beside it is a Button, not drawn here.
 */
/** Where the head's lines sit: the title, the warning, the captions and the figures, and its height. */
function headLayout(m: Model, width: number, pace?: Pace) {
  const isOver = m.over && !m.noData
  const title = px('title')
  const warning = isOver ? title + px('warning') * 1.6 : title
  const stats: Array<{ label: string; value: string; fill?: string; info: boolean; w: number; x: number; row: number }> = []
  const add = (label: string, value: string, fill: string | undefined, info = false) =>
    stats.push({ label, value, ...(fill ? { fill } : {}), info, w: Math.max(textWidth(label, 'caption') + (info ? px('caption') + 6 : 0), textWidth(value, 'figure')), x: 0, row: 0 })
  // the left-at-reset figure is coloured by its state; the others take the figure role's colour
  add(m.kind === 'week' ? 'Left at week reset' : 'Left at 5h reset', m.noData ? 'No data' : signed(m.arrive), m.noData ? C.dim : m.over ? C.bad : C.under)
  add('Average', m.noData ? 'No data' : rateText(m, m.rate), m.noData ? C.dim : undefined)
  add('Limit', rateText(m, m.limit), undefined)
  if (pace) add(PACE_LABEL, pace.ready ? `${fx(pace.rate * 24)}%/day` : 'No data', pace.ready ? undefined : C.dim, true)
  // the figures flow left to right, onto another row where the card is too narrow for the next
  const gap = px('figure') * 1.5
  let x = 0, row = 0
  for (const st of stats) {
    if (x > 0 && x + st.w > width) { x = 0; row++ }
    st.x = x; st.row = row
    x += st.w + gap
  }
  const step = px('caption') * 1.6 + px('figure') * 1.5 + 6
  const caption = (r: number) => warning + px('caption') * 2 + r * step
  const figure = (r: number) => caption(r) + px('figure') * 1.5
  return { isOver, title, warning, stats, caption, figure, height: Math.ceil(figure(row) + px('figure') * 0.4) }
}

/** Where the head's info circle sits, in drawn pixels: what the drawing around it places the tooltip by. */
export type InfoSpot = { cx: number; cy: number; r: number }

/**
 * The head: title, warning, the figures, and the countdown. Given a pace, a
 * fourth figure "1hr pace" whose caption ends in an info circle; the circle
 * itself is drawn by `withInfo`, which can open its tooltip over the chart.
 */
export function headerDraw(m: Model, title: string, width: number, pal: Palettes = DEFAULT_PALETTES, countdown = '', pace?: Pace): { svg: string; height: number; info?: InfoSpot } {
  const L = headLayout(m, width, pace)
  let s = text(0, L.title, title, { role: 'title' })
  if (L.isOver) s += text(0, L.warning, runsOut(m), { role: 'warning' })
  // the countdown sits at the right on the title's line
  if (countdown) s += text('100%', L.title, countdown, { role: 'countdown', anchor: 'end' })
  let spot: InfoSpot | undefined
  for (const st of L.stats) {
    s += text(st.x, L.caption(st.row), st.label, { role: 'caption' })
    s += text(st.x, L.figure(st.row), st.value, { role: 'figure', ...(st.fill ? { fill: st.fill } : {}) })
    if (st.info) {
      // the circle after the caption
      const r = px('caption') * 0.5
      spot = { cx: st.x + textWidth(st.label, 'caption') + 6 + r, cy: L.caption(st.row) - px('caption') * 0.35, r }
    }
  }
  return { svg: drawing(s, L.height, pal), height: L.height, ...(spot ? { info: spot } : {}) }
}
export const headerSvg = (m: Model, title: string, width: number, pal: Palettes = DEFAULT_PALETTES, countdown = '') =>
  headerDraw(m, title, width, pal, countdown).svg

/**
 * Moves labels apart so none overlap: each sits as near its own line as it can.
 * Labels that would collide are grouped and centred on their lines' average,
 * then the whole stack is kept between `lo` and `hi`. `ys` are the lines'
 * heights; the result is in the same order.
 */
export function spreadLabels(ys: readonly number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y)
  // clusters of labels that share space, each centred on its members' lines
  let groups = order.map(o => ({ members: [o], top: o.y }))
  const place = (g: { members: { y: number }[] }) =>
    g.members.reduce((a, m) => a + m.y, 0) / g.members.length - (g.members.length - 1) * gap / 2
  for (let changed = true; changed;) {
    changed = false
    for (let k = 1; k < groups.length; k++) {
      const a = groups[k - 1]!, b = groups[k]!
      if (a.top + a.members.length * gap > b.top) {
        const merged = { members: [...a.members, ...b.members], top: 0 }
        merged.top = place(merged)
        groups.splice(k - 1, 2, merged)
        changed = true
        break
      }
    }
  }
  const out = new Array<number>(ys.length)
  const flat: { i: number; y: number }[] = []
  for (const g of groups) g.members.forEach((m, j) => flat.push({ i: (m as { i: number }).i, y: g.top + j * gap }))
  // keep the stack inside the plot, pushing neighbours along
  for (let k = 0; k < flat.length; k++) flat[k]!.y = Math.max(flat[k]!.y, lo + k * gap)
  for (let k = flat.length - 1; k >= 0; k--) flat[k]!.y = Math.min(flat[k]!.y, hi - (flat.length - 1 - k) * gap)
  for (const f of flat) out[f.i] = f.y
  return out
}

export type ChartSpec = {
  width: number
  height: number
  bars: number[]
  /** The average, or null with no estimate: then no dotted line. */
  avg: number | null
  limit: number
  xTicks: Array<{ f: number; label: string }>
  marks: Array<{ f: number; label: string }>
  /** The share of the chart, from the left, before recording began with nothing known of it: lightly tinted. */
  unrecorded: number
  /**
   * Stretches whose usage is known only as a total (before recording began,
   * or while this computer wasn't watching): each one low block at the rate
   * that total comes to, labelled with it. Shares of the chart, the rate per
   * bar unit, and a long and a short label.
   */
  blocks: Array<{ f0: number; f1: number; rate: number; label: string; short: string }>
  unitLabel: string
  /** The theme's palettes; absent, the default dark theme's. */
  palettes?: Palettes
}

/**
 * Bars from the average's start to Now in a framed plot, scaled to the tallest
 * bar, with the average (dotted) and limit (solid) lines across all of them.
 * Recorded slices with no usage show as a dashed baseline. A limit above the
 * tallest bar sits on the top edge, its label marked ▲.
 */
export function chartSvg(c: ChartSpec): string {
  const est = c.width, Hh = c.height
  const ax = px('axis')
  const padT = Math.ceil(ax * 1.5 + 12), padB = Math.ceil(ax * 1.5 + 12)
  const peak = Math.max(...c.bars, c.avg ?? 0, ...c.blocks.map(b => b.rate), 0.0001) * 1.04
  const top = peak >= 10 ? Math.ceil(peak / 2) * 2 : peak
  const Y = (v: number) => Hh - padB - Math.min(v, top) / top * (Hh - padT - padB)
  const base = Y(0)
  const num = (v: number) => (top >= 10 ? String(Math.round(v)) : fx(v))
  const veil = (x: number, y: number, w: number, h: number, r = 5) =>
    `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${r}" style="fill:${C.veil}" fill-opacity="0.6"/>`
  let s = `<defs>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${C.barTop}"/><stop offset="1" style="stop-color:${C.barBottom}"/></linearGradient>
    <linearGradient id="plot" x1="0" y1="1" x2="0" y2="0"><stop offset="0" style="stop-color:${C.dim}" stop-opacity="0"/><stop offset="1" style="stop-color:${C.dim}" stop-opacity="0.07"/></linearGradient>
  </defs>`
  s += text(2, padT - ax * 0.6, c.unitLabel)
  s += `<rect x="0" y="${padT}" width="100%" height="${base - padT}" rx="6" fill="url(#plot)"/>`
  for (const g of [top / 4, top / 2, top * 3 / 4]) {
    s += `<line x1="0" x2="100%" y1="${Y(g)}" y2="${Y(g)}" style="stroke:${C.dim}" stroke-opacity="0.18"/>`
  }
  for (const tk of c.xTicks) {
    if (tk.f > 0 && tk.f < 1) s += `<line x1="${pct(tk.f)}" x2="${pct(tk.f)}" y1="${padT}" y2="${base}" style="stroke:${C.dim}" stroke-opacity="0.18" stroke-dasharray="4 4"/>`
    const isNow = tk.f >= 1
    s += text(pct(tk.f), Hh - ax * 0.6, tk.label, { anchor: isNow ? 'end' : tk.f <= 0 ? 'start' : 'middle', ...(isNow ? { fill: C.fg, weight: 600 } : {}) })
  }
  if (c.unrecorded > 0) {
    s += `<rect x="0" y="${padT}" width="${pct(c.unrecorded)}" height="${base - padT}" style="fill:${C.dim}" fill-opacity="0.06"/>`
    if (c.unrecorded * est > textWidth('not recorded', 'axis') + 16) s += text(pct(c.unrecorded / 2), base - ax * 0.6, 'not recorded', { anchor: 'middle' })
  }
  let late = ''   // labels drawn last, over the bars and lines
  // each stretch known only as a total: one low block at the rate it comes to, its line on top, and what's known as its label
  for (const b of c.blocks) {
    const y = Y(b.rate), room = (b.f1 - b.f0) * est
    s += `<rect x="${pct(b.f0)}" y="${y.toFixed(1)}" width="${pct(b.f1 - b.f0)}" height="${(base - y).toFixed(1)}" style="fill:${C.barBottom}" fill-opacity="0.22"/>`
    s += `<line x1="${pct(b.f0)}" x2="${pct(b.f1)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" style="stroke:${C.barBottom}" stroke-width="1.5"/>`
    // above the line, or just inside it when the line is near the top
    const ly = y - 6 - ax < padT ? y + ax + 4 : y - 6
    const fits = (l: string) => textWidth(l, 'axis') + 8 <= room
    const label = fits(b.label) ? b.label : fits(b.short) ? b.short : null
    // on a backing, so a line crossing it doesn't run through the words
    const tag = (x: number, l: string, anchor: 'middle' | 'start') => {
      const w = textWidth(l, 'axis') + 10, bx = anchor === 'middle' ? x - w / 2 : x - 5
      return `<rect x="${bx.toFixed(1)}" y="${(ly - ax).toFixed(1)}" width="${w.toFixed(1)}" height="${(ax + 5).toFixed(1)}" rx="4" style="fill:${C.veil}" fill-opacity="0.6"/>` + text(x, ly, l, { anchor, fill: C.fg })
    }
    if (label) late += at((b.f0 + b.f1) / 2, tag(0, label, 'middle'))
    // too narrow to hold even the short one: it starts at the block and runs right, where there's room
    else if (textWidth(b.short, 'axis') + 8 <= (1 - b.f0) * est) late += at(b.f0, tag(9, b.short, 'start'))
  }
  for (const mk of c.marks) {
    s += `<line x1="${pct(mk.f)}" x2="${pct(mk.f)}" y1="${padT}" y2="${base}" style="stroke:${C.dim}" stroke-dasharray="3 3"/>`
    const w = textWidth(`↺ ${mk.label}`, 'axis') + 12, h = ax + 6
    // near the right edge the label goes on the left of its line, clear of the line labels
    const rx = mk.f * est + 3 + w > est - 190 ? -3 - w : 3
    late += at(mk.f, veil(rx, padT + 4, w, h) + text(rx + 6, padT + 4 + h / 2 + ax * 0.35, `↺ ${mk.label}`, { fill: C.fg }))
  }
  // the scale, inside the plot at its left, on a backing so bars don't run through it
  for (const g of [top / 2, top]) {
    const y = Y(g) + ax + 4, label = num(g)
    late += veil(4, y - ax - 1, textWidth(label, 'axis') + 8, ax + 6, 4) + text(8, y, label)
  }
  const n = Math.max(1, c.bars.length)
  // a recorded slice with no usage shows a dashed baseline; one inside a block or before recording doesn't
  const covered = (f: number) => f < c.unrecorded || c.blocks.some(b => f >= b.f0 && f <= b.f1)
  const bar = (i: number, v: number) => {
    const y = Y(v)
    return `<rect x="${pct((i + 0.25) / n)}" y="${y.toFixed(1)}" width="${pct(0.5 / n)}" height="${Math.max(0, base - y).toFixed(1)}" rx="1.5" fill="url(#bar)"/>`
  }
  c.bars.forEach((v, i) => {
    if (v > 0) s += bar(i, v)
    else if (!covered((i + 0.5) / n)) {
      s += `<line x1="${pct(i / n)}" x2="${pct((i + 1) / n)}" y1="${base - 1}" y2="${base - 1}" style="stroke:${C.barBottom}" stroke-width="1.5" stroke-dasharray="5 4"/>`
    }
  })
  const limitOff = c.limit > top
  const yl = limitOff ? Y(top) : Y(c.limit)
  const ya = c.avg !== null ? Y(c.avg) : null
  s += `<line x1="0" x2="100%" y1="${yl}" y2="${yl}" style="stroke:${C.limit}" stroke-width="2.5"/>`
  if (ya !== null) s += `<line x1="0" x2="100%" y1="${ya}" y2="${ya}" style="stroke:${C.fg}" stroke-width="3" stroke-dasharray="3 5" stroke-linecap="round"/>`
  // the labels sit on their lines at the right edge, each on a backing so bars and lines behind don't show through
  const label = (y: number, s2: string, fill?: string) => {
    const w = textWidth(s2, 'line') + 16, h = px('line') + 8
    return at(1, veil(-4 - w, y - h / 2, w, h, 6) + text(-12, y + px('line') * 0.35, s2, { role: 'line', anchor: 'end', ...(fill ? { fill } : {}) }))
  }
  // keep the labels clear of each other and inside the plot
  const [lY, aY] = spreadLabels(ya === null ? [yl] : [yl, ya], px('line') + 12, padT + px('line') / 2 + 6, base - px('line') / 2 - 6)
  s += late
  s += label(lY!, `limit ${fx(c.limit)}${limitOff ? ' ▲' : ''}`, C.limit)
  if (aY !== undefined && c.avg !== null) s += label(aY, `average ${fx(c.avg)}`)
  return drawing(s, Hh, c.palettes ?? DEFAULT_PALETTES)
}
/** The weekly chart for model `m` at `now`. */
export function weekChart(m: Model, now: number, width: number, pal: Palettes = DEFAULT_PALETTES, height = 400): string {
  return timeChart(m, now, width, height, pal)
}

/** The 5-hour chart: the window since it opened. */
export function fiveChart(m: Model, now: number, width: number, pal: Palettes = DEFAULT_PALETTES, height = 300): string {
  return timeChart(m, now, width, height, pal)
}

/**
 * Recorded usage a chart needs before its bars mean anything: the weekly
 * figure moves in steps of about a point, so it needs hours to show a shape;
 * the 5-hour one, half an hour.
 */
export const CHART_NEEDS_H = { week: 6, five: 0.5 }

/** Hours until the chart has enough recorded behind it; 0 once it has. */
export const chartWait = (m: Model, now: number) => Math.max(0, CHART_NEEDS_H[m.kind] - (now - m.recordedFrom) / HOUR)


/**
 * What the empty state says in the chart's place, or null when there is a
 * chart to draw: an average that can't be worked out yet (a window shorter
 * than the least, or longer than the record; too soon after the reset), or a
 * record too short for the bars to show a shape.
 */
export function emptyChartText(m: Model, now: number): [string, string] | null {
  const name = m.kind === 'week' ? 'Weekly' : '5-hour'
  const recordedH = (now - m.recordedFrom) / HOUR
  const avg = m.average
  if (avg.type === 'hours' && avg.hours < MIN_RECORDED_H[m.kind]) {
    return [`${name} averages need at least ${dur(MIN_RECORDED_H[m.kind])}`, `Pick a window of ${dur(MIN_RECORDED_H[m.kind])} or more, or Since reset.`]
  }
  if (avg.type === 'hours' && avg.hours > recordedH) {
    return [`Needs ${dur(avg.hours)} of recorded usage`, `About ${dur(avg.hours - recordedH)} to go. ${dur(recordedH)} recorded so far.`]
  }
  if (m.noData) return ['No estimate yet', m.noData]
  const wait = chartWait(m, now)
  if (wait > 0) return [`Chart in about ${dur(wait)}`, `It shows once ${dur(CHART_NEEDS_H[m.kind])} of usage is recorded. The figures above already count.`]
  return null
}

/** In the chart's place until it has enough behind it: what it waits for, and how long that takes. */
function emptyLayout(m: Model, now: number, width: number) {
  const [head, sub] = emptyChartText(m, now) ?? ['', '']
  const lines = wrap(sub, Math.max(160, width - 32), 'note')
  const top = 24 + px('caption')
  return { head, lines, top, height: Math.ceil(top + 10 + linesHeight(lines.length, 'note') + 18) }
}


export function emptyChartSvg(m: Model, now: number, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  const L = emptyLayout(m, now, width), H = L.height
  // a dashed box edge to edge: its right side drawn from the right edge in
  const dash = `style="stroke:${C.dim}" stroke-opacity="0.35" stroke-dasharray="4 5"`
  const s = `<line x1="1" x2="100%" y1="1" y2="1" ${dash}/><line x1="1" x2="100%" y1="${H - 1}" y2="${H - 1}" ${dash}/>`
    + `<line x1="1" x2="1" y1="1" y2="${H - 1}" ${dash}/>` + at(1, `<line x1="-1" x2="-1" y1="1" y2="${H - 1}" ${dash}/>`)
    + text('50%', L.top, L.head, { role: 'caption', anchor: 'middle', fill: C.fg })
    + L.lines.map((l, i) => text('50%', L.top + 10 + baseline(i, 'note'), l, { role: 'note', anchor: 'middle' })).join('')
  return drawing(s, H, pal)
}
/** Text broken into lines that fit `width` in a role's style; paragraphs split on newlines. */
function wrap(note: string, width: number, role: Role): string[] {
  const lines: string[] = []
  for (const para of note.split('\n')) {
    let first = true
    for (const word of para.split(' ')) {
      const last = lines[lines.length - 1]
      if (!first && last !== undefined && textWidth(`${last} ${word}`, role) <= width) lines[lines.length - 1] = `${last} ${word}`
      else lines.push(word)
      first = false
    }
  }
  return lines
}
/** A wrapped line's baseline, and the height `n` lines take. */
const baseline = (i: number, role: Role) => (i + 1) * px(role) * 1.4 - px(role) * 0.3
const linesHeight = (n: number, role: Role) => Math.ceil(n * px(role) * 1.4 + px(role) * 0.3)

/** Text in a role's style, wrapped to `width`. `fill` where state sets the colour. */
export function noteSvg(note: string, width: number, pal: Palettes = DEFAULT_PALETTES, role: Role = 'note', fill?: string): string {
  const lines = wrap(note, width, role), H = linesHeight(lines.length, role)
  return drawing(lines.map((l, i) => text(0, baseline(i, role), l, { role, ...(fill ? { fill } : {}) })).join(''), H, pal)
}

// ---- recent pace ----

/** The stretch the recent pace looks back over. */
export const PACE_HOURS = 1
/** Weekly points recorded alongside the 5-hour figure before the two can be related. */
export const PACE_MIN_POINTS = 3

export type Pace =
  | { ready: false; why: string }
  | {
    ready: true
    /** 5-hour points per weekly point, over `basisH` hours of record. */
    ratio: number
    basisH: number
    /** 5-hour points used in the last PACE_HOURS. */
    recent: number
    /** The weekly pace that is, in % per hour. */
    rate: number
    runsOutIn: number
    early: number
    over: boolean
    arrive: number
  }

/**
 * The weekly limit at the last hour's pace. The weekly figure moves in whole
 * points, too coarse to read an hour from; the 5-hour figure moves several
 * times faster. Over the record, the 5-hour points that went with each weekly
 * point give the exchange rate; the last hour's 5-hour points, so exchanged,
 * give the weekly pace.
 */
export function recentPace(readings: readonly RangeReading[], week: Model, now: number, seen: readonly Watch[] = []): Pace {
  const fives = ofKind(readings, 'five'), weeks = ofKind(readings, 'week')
  if (!fives.length || !weeks.length) return { ready: false, why: 'Your weekly and 5-hour usage arrive with Claude’s next response.' }
  const fiveFor = (now - fives[0]![0]) / HOUR
  if (fiveFor < PACE_HOURS) return { ready: false, why: `It needs ${dur(PACE_HOURS)} of recording. About ${dur(PACE_HOURS - fiveFor)} to go.` }
  const start = Math.max(fives[0]![0], weeks[0]![0])
  const fiveIncs = increments(readings, 'five', seen)
  const weekPoints = usedBetween(week.increments, start, now)
  if (weekPoints < PACE_MIN_POINTS) {
    return { ready: false, why: `It needs your weekly usage to go up ${PACE_MIN_POINTS}% while recording. Up ${Math.floor(weekPoints)}% so far.` }
  }
  // the last hour has to be on record here, not a gap whose rise was placed in it afterwards
  if (!isWatched(seen, now - PACE_HOURS * HOUR, now)) return { ready: false, why: `It needs the last ${dur(PACE_HOURS)} recorded without a break.` }
  const ratio = usedBetween(fiveIncs, start, now) / weekPoints
  const recent = usedBetween(fiveIncs, now - PACE_HOURS * HOUR, now)
  const rate = ratio > 0 ? recent / ratio / PACE_HOURS : 0
  const proj = week.pct + rate * week.left
  const runsOutIn = rate > 0 ? (100 - week.pct) / rate : Infinity
  return {
    ready: true, ratio, basisH: (now - start) / HOUR, recent, rate, runsOutIn,
    early: Math.max(0, week.left - runsOutIn), over: proj > 100, arrive: 100 - proj,
  }
}

/** The caption of the pace figure. */
export const PACE_LABEL = '1hr pace'

/**
 * The head and the chart (or its empty state) as one drawing, so the head's
 * info circle can open its tooltip over the chart. A click or the pointer on
 * the circle opens it, a click elsewhere closes it: no script, the circle
 * takes focus on a click and CSS shows the box while it has focus or the
 * pointer. Drawn interactive for that.
 */
export function withInfo(head: { svg: string; height: number; info?: InfoSpot }, chart: string, tip: string, width: number, pal: Palettes = DEFAULT_PALETTES, label = 'How is the 1hr pace worked out?'): string {
  const inner = (svg: string) => /^<svg [^>]*>([\s\S]*)<\/svg>$/.exec(svg)![1]!
  const hH = drawingHeight(head.svg), cH = drawingHeight(chart), gap = 10
  const nest = (svg: string, y: number, h: number) => `<svg x="0" y="${y}" width="100%" height="${h}" overflow="visible">${inner(svg)}</svg>`
  let H = hH + gap + cH, over = ''
  if (head.info) {
    const { cx, cy, r } = head.info
    const boxW = Math.min(width, 440), pad = 12
    const lines = wrap(tip, boxW - pad * 2, 'note')
    const boxH = linesHeight(lines.length, 'note') + pad * 2 - px('note') * 0.3
    // the box opens just under the circle and ends at it, so it stays inside the card whatever its real width
    const bx = Math.max(0, cx + r + 4 - boxW), by = cy + r + 8
    H = Math.max(H, Math.ceil(by + boxH + 2))
    const info = `<g class="info" tabindex="0" role="button" aria-label="${esc(label)}">`
      + `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r + 4).toFixed(1)}" fill="transparent"/>`
      + `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="transparent" style="stroke:${C.dim}" stroke-width="1.2"/>`
      + `<text x="${cx.toFixed(1)}" y="${(cy + r * 0.55).toFixed(1)}" text-anchor="middle" style="fill:${C.dim}" font-family="${FONT}" font-size="${(r * 1.5).toFixed(1)}" font-weight="600">i</text></g>`
    const box = `<g class="tip"><rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${boxW}" height="${boxH.toFixed(1)}" rx="8" style="fill:${C.veil};stroke:${C.dim}" fill-opacity="0.94" stroke-opacity="0.4"/>`
      + lines.map((l, i) => text(bx + pad, by + pad + baseline(i, 'note') - px('note') * 0.15, l, { role: 'note', fill: C.fg })).join('') + `</g>`
    const css = `<style>.info{cursor:pointer;outline:none}.info:hover circle+circle,.info:focus circle+circle{stroke:var(--fg)}.info:hover text,.info:focus text{fill:var(--fg)}`
      + `.tip{display:none}.info:hover~.tip,.info:focus~.tip{display:inline}</style>`
    over = css + info + box
  }
  return drawing(nest(head.svg, 0, hH) + nest(chart, hH + gap, cH) + over, H, pal)
}
/** What the pace comes to: the tooltip's first line. */
export function paceText(p: Pace): string {
  if (!p.ready) return `No pace yet. ${p.why}`
  return p.over
    ? `At this pace, the weekly limit runs out ${dur(p.early)} early.`
    : `At this pace, the weekly limit lasts to the reset with ${Math.max(0, Math.round(p.arrive))}% left.`
}

/** How the pace is worked out, with this account's own numbers once there are some. */
export function paceExplain(p: Pace): string {
  if (!p.ready) return 'While recording, the plugin learns how much of your 5-hour limit goes with each 1% of your weekly limit.'
  return [
    `In the last hour you used ${fx(p.recent)}% of your 5-hour limit. That's about ${fx(p.recent / p.ratio, 2)}% of your weekly limit, or ${fx(p.rate * 24)}% a day.`,
    'These numbers are estimates that get steadier over time.',
  ].join('\n')
}

// ---- fitting the pane ----

/**
 * A cell of the desktop's code font in CSS pixels, as measured in the Code
 * tab: the pane reports its width in these cells, the drawings are in pixels.
 */
export const CELL_PX = { w: 9.5 }

export type Fit = { width: number; weekHeight: number; fiveHeight: number }

/** Chart heights: a share of the card's width, within bounds. */
const CHART_H = { week: { ratio: 0.55, min: 260, max: 440 }, five: { ratio: 0.42, min: 200, max: 340 } }

/**
 * Sizes the drawings for a pane `columns` wide: the card's inner width, for
 * what wraps, and each chart's height, which follows that width.
 */
export function fit(columns: number): Fit {
  // the card's inner width: the pane less the card's padding and edge. Drawings fill whatever width they get;
  // this is for laying out what wraps (figures, notes) and for the charts' heights
  const width = Math.max(240, Math.floor((columns - 6) * CELL_PX.w))
  // the pane's reported rows don't follow its real height in the desktop app, so the charts' heights
  // follow the card's width instead: a wider card, a taller chart, within bounds
  const tall = (k: 'week' | 'five') => Math.round(Math.min(CHART_H[k].max, Math.max(CHART_H[k].min, width * CHART_H[k].ratio)))
  return { width, weekHeight: tall('week'), fiveHeight: tall('five') }
}
const pctText = (v: number) => (v > 0 && v < 1 ? '<1%' : `${Math.round(v)}%`)

/**
 * The chart's stretches known only as a total: before recording began (the
 * first reading's figure, since the reset), and each gap this computer wasn't
 * watching. A weekly gap's rise could have come anywhere in it, so its block
 * spans the gap; a 5-hour one belongs to the window it was seen in, so its
 * block starts no earlier than the window opened.
 */
function knownBlocks(m: Model, now: number, perHours: number): ChartSpec['blocks'] {
  const span = now - m.from, out: ChartSpec['blocks'] = []
  const add = (a: number, b: number, amount: number, what: (p: string, h: string) => [string, string]) => {
    const v0 = Math.max(a, m.from), v1 = Math.min(b, now)
    if (v1 <= v0 || amount <= 0) return
    const shown = amount * (v1 - v0) / (b - a), hours = (v1 - v0) / HOUR
    const [label, short] = what(pctText(shown), dur(hours))
    out.push({ f0: (v0 - m.from) / span, f1: (v1 - m.from) / span, rate: shown / hours * perHours, label, short })
  }
  if (m.before) add(m.from, m.before.until, m.before.pct, p => [`${p} before tracking`, p])
  for (const inc of m.increments) {
    if (!inc.hole) continue
    add(m.kind === 'week' ? inc.hole[0] : inc.start, inc.end, inc.amount, (p, h) => [`${p} used while away, ${h}`, `${p} · ${h}`])
  }
  return out
}

function timeChart(m: Model, now: number, width: number, height: number, palettes: Palettes): string {
  const isWeek = m.kind === 'week'
  const values = bars(m, now, bucketMinutes(m.winH * 60), isWeek ? 24 : 1)
  const barMin = m.winH * 60 / values.length
  const ago = (h: number) => h >= 48 ? `−${Math.round(h / 24)}d` : h >= 2 ? `−${Math.round(h)}h` : `−${Math.round(h * 60)}m`
  // the axis keeps one unit across, picked by the window's length
  const tick = (h: number) => m.winH >= 48 ? `−${fx(h / 24, h / 24 < 10 && h % 24 ? 1 : 0)}d`
    : m.winH >= 2 ? `−${Math.round(h * 10) % 10 && h < 5 ? fx(h) : Math.round(h)}h`
    : `−${Math.round(h * 60)}m`
  const perHours = isWeek ? 24 : 1
  const marks: ChartSpec['marks'] = []
  for (let k = 0; isWeek && k < 4; k++) {
    const at = m.resetsAt - (k + 1) * SPAN.week
    if (at > m.from && at < now) marks.push({ f: (at - m.from) / (now - m.from), label: `reset ${ago((now - at) / HOUR)}` })
  }
  return chartSvg({
    width, height, bars: values, avg: m.noData ? null : m.rate * (isWeek ? 24 : 1), limit: m.limit * (isWeek ? 24 : 1),
    xTicks: [0, 0.25, 0.5, 0.75].map(f => ({ f, label: tick(m.winH * (1 - f)) })).concat({ f: 1, label: 'Now' }),
    marks,
    unrecorded: m.before ? 0 : Math.min(1, Math.max(0, (m.recordedFrom - m.from) / (now - m.from))),
    blocks: knownBlocks(m, now, perHours),
    palettes,
    unitLabel: `% per ${isWeek ? 'day' : 'hour'} · bar = ${barMin >= 60 ? dur(barMin / 60) : `${Math.max(1, Math.round(barMin))}m`}`,
  })
}
