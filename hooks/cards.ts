import type { Palettes, RangeDay } from '../types'
import { C, DAY, HOUR, LAST_LABEL, drawing, dur, isShort, lastIsShort, lastWindowText, leftText, rateText, spare } from './range'
import type { BandPart, LastWindow, Model } from './range'
import type { WeekPlan } from './pace'
import { DEFAULT_PALETTES } from './theme'
import { NARROW, SIZE, cardHeader, icon, metricGrid, rect, rich, stripes, t, tile, topRounded, track, trackLabels, tw } from './ui'
import type { Run } from './ui'

/**
 * 1.4's cards: the weekly card in two frames (the week, 100% = the weekly
 * limit; today, 100% = today's budget), the 5-hour card,
 * and the line above the prompt. Every % names its 100%, and no figure mixes
 * the two frames: one sentence gives today's budget in week terms.
 */

// ---- clock words ----

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number) => String(n).padStart(2, '0')
/** Local clock time: "00:09". */
export const hm = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
/** The local weekday, short: "Wed". */
export const dayName = (t: number) => DAYS[new Date(t).getDay()]!
/** A day and time: "Thu 11:00". */
export const dayTime = (t: number) => `${dayName(t)} ${hm(t)}`
/** About when, to the quarter hour: "Wed ~12:45". */
export const around = (t: number) => { const q = Math.round(t / (15 * 60_000)) * 15 * 60_000; return `${dayName(q)} ~${hm(q)}` }
/** One decimal, a whole number without it: "13.5", "39". */
export const one = (n: number) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '')

// ---- the line above the prompt ----

/** One limit's part of the line: as 1.3's, plus whether it reads as short or as what's left at the reset, and a tag ("early"). */
export type Part = BandPart & { bad: boolean; dim: boolean; spare?: boolean; tag?: string }

/**
 * The week's part. Lasting: "~6% left at reset ±12, in 4d 13h" (narrow "~6% @reset 4d 13h"). Short: "runs out
 * Wed ~12:45, 22h early" (narrow "out Wed 12:45"). Before a whole day is on record, 1.3's hourly figure
 * with the tag "early".
 */
export function weekPart(p: WeekPlan, short: boolean): Part {
  const label = 'Week', leftH = (p.resetsAt - p.now) / HOUR
  if (p.noData) return { label, value: 'No data', rest: '', bad: false, dim: true }
  const tag = p.basis === 'early' ? { tag: 'early' } : {}
  if (p.pct >= 100) return { label, value: short ? `out to ${hm(p.resetsAt)}` : `out until ${dayTime(p.resetsAt)}`, rest: '', bad: true, dim: false }
  if (p.runsOutAt !== null) {
    if (p.basis === 'early') return short
      ? { label, value: `out in ${dur((p.runsOutAt - p.now) / HOUR)}`, rest: '', bad: true, dim: false, ...tag }
      : { label, value: `runs out in ${dur((p.runsOutAt - p.now) / HOUR)}`, rest: `, ${dur(p.early)} early`, bad: true, dim: false, ...tag }
    const when = p.runsOutToday ? 'later today' : around(p.runsOutAt)
    return short
      ? { label, value: `out ${p.runsOutToday ? 'today' : when.replace('~', '')}`, rest: '', bad: true, dim: false }
      : { label, value: `runs out ${when}`, rest: `, ${dur(p.early)} early`, bad: true, dim: false }
  }
  const miss = p.miss ? ` ±${p.miss}` : ''
  return short
    ? { label, value: `~${Math.max(0, Math.round(p.left))}% @reset${miss}`, rest: ` ${dur(leftH)}`, bad: false, dim: false, spare: true, ...tag }
    : { label, value: `~${Math.max(0, Math.round(p.left))}% left at reset${miss}`, rest: `, in ${dur(leftH)}`, bad: false, dim: false, spare: true, ...tag }
}

/** When the 5-hour limit runs out at this pace (ms), or null when it lasts to the reset. */
export const cutOff = (m: Model, now: number) => (m.over && !m.noData ? Math.round((now + m.runsOutIn * HOUR) / 60_000) * 60_000 : null)

/** The 5-hour part, in clock times: "cut off ~00:09, resets 00:40" or "~55% left at 15:40" (narrow "out 00:09", "~55% @15:40"). */
export function fivePart(m: Model, now: number, short: boolean): Part {
  const label = '5h'
  if (m.noData) return { label, value: 'No data', rest: '', bad: false, dim: true }
  if (m.pct >= 100) return { label, value: short ? `out to ${hm(m.resetsAt)}` : `out until ${hm(m.resetsAt)}`, rest: '', bad: true, dim: false }
  const cut = cutOff(m, now)
  if (cut !== null) return short
    ? { label, value: `out ${hm(cut)}`, rest: '', bad: true, dim: false }
    : { label, value: `cut off ~${hm(cut)}`, rest: `, resets ${hm(m.resetsAt)}`, bad: true, dim: false }
  return short
    ? { label, value: `~${Math.max(0, Math.round(m.arrive))}% @${hm(m.resetsAt)}`, rest: '', bad: false, dim: false, spare: true }
    : { label, value: `~${Math.max(0, Math.round(m.arrive))}% left at ${hm(m.resetsAt)}`, rest: '', bad: false, dim: false, spare: true }
}

/** About how many cells the line takes: the parts, their tags, the " · " between them, and the Details button. */
export const partsWidth = (parts: Part[]) =>
  parts.reduce((w, p) => w + p.label.length + 1 + p.value.length + p.rest.length + (p.tag ? p.tag.length + 1 : 0), 0)
  + Math.max(0, parts.length - 1) * 3 + 1 + 11

// ---- the weekly card's words ----

/** The days of this window so far, each in % of the weekly limit, from the daily totals (0 for a day not on record). */
export function pastDays(p: WeekPlan, totals: readonly RangeDay[]): number[] {
  const open = p.resetsAt - 7 * DAY
  return Array.from({ length: p.k }, (_, i) => totals.find(d => Math.abs(d[0] - (open + i * DAY)) < HOUR)?.[1] ?? 0)
}

/** How the projection was made, for the line under the head. */
export function basisText(p: WeekPlan): string {
  if (p.basis === 'profile') return 'At what you usually use on each of the days left.'
  if (p.basis === 'early') return 'Early estimate: no whole day is on record yet, so this is 1.3’s hourly figure.'
  return `At your pace over the last ${p.paceDays === 1 ? 'whole day' : `${p.paceDays} whole days`}: ${one(p.pacePerDay)}% a day.`
}

/** The week's head and the line under it: what's left at the reset, or when it runs out, and what that's based on. */
export function weekHead(p: WeekPlan): { head: string; tone: 'good' | 'bad' | 'dim'; sub: string } {
  if (p.noData) return { head: 'No estimate yet', tone: 'dim', sub: p.noData }
  if (p.pct >= 100) return { head: `Out until ${dayTime(p.resetsAt)}`, tone: 'bad', sub: 'The weekly limit is reached.' }
  if (p.runsOutAt !== null) {
    const when = p.basis === 'early' ? `in ${dur((p.runsOutAt - p.now) / HOUR)}` : p.runsOutToday ? 'later today' : around(p.runsOutAt)
    return { head: `Runs out ${when}, ${dur(p.early)} before the reset`, tone: 'bad', sub: basisText(p) }
  }
  const left = Math.max(0, Math.round(p.left))
  let sub = basisText(p)
  if (p.miss) {
    const lo = left - p.miss, hi = left + p.miss
    sub += ` Your projections have typically been off by ${p.miss} points, so read it as ${lo < 0 ? `between ${-lo}% short and ${hi}% to spare` : `${lo}–${hi}% to spare`}.`
  }
  return { head: `About ${left}% left at the reset${p.miss ? ` ±${p.miss}` : ''}`, tone: 'good', sub }
}

/** What's projected on top of what's used, to the reset: today's rest and the later days. */
export const toCome = (p: WeekPlan) => p.today - p.usedToday + p.later.reduce((a, d) => a + d.amount, 0)

/** The week bar's labels: used, what the pace adds, and the end. */
export function weekBarLabels(p: WeekPlan): { used: string; add: string | null; addBad: boolean; end: string } {
  const add = p.basis === 'early' ? null : toCome(p), total = p.pct + (add ?? 0)
  return {
    used: `${one(p.pct)}% used`,
    add: add === null ? null : total > 100 ? `+${one(add)}% at this pace, ${one(total - 100)}% more than the limit` : `+${one(add)}% at this pace`,
    addBad: total > 100,
    end: `100% · resets ${dayTime(p.resetsAt)}`,
  }
}

/** Whether the today frame shows: once there's a pace, and while the limit isn't reached. */
export const showsToday = (p: WeekPlan) => !p.noData && p.basis !== 'early' && p.pct < 100

/** Today, in today's frame: the predicted line and the sentence under the bar. */
export function todayText(p: WeekPlan): { predicted: string; bad: boolean; used: string; pred: string | null; end: string; note: string } {
  const how = p.basis === 'profile' ? `your usual ${FULL_DAYS[new Date(p.dayStart).getDay()]}` : 'your pace'
  const floor = p.usedToday < p.expectedToday
    ? `Until the day ends, today counts as at least one day at ${how}, ${one(p.predicted)}% of the budget. `
    : ''
  return {
    predicted: `Predicted use today: ${one(p.predicted)}% of daily budget`,
    bad: p.predicted > 100,
    used: `${one(p.usedOfBudget)}% used`,
    pred: p.predicted > p.usedOfBudget + 0.05 ? `${one(p.predicted)}% predicted` : null,
    end: `100% · day ends ${hm(p.dayEnd)}`,
    note: `${floor}Today’s budget is what’s left of the week divided by the days left: ${one(p.budget)}% of your weekly limit.`,
  }
}

/** The days in words, for the terminal and alt text: "Thu 20% · Fri 7% · Sat 12% now · Sun ~13.5% …". */
export function daysText(p: WeekPlan, past: readonly number[]): string {
  const open = p.resetsAt - 7 * DAY, early = p.basis === 'early'
  const out: string[] = past.map((v, i) => `${dayName(open + i * DAY)} ${one(v)}%`)
  out.push(`${dayName(p.dayStart)} ${one(p.usedToday)}% now`)
  for (const d of p.later) out.push(`${dayName(d.start)} ${early ? '?' : d.amount > 0 ? `~${one(d.amount)}%` : '0%'}`)
  return out.join(' · ')
}

// ---- the desktop's words, in runs: what's in the text colour or a state's, the rest muted ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A day's date: "Oct 08". */
export const dateName = (t: number) => { const d = new Date(t); return `${MONTHS[d.getMonth()]} ${pad(d.getDate())}` }
const strong = (s: string, fill: string = C.fg, weight = 600): Run => ({ s, fill, weight })

/** The weekly headline as the card shows it: the figure, its tone, and the range as a badge of its own ("±12 pts"). */
export function weekHeadline(p: WeekPlan): { head: string; tone: 'good' | 'bad' | 'dim'; badge: string | null } {
  const h = weekHead(p)
  if (h.tone !== 'good') return { head: h.head, tone: h.tone, badge: null }
  return { head: `About ${Math.max(0, Math.round(p.left))}% left at the reset`, tone: 'good', badge: p.miss ? `±${p.miss} pts` : null }
}

/** What the headline is based on, its figure in bold. */
export function basisRuns(p: WeekPlan): Run[] {
  if (p.noData) return [{ s: p.noData }]
  if (p.basis === 'pace') return [{ s: `At your pace over the last ${p.paceDays === 1 ? 'whole day' : `${p.paceDays} whole days`}: ` }, strong(`${one(p.pacePerDay)}% a day.`)]
  return [{ s: basisText(p) }]
}

/** How far off the projection typically is, and the range that makes, under the basis. */
export function missRuns(p: WeekPlan): Run[] | null {
  if (!p.miss || weekHead(p).tone !== 'good') return null
  const left = Math.max(0, Math.round(p.left)), lo = left - p.miss, hi = left + p.miss
  return [{ s: `Typical forecast miss: ${p.miss} points. Read this as ` }, strong(lo < 0 ? `between ${-lo}% short and ${hi}% to spare.` : `${lo}–${hi}% to spare.`)]
}

/** Today's sentence, its figure in week terms in bold. */
export function todayRuns(p: WeekPlan): Run[] {
  const d = todayText(p), tail = `${one(p.budget)}% of your weekly limit.`
  return [{ s: d.note.slice(0, d.note.length - tail.length) }, strong(tail)]
}

/** The 5-hour figures under its head, in runs. */
export function fiveRuns(m: Model, now: number): Run[] {
  const h = fiveHead(m, now)
  if (m.noData || m.pct >= 100) return [{ s: h.sub }]
  const opened = m.resetsAt - 5 * HOUR
  const used: Run[] = [strong(`${Math.round(m.pct)}% used`), { s: ` since ${hm(opened)}, ` }, strong(`${one(m.rate)}% an hour.`)]
  const cut = cutOff(m, now)
  if (cut !== null) return [...used, { s: ` It resets at ${hm(m.resetsAt)}, ` }, { s: `${dur((m.resetsAt - cut) / HOUR)} after the cut-off.`, fill: C.bad }]
  return [...used, { s: ' About ' }, { s: `${Math.round(m.arrive)}% to spare`, fill: C.good, weight: 600 }, { s: ' at the reset.' }]
}

// ---- drawing ----

const TONE = { good: C.accent, bad: C.bad, dim: C.muted }
/** A frame's label: "This week · 100% = your weekly limit". */
const frame = (y: number, s: string) => t(0, y, s, { size: SIZE.meta, fill: C.muted })

/** The pane's masthead: the mark, the name and what it's for, and the period it shows. */
export function mastheadSvg(width: number, pal: Palettes = DEFAULT_PALETTES): string {
  const narrow = width < NARROW
  const m = narrow ? 0 : 48, gap = narrow ? 0 : 15
  let s = ''
  if (!narrow) {
    s += rect(0, 0, 48, 48, `fill:${C.raised}`, ' rx="12"')
    // the mark: three bars, as the plugin's icon
    s += `<g transform="translate(9 9) scale(0.9375)" style="fill:${C.accent}"><rect x="3" y="17" width="6" height="12" rx="2"/><rect x="13" y="3" width="6" height="26" rx="2"/><rect x="23" y="11" width="6" height="18" rx="2"/></g>`
  }
  const ts = narrow ? 24 : SIZE.title
  s += t(m + gap, narrow ? 24 : 26, 'Token Range Monitor', { size: ts, weight: 650 })
  s += t(m + gap, narrow ? 46 : 46, 'Track your usage, limits, and the time you have left.', { size: SIZE.meta, fill: C.muted })
  // the period: a quiet chip at the right, where there's room for it
  const chip = 'This week', cw = 13 + 16 + 9 + tw(chip, SIZE.meta) + 13
  if (width - cw > m + gap + tw('Token Range Monitor', ts, 650) + 20) {
    const x = width - cw
    s += rect(x, 6, cw, 36, `fill:${C.surface}`, ' rx="8"') + icon('calendar', x + 13, 16, 16, C.muted) + t(x + 13 + 16 + 9, 28.5, chip, { size: SIZE.meta })
  }
  return drawing(s, 52, pal)
}

/** A nice top for the days' scale: a little over the tallest, in whole even points. */
function scaleTop(max: number): number {
  const v = Math.max(max, 1) * 1.1
  return v >= 10 ? Math.ceil(v / 2) * 2 : Math.ceil(v)
}

/**
 * The weekly card, `width` wide, down to the days' caption: its header; the week's frame (the headline and
 * its range, what it's based on, the whole week as one bar); the days of this window as seven columns on one
 * scale, past days solid, today solid with its expected rest striped, later days striped, today's and later
 * days' daily budget outlined unless `showBudget` is off. The legend and today's frame are drawn apart
 * (`weekLegendSvg`, `todaySvg`), the budget's switch between them.
 */
export function weekCardSvg(p: WeekPlan, past: readonly number[], width: number, pal: Palettes = DEFAULT_PALETTES, showBudget = true): string {
  const W = width
  let s = `<defs>${stripes('wk', C.raised)}${stripes('wkd', C.inset)}</defs>`
  const head = cardHeader('calendar', 'This week', 'Your weekly usage and limit',
    [{ s: `Resets ${dayTime(p.resetsAt)} ` }, { s: '·', fill: C.faint }, { s: ` in ${dur((p.resetsAt - p.now) / HOUR)}` }], W)
  s += head.svg
  let y = head.y

  // ---- the headline, its range, what it's based on ----
  const h = weekHeadline(p)
  const hs = W < NARROW ? 24 : SIZE.title
  const badgeW = h.badge ? tw(h.badge, SIZE.meta, 500) + 14 : 0
  const fitsOne = tw(h.head, hs, 600) + (h.badge ? 12 + badgeW : 0) <= W
  const hl = rich([{ s: h.head, fill: TONE[h.tone], weight: 600 }], 0, y + hs * 0.95, W, hs, 1.3)
  s += hl.svg
  y = hl.y
  if (h.badge) {
    const bx = fitsOne ? tw(h.head, hs, 600) + 12 : 0, by = fitsOne ? y - hs * 0.72 : y + 12
    s += rect(bx, by, badgeW, 23, `fill:${C.raised}`, ' rx="5"') + t(bx + 7, by + 16, h.badge, { size: SIZE.meta, weight: 500, fill: C.muted })
    if (!fitsOne) y += 30
  }
  y += hs * 0.3 + 7
  const basis = rich(basisRuns(p), 0, y + SIZE.body * 1.15, W, SIZE.body, 1.75)
  s += basis.svg
  y = basis.y + SIZE.body * 0.6
  const miss = missRuns(p)
  if (miss) {
    const r = rich(miss, 0, y + 5 + SIZE.meta * 1.2, W, SIZE.meta, 1.7)
    s += r.svg
    y = r.y + SIZE.meta * 0.5
  }

  // ---- the whole week as one bar ----
  if (!p.noData) {
    y += 17
    s += frame(y + SIZE.meta, 'This week · 100% = your weekly limit')
    y += SIZE.meta * 1.5 + 7
    const used = Math.min(100, p.pct), add = p.basis === 'early' ? 0 : toCome(p), end = Math.min(100, p.pct + add)
    s += track(0, y, W - 2, 19, used / 100, end / 100, 1, { stripe: 'wk' })
    y += 19 + 8
    const L = weekBarLabels(p), over = p.pct + add > 100
    const row = trackLabels([
      [strong(`${one(p.pct)}%`, C.fg, 500), { s: ' used' }],
      L.add ? [strong(`+${one(add)}%`, over ? C.bad : C.fg, 500), { s: ' at this pace' }, ...(over ? [{ s: `, ${one(p.pct + add - 100)}% more than the limit`, fill: C.bad }] : [])] : null,
      [{ s: L.end }],
    ], y + SIZE.meta * 1.15, W)
    s += row.svg
    y = row.y + SIZE.meta * 0.6
  }

  // ---- the days of this window, one scale ----
  if (!p.noData && p.pct < 100) {
    const early = p.basis === 'early', open = p.resetsAt - 7 * DAY, narrow = W < NARROW
    const vals = [...past, early ? p.usedToday : p.today, ...(early ? [] : p.later.map(d => d.amount)), early || !showBudget ? 0 : p.budget]
    const top = scaleTop(Math.max(...vals))
    const axisW = narrow ? 32 : 36, gap = narrow ? 9 : W < 760 ? 14 : 18
    const colW = (W - axisW - 4 - gap * 6) / 7, area = narrow ? 110 : 136
    y += 22
    const vy = y + 13, base = y + 30 + area
    const hOf = (v: number) => Math.max(0, Math.min(v, top)) / top * area
    // the scale: the top and middle as dashed lines, their figures at the left
    for (const [f, label] of [[1, top], [0.5, top / 2], [0, 0]] as const) {
      const ly = base - f * area
      if (f > 0) s += `<line x1="${axisW}" x2="${W}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" style="stroke:${C.line}" stroke-dasharray="3 3"/>`
      s += t(axisW - (narrow ? 6 : 9), ly + SIZE.meta * 0.36, `${one(label)}%`, { size: SIZE.meta, fill: C.muted, anchor: 'end' })
    }
    for (let i = 0; i < 7; i++) {
      const x = axisW + i * (colW + gap), cx = x + colW / 2, isToday = i === p.k
      let v = '', vFill: string = C.muted
      if (i < p.k) {
        const hv = hOf(past[i] ?? 0)
        if (hv > 0) s += `<path d="${topRounded(x + 0.5, base - hv, colW - 1, hv, 4)}Z" style="fill:${C.accent};stroke:${C.accent}"/>`
        v = `${one(past[i] ?? 0)}%`
      } else if (isToday) {
        const over = !early && p.usedToday > p.budget
        const hu = hOf(p.usedToday), hr = early ? 0 : hOf(p.today) - hu
        if (hr > 0.5) s += `<path d="${topRounded(x + 0.5, base - hu - hr, colW - 1, hr, 3)}Z" style="fill:url(#wkd)"/>`
        if (hu > 0) s += `<path d="${hr > 0.5 ? `M${(x + 0.5).toFixed(1)} ${base.toFixed(1)}V${(base - hu).toFixed(1)}H${(x + colW - 0.5).toFixed(1)}V${base.toFixed(1)}` : topRounded(x + 0.5, base - hu, colW - 1, hu, 4)}Z" style="fill:${over ? C.bad : C.accent};stroke:${over ? C.bad : C.accent}"/>`
        v = `${one(p.usedToday)}%`; vFill = over ? C.bad : C.accent
      } else if (early) {
        s += `<path d="${topRounded(x + 0.5, base - area * 0.4, colW - 1, area * 0.4, 4)}" fill="none" style="stroke:${C.faint}" stroke-dasharray="4 3"/>`
        v = '?'
      } else {
        const d = p.later[i - p.k - 1]!, hd = hOf(d.amount)
        if (hd > 0) s += `<path d="${topRounded(x + 0.5, base - hd, colW - 1, hd, 4)}Z" style="fill:url(#wkd);stroke:${C.accent}"/>`
        v = d.amount > 0 ? `~${one(d.amount)}%` : '0%'
      }
      // the daily budget, outlined over today and the days after it
      if (!early && showBudget && i >= p.k) {
        const hb = hOf(p.budget)
        s += `<path d="${topRounded(x - 3, base - hb, colW + 6, hb, 4)}" fill="none" style="stroke:${C.muted}"/>`
      }
      const vs = tw(v, SIZE.meta) > colW + gap - 2 ? v.replace('%', '').replace('~', '') : v
      s += t(cx, vy, vs, { size: SIZE.meta, fill: vFill, anchor: 'middle' })
      const name = dayName(open + i * DAY), date = dateName(open + i * DAY)
      s += t(cx, base + 9 + SIZE.meta * 1.15, name, { size: SIZE.meta, fill: isToday ? C.accent : C.fg, anchor: 'middle' })
      if (isToday) s += `<circle cx="${(cx + tw(name, SIZE.meta) / 2 + 6).toFixed(1)}" cy="${(base + 9 + SIZE.meta * 0.78).toFixed(1)}" r="2" style="fill:${C.accent}"/>`
      const dl = isToday && colW + gap > tw(`${date} · now`, SIZE.meta) + 4 ? `${date} · now` : isToday ? 'now' : date
      s += t(cx, base + 9 + SIZE.meta * 2.65, colW + gap > tw(dl, SIZE.meta) ? dl : dl.slice(4), { size: SIZE.meta, fill: isToday ? C.accent : C.muted, anchor: 'middle' })
    }
    s += `<line x1="${axisW}" x2="${W}" y1="${(base + 0.5).toFixed(1)}" y2="${(base + 0.5).toFixed(1)}" style="stroke:${C.line}"/>`
    y = base + 9 + SIZE.meta * 2.65 + 13
    s += t(0, y + SIZE.meta * 1.15, 'Each day, in % of your weekly limit', { size: SIZE.meta, fill: C.muted })
    y += SIZE.meta * 1.6
  }
  return drawing(s, Math.ceil(y + 4), pal)
}

/** The days' legend: used, and what the pace adds (or that the days to come aren't known yet). */
export function weekLegendSvg(early: boolean, pal: Palettes = DEFAULT_PALETTES): { svg: string; width: number } {
  const second = early ? 'Not known yet' : 'Expected at your pace'
  const w = 13 + 7 + tw('Used', SIZE.meta) + 20 + 13 + 7 + tw(second, SIZE.meta) + 4
  let s = `<defs>${stripes('lg', 'none', 4, 2)}</defs>`
  s += rect(0, 5, 13, 12, `fill:${C.accent}`, ' rx="3"') + t(20, 15.5, 'Used', { size: SIZE.meta, fill: C.muted })
  const x = 20 + tw('Used', SIZE.meta) + 20
  s += rect(x + 0.5, 5.5, 12, 11, `fill:url(#lg);stroke:${C.accent}`, ' rx="3"') + t(x + 20, 15.5, second, { size: SIZE.meta, fill: C.muted })
  return { svg: drawing(s, 22, pal), width: Math.ceil(w) }
}

/**
 * Today's frame, `width` wide, on its panel: the predicted use in % of today's budget beside a bar from 0 to
 * today's budget (past it when today runs over), solid to what's used, striped to the prediction, a mark at
 * 100%; then the one sentence that gives the budget in week terms.
 */
export function todaySvg(p: WeekPlan, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  const W = width, pad = W < NARROW ? 16 : 20, inner = W - pad * 2, narrow = W < NARROW + 40
  const d = todayText(p)
  let s = `<defs>${stripes('td', C.accentBg)}</defs>`
  // the metric: its icon, what it is and the figure
  const mx = pad, my = pad
  const iconW = narrow ? 0 : 43 + 13
  if (!narrow) s += tile('bars', mx, my, 43, C.accent)
  s += t(mx + iconW, my + 16 * 1.05, 'Predicted use today', { size: SIZE.body, weight: 500 })
  s += t(mx + iconW, my + 16 * 1.3 + SIZE.title * 1.05, `${one(p.predicted)}%`, { size: SIZE.title, weight: 650, fill: d.bad ? C.bad : C.accent })
  s += t(mx + iconW, my + 16 * 1.3 + SIZE.title * 1.35 + SIZE.meta * 1.05, 'of daily budget', { size: SIZE.meta, fill: C.muted })
  const metricH = 16 * 1.3 + SIZE.title * 1.35 + SIZE.meta * 1.4
  // the bar: beside the metric where it's wide, under it where it's narrow
  const bx = narrow ? pad : pad + 235 + 22, bw = narrow ? inner : W - pad - bx
  const barBlock = SIZE.meta * 1.5 + 8 + 23 + 8 + SIZE.meta * 1.6
  let by = narrow ? my + metricH + 17 : my + Math.max(0, (metricH - barBlock) / 2)
  s += t(bx, by + SIZE.meta * 1.1, 'Today · 100% = today’s budget', { size: SIZE.meta, fill: C.muted })
  by += SIZE.meta * 1.5 + 8
  const scale = Math.max(100, p.predicted, p.usedOfBudget)
  s += track(bx, by, bw, 23, p.usedOfBudget / scale, p.predicted / scale, 100 / scale, { stripe: 'td', usedFill: p.usedOfBudget > 100 ? C.bad : C.accent })
  by += 23 + 8
  const row = trackLabels([
    [strong(`${one(p.usedOfBudget)}%`, C.fg, 600), { s: ' used' }],
    d.pred ? [strong(`${one(p.predicted)}%`, d.bad ? C.bad : C.fg, 600), { s: ' predicted' }] : null,
    [{ s: d.end }],
  ], by + SIZE.meta * 1.15, bw)
  s += `<g transform="translate(${bx.toFixed(1)} 0)">${row.svg}</g>`
  const top = Math.max(my + metricH, row.y + SIZE.meta * 0.6)
  const note = rich(todayRuns(p), pad, top + 16 + SIZE.meta * 1.2, inner, SIZE.meta, 1.75)
  const H = note.y + SIZE.meta * 0.6 + pad
  return drawing(rect(0, 0, W, H, `fill:${C.panel}`, ' rx="10"') + s + note.svg, Math.ceil(H), pal)
}

// ---- the 5-hour card ----

/** The 5-hour head and the line under it. */
export function fiveHead(m: Model, now: number): { head: string; tone: 'good' | 'bad' | 'dim'; sub: string } {
  const opened = m.resetsAt - 5 * HOUR
  if (m.noData) return { head: 'No estimate yet', tone: 'dim', sub: m.noData }
  if (m.pct >= 100) return { head: `Out until ${hm(m.resetsAt)}`, tone: 'bad', sub: `The 5-hour limit is reached. It resets at ${hm(m.resetsAt)}.` }
  const used = `${Math.round(m.pct)}% used since ${hm(opened)}, ${one(m.rate)}% an hour.`
  const cut = cutOff(m, now)
  if (cut !== null) return { head: `Cut off ~${hm(cut)} at this pace`, tone: 'bad', sub: `${used} It resets at ${hm(m.resetsAt)}, ${dur((m.resetsAt - cut) / HOUR)} after the cut-off.` }
  return { head: `Lasts to the reset at ${hm(m.resetsAt)}`, tone: 'good', sub: `${used.slice(0, -1)} · about ${Math.round(m.arrive)}% to spare.` }
}


/** What the 5-hour card's Details strip says while closed, in runs: when it runs out at 1.3's pace, or what's left. */
export function fiveSummary(m: Model): Run[] {
  if (m.noData) return [{ s: m.noData }]
  if (isShort(m)) return [{ s: 'Runs out in ' }, { s: dur(m.runsOutIn), fill: C.bad }, { s: ` · ${dur(m.early)} early` }]
  return [{ s: 'At the reset ' }, { s: spare(m.arrive), fill: C.good }, { s: ` · resets in ${dur(m.left)}` }]
}

/**
 * The 5-hour card, `width` wide: its header; "100% = your 5-hour limit"; the cut-off (its time in red) or
 * the reset it lasts to, with the figures under it; and the window's use as one bar on that scale: solid for
 * what's used, striped for what this pace adds by the reset.
 */
export function fiveCardSvg(m: Model, now: number, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  const W = width, opened = m.resetsAt - 5 * HOUR
  let s = `<defs>${stripes('fv', C.raised)}</defs>`
  const head = cardHeader('clock', '5-hour window', 'Track your short-term limit and usage', [{ s: `Opened ${hm(opened)} · resets ${hm(m.resetsAt)}` }], W)
  s += head.svg
  let y = head.y
  s += frame(y + SIZE.meta, '100% = your 5-hour limit')
  y += SIZE.meta * 1.5 + 5
  const h = fiveHead(m, now), cut = m.noData ? null : cutOff(m, now)
  const hs = W < NARROW ? 24 : SIZE.title
  const title: Run[] = cut !== null && m.pct < 100
    ? [{ s: 'Cut off ', fill: C.fg }, { s: `~${hm(cut)}`, fill: C.bad }, { s: ' at this pace', fill: C.fg }]
    : h.tone === 'good'
      ? [{ s: 'Lasts to the reset at ', fill: C.fg }, { s: hm(m.resetsAt), fill: C.accent }]
      : [{ s: h.head, fill: TONE[h.tone] }]
  const hl = rich(title, 0, y + hs * 1.0, W, hs, 1.35, { weight: 600 })
  s += hl.svg
  y = hl.y + hs * 0.35 + 7
  const sub = rich(fiveRuns(m, now), 0, y + SIZE.body * 1.15, W, SIZE.body, 1.75)
  s += sub.svg
  y = sub.y + SIZE.body * 0.6
  if (m.noData) return drawing(s, Math.ceil(y + 8), pal)

  // ---- the window's use as one bar, on the card's scale: used, then what this pace adds by the reset ----
  y += 27
  const proj = 100 - m.arrive, used = Math.min(100, m.pct), add = Math.max(0, proj - m.pct), over = proj > 100
  s += track(0, y, W - 2, 19, used / 100, Math.min(100, proj) / 100, 1, { stripe: 'fv' })
  y += 19 + 8
  const row = trackLabels([
    [strong(`${one(m.pct)}%`, C.fg, 500), { s: ' used' }],
    add > 0 ? [strong(`+${one(add)}%`, over ? C.bad : C.fg, 500), { s: ' at this pace' }, ...(over ? [{ s: `, cut off ~${hm(cut ?? m.resetsAt)}`, fill: C.bad }] : [])] : null,
    [{ s: `100% · resets ${hm(m.resetsAt)}` }],
  ], y + SIZE.meta * 1.15, W)
  s += row.svg
  y = row.y + SIZE.meta * 0.6
  return drawing(s, Math.ceil(y + 4), pal)
}

/** A 1.3 head's figures, as the Details' grid shows them: what's left at the reset, the two paces, the last window. */
export function oldFigures(m: Model, last: LastWindow | null, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  const items = [
    { label: m.kind === 'week' ? 'At week reset' : 'At 5h reset', value: leftText(m), fill: m.noData ? C.muted : isShort(m) ? C.bad : C.good },
    { label: 'Your pace', value: m.noData ? 'No data' : rateText(m, m.rate) },
    { label: 'Safe pace', value: rateText(m, m.limit) },
    ...(last ? [{ label: LAST_LABEL, value: lastWindowText(last), fill: lastIsShort(last) ? C.bad : C.good }] : []),
  ]
  const g = metricGrid(items, width)
  return drawing(g.svg, Math.ceil(g.y), pal)
}
