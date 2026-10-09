import type { RangeReading, RangeSettings } from '../types'

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
export const FIVE_WINDOW_MIN = 30

export const windowHours = (s: Pick<RangeSettings, 'n' | 'unit'>) => Math.min(s.n * UNIT_HOURS[s.unit], KEEP / HOUR - 24)
export const windowName = (s: Pick<RangeSettings, 'n' | 'unit'>) => `${s.n}${s.unit}`

/** What an average covers: the last `hours`, or the time since the reset. */
export type Average = { type: 'hours'; hours: number } | { type: 'reset' }

/**
 * Least data behind any average before it is an estimate. The weekly figure moves
 * in coarse steps, so under six hours one step reads as a huge rate.
 */
export const MIN_RECORDED_H = { week: 6, five: 5 / 60 }
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
  /** Time inside the gap this computer didn't watch and nothing was placed in: drawn as "not watched". */
  hole?: [number, number]
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
    if (sameWindow(a, b)) {
      amount = b[2] - high
      high = Math.max(high, b[2])
    } else {
      amount = b[2]
      high = b[2]
      start = Math.max(start, b[3] - SPAN[kind])
    }
    if (amount > 0) out.push({ start: Math.min(start, b[0] - 1), end: b[0], amount, ...(hole ? { hole } : {}) })
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
  /** Stretches this computer wasn't watching, where nothing was placed: drawn as "not watched". */
  holes: Array<[number, number]>
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
  return {
    kind, pct, resetsAt, left, rate, limit: remaining / left, arrive: 100 - proj, over: proj > 100,
    runsOutIn, early: Math.max(0, left - runsOutIn), average: avg, from, winH, recordedFrom, holes: incs.flatMap(i => (i.hole ? [i.hole] : [])), noData, increments: incs,
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
  for (let i = 0; i < n; i++) {
    const s = m.from + i * width
    out.push(usedBetween(m.increments, s, s + width) / (width / HOUR) * perHours)
  }
  return out
}

// ---- words ----

export const signed = (x: number) => (Math.round(x) >= 0 ? '+' : '−') + Math.abs(Math.round(x)) + '%'
export const fx = (v: number, d = 1) => v.toFixed(d)

export function dur(h: number): string {
  if (!isFinite(h)) return '—'
  if (h >= 24) return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`
  if (h >= 1) return `${Math.floor(h)}h ${String(Math.round(h % 1 * 60)).padStart(2, '0')}m`
  return `${Math.max(0, Math.round(h * 60))}m`
}

/** "Resets in 3.7 days" / "Resets in 89 hours", and for the 5-hour window hours / minutes. */
export function resetsIn(m: Model, fine: boolean): string {
  if (m.kind === 'week') return fine ? `Resets in ${Math.round(m.left)} hours` : `Resets in ${fx(m.left / 24)} days`
  return fine ? `Resets in ${Math.round(m.left * 60)} minutes` : `Resets in ${fx(m.left)} hours`
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
      ? `Average since ${since} ${dur(m.winH)} ago, from Anthropic's figure. Bars show only what was recorded.`
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

/** The card's palette: always dark, like the car display it copies, in the warm neutrals of Claude's dark theme. */
export const C = {
  card: '#1f1e1d', plotTop: '#2c2a27', frame: '#3b3935', grid: '#302e2b', fg: '#f5f4ee', dim: '#a8a59c', off: '#5e5b55',
  barTop: '#ffa040', barBottom: '#f0601c', limit: '#22d3e6', over: '#ff8a3d', under: '#5fd49a', bad: '#ff5a4f',
}
const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const text = (x: number, y: number, s: string, o: { size?: number; fill?: string; anchor?: string; weight?: number } = {}) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${o.anchor ?? 'start'}" fill="${o.fill ?? C.dim}" font-family="${FONT}" font-size="${o.size ?? 13}" font-weight="${o.weight ?? 400}">${esc(s)}</text>`

/**
 * The card's head: the title, the run-out line when the projection goes over,
 * and the three figures. The reset countdown beside it is a Button, not drawn here.
 */
export function headerSvg(m: Model, title: string, width: number): string {
  const isOver = m.over && !m.noData
  const H = isOver ? 150 : 122
  const top = isOver ? 96 : 68
  let s = text(0, 30, title, { size: 30, fill: C.fg, weight: 700 })
  if (isOver) s += text(0, 64, runsOut(m), { size: 17, fill: C.over, weight: 500 })
  const stats: Array<[string, string, string]> = [
    [m.kind === 'week' ? 'Left at week reset' : 'Left at 5h reset', m.noData ? 'No data' : signed(m.arrive), m.noData ? C.dim : m.over ? C.bad : C.under],
    ['Average', m.noData ? 'No data' : rateText(m, m.rate), m.noData ? C.dim : C.fg],
    ['Limit', rateText(m, m.limit), C.fg],
  ]
  let x = 0
  for (const [label, value, fill] of stats) {
    s += text(x, top, label, { size: 15 })
    s += text(x, top + 34, value, { size: 26, fill, weight: 700 })
    x += Math.max(label.length * 8.2, value.length * 15.5) + 40
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${H}" width="${width}" height="${H}">${s}</svg>`
}

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
  /** The share of the chart, from the left, before recording began: hatched, no bars. */
  unrecorded: number
  /** Stretches this computer wasn't watching, as shares of the chart: hatched, marked "not watched". */
  holes: Array<[number, number]>
  unitLabel: string
}

/**
 * Bars from the average's start to Now in a framed plot, scaled to the tallest
 * bar, with the average (dotted) and limit (solid) lines across all of them.
 * Recorded slices with no usage show as a dashed baseline. A limit above the
 * tallest bar sits on the top edge, its label marked ▲.
 */
export function chartSvg(c: ChartSpec): string {
  const W = c.width, Hh = c.height
  const padL = 52, padR = 6, padT = 40, padB = 40
  const peak = Math.max(...c.bars, c.avg ?? 0, 0.0001) * 1.04
  const top = peak >= 10 ? Math.ceil(peak / 2) * 2 : peak
  const X = (f: number) => padL + f * (W - padL - padR)
  const Y = (v: number) => Hh - padB - Math.min(v, top) / top * (Hh - padT - padB)
  const base = Y(0), right = X(1)
  const num = (v: number) => (top >= 10 ? String(Math.round(v)) : fx(v))
  let s = `<defs>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.barTop}"/><stop offset="1" stop-color="${C.barBottom}"/></linearGradient>
    <linearGradient id="plot" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${C.card}"/><stop offset="1" stop-color="${C.plotTop}"/></linearGradient>
    <pattern id="nr" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="${C.grid}" stroke-width="2.5"/></pattern>
  </defs>`
  s += text(padL + 10, padT - 14, c.unitLabel, { size: 15 })
  s += `<rect x="${padL}" y="${padT}" width="${right - padL}" height="${base - padT}" rx="6" fill="url(#plot)" stroke="${C.frame}"/>`
  for (const g of [top / 4, top / 2, top * 3 / 4]) {
    s += `<line x1="${padL}" x2="${right}" y1="${Y(g)}" y2="${Y(g)}" stroke="${C.grid}"/>`
  }
  for (const g of [0, top / 2, top]) s += text(padL - 12, Y(g) + 5, num(g), { size: 15, anchor: 'end' })
  for (const tk of c.xTicks) {
    if (tk.f > 0 && tk.f < 1) s += `<line x1="${X(tk.f)}" x2="${X(tk.f)}" y1="${padT}" y2="${base}" stroke="${C.grid}" stroke-dasharray="4 4"/>`
    const isNow = tk.f >= 1
    s += text(X(tk.f), Hh - 10, tk.label, { size: 16, anchor: isNow ? 'end' : tk.f <= 0 ? 'start' : 'middle', fill: isNow ? C.fg : C.dim, weight: isNow ? 600 : 400 })
  }
  if (c.unrecorded > 0) {
    const x1 = X(c.unrecorded)
    s += `<rect x="${padL + 1}" y="${padT + 1}" width="${Math.max(0, x1 - padL - 1)}" height="${base - padT - 2}" fill="url(#nr)"/>`
    if (x1 - padL > 90) s += text((padL + x1) / 2, base - 10, 'not recorded', { anchor: 'middle' })
  }
  for (const [f0, f1] of c.holes) {
    const x0 = X(Math.max(f0, c.unrecorded)), x1 = X(f1)
    if (x1 - x0 < 1) continue
    s += `<rect x="${x0}" y="${padT + 1}" width="${x1 - x0}" height="${base - padT - 2}" fill="url(#nr)"/>`
    if (x1 - x0 > 90) s += text((x0 + x1) / 2, base - 10, 'not watched', { anchor: 'middle' })
  }
  let late = ''   // labels drawn last, over the bars
  for (const mk of c.marks) {
    s += `<line x1="${X(mk.f)}" x2="${X(mk.f)}" y1="${padT}" y2="${base}" stroke="${C.dim}" stroke-dasharray="3 3"/>`
    const w = (mk.label.length + 2) * 7.6 + 10
    // near the right edge the label goes on the left of its line, clear of the line labels
    const rx = X(mk.f) + 3 + w > right - 190 ? X(mk.f) - 3 - w : X(mk.f) + 3
    late += `<rect x="${rx}" y="${padT + 4}" width="${w}" height="18" rx="5" fill="${C.card}" fill-opacity="0.92"/>`
    late += text(rx + 5, padT + 17, `↺ ${mk.label}`, { fill: C.fg })
  }
  const slot = (right - padL) / Math.max(1, c.bars.length), bw = Math.max(2, slot * 0.5)
  const firstRecorded = c.unrecorded * c.bars.length
  c.bars.forEach((v, i) => {
    const x0 = padL + slot * i, cx = x0 + slot / 2
    if (v > 0) {
      const y = Y(v)
      s += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, base - y).toFixed(1)}" rx="1.5" fill="url(#bar)"/>`
    } else if (i + 1 > firstRecorded) {
      s += `<line x1="${(x0 + 3).toFixed(1)}" x2="${(x0 + slot - 3).toFixed(1)}" y1="${base - 1}" y2="${base - 1}" stroke="${C.barBottom}" stroke-width="1.5" stroke-dasharray="5 4"/>`
    }
  })
  const limitOff = c.limit > top
  const yl = limitOff ? Y(top) : Y(c.limit)
  const ya = c.avg !== null ? Y(c.avg) : null
  s += `<line x1="${padL}" x2="${right}" y1="${yl}" y2="${yl}" stroke="${C.limit}" stroke-width="2.5"/>`
  if (ya !== null) s += `<line x1="${padL}" x2="${right}" y1="${ya}" y2="${ya}" stroke="${C.fg}" stroke-width="3" stroke-dasharray="3 5" stroke-linecap="round"/>`
  // the labels sit on their lines, each on a backing in the card's colour so bars and lines behind don't show through
  const label = (y: number, s2: string, fill: string) => {
    const w = s2.length * 8.8 + 16, h = 24, x = right - 4 - w
    return `<rect x="${x.toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="6" fill="${C.card}" fill-opacity="0.92"/>`
      + text(right - 12, y + 5.5, s2, { size: 16, fill, anchor: 'end' })
  }
  // keep the labels clear of each other and inside the plot
  const [lY, aY] = spreadLabels(ya === null ? [yl] : [yl, ya], 28, padT + 14, base - 14)
  s += late
  s += label(lY!, `limit ${fx(c.limit)}${limitOff ? ' ▲' : ''}`, C.limit)
  if (aY !== undefined && c.avg !== null) s += label(aY, `average ${fx(c.avg)}`, C.fg)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}">${s}</svg>`
}

/** The weekly chart for model `m` at `now`. */
export function weekChart(m: Model, now: number, width: number): string {
  return timeChart(m, now, width, 400)
}

/** The 5-hour chart: normally the last 30 minutes, about a bar a minute. */
export function fiveChart(m: Model, now: number, width: number): string {
  return timeChart(m, now, width, 300)
}

function timeChart(m: Model, now: number, width: number, height: number): string {
  const isWeek = m.kind === 'week'
  const values = bars(m, now, bucketMinutes(m.winH * 60), isWeek ? 24 : 1)
  const barMin = m.winH * 60 / values.length
  const ago = (h: number) => h >= 48 ? `−${Math.round(h / 24)}d` : h >= 2 ? `−${Math.round(h)}h` : `−${Math.round(h * 60)}m`
  const marks: ChartSpec['marks'] = []
  for (let k = 0; isWeek && k < 4; k++) {
    const at = m.resetsAt - (k + 1) * SPAN.week
    if (at > m.from && at < now) marks.push({ f: (at - m.from) / (now - m.from), label: `reset ${ago((now - at) / HOUR)}` })
  }
  return chartSvg({
    width, height, bars: values, avg: m.noData ? null : m.rate * (isWeek ? 24 : 1), limit: m.limit * (isWeek ? 24 : 1),
    xTicks: [0, 0.25, 0.5, 0.75].map(f => ({ f, label: ago(m.winH * (1 - f)) })).concat({ f: 1, label: 'Now' }),
    marks,
    unrecorded: Math.min(1, Math.max(0, (m.recordedFrom - m.from) / (now - m.from))),
    holes: m.holes
      .map(([a, b]): [number, number] => [(a - m.from) / (now - m.from), (b - m.from) / (now - m.from)])
      .filter(([a, b]) => b > 0 && a < 1)
      .map(([a, b]): [number, number] => [Math.max(0, a), Math.min(1, b)]),
    unitLabel: `% per ${isWeek ? 'day' : 'hour'} · bar = ${barMin >= 60 ? dur(barMin / 60) : `${Math.max(1, Math.round(barMin))}m`}`,
  })
}
