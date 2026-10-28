import type { Palettes, RangeDay } from '../types'
import { C, DAY, HOUR, LAST_LABEL, drawing, dur, isShort, lastIsShort, lastWindowText, rateText, spare } from './range'
import type { BandPart, LastWindow, Model } from './range'
import type { WeekPlan } from './pace'
import { DEFAULT_PALETTES } from './theme'
import { NARROW, SIZE, cardHeader, metricGrid, rect, rich, stripes, t, topRounded, track, trackLabels, tw } from './ui'
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
/** A day, its date and the time: "Thu · Oct 08 · 11:00". */
export const dayDateTime = (t: number) => `${dayName(t)} · ${dateName(t)} · ${hm(t)}`
/** About when, to the quarter hour: "Wed ~12:45". */
export const around = (t: number) => { const q = Math.round(t / (15 * 60_000)) * 15 * 60_000; return `${dayName(q)} ~${hm(q)}` }
/** One decimal, a whole number without it: "13.5", "39". */
export const one = (n: number) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '')

// ---- the line above the prompt ----

/** One limit's part of the line: as 1.3's, plus whether it reads as short or as what's left at the reset, and a tag ("early"). */
export type Part = BandPart & { bad: boolean; dim: boolean; spare?: boolean; tag?: string }

/**
 * The week's part. Lasting: "6% left at reset ±12, in 4d 13h" (narrow "6% @reset 4d 13h"). Short: "runs out
 * Wed 12:45, 22h early" (narrow "out Wed 12:45"). Before a whole day is on record, 1.3's hourly figure
 * with the tag "early". No "~" on the line above the prompt: there it reads as a minus.
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
    const when = p.runsOutToday ? 'later today' : around(p.runsOutAt).replace('~', '')
    return short
      ? { label, value: `out ${p.runsOutToday ? 'today' : when}`, rest: '', bad: true, dim: false }
      : { label, value: `runs out ${when}`, rest: `, ${dur(p.early)} early`, bad: true, dim: false }
  }
  const miss = p.miss ? ` ±${one(p.miss)}` : ''
  return short
    ? { label, value: `${Math.max(0, Math.round(p.left))}% @reset${miss}`, rest: ` ${dur(leftH)}`, bad: false, dim: false, spare: true, ...tag }
    : { label, value: `${Math.max(0, Math.round(p.left))}% left at reset${miss}`, rest: `, in ${dur(leftH)}`, bad: false, dim: false, spare: true, ...tag }
}

/** When the 5-hour limit runs out at this pace (ms), or null when it lasts to the reset. */
export const cutOff = (m: Model, now: number) => (m.over && !m.noData ? Math.round((now + m.runsOutIn * HOUR) / 60_000) * 60_000 : null)

/** The 5-hour part, in clock times: "cut off 00:09, resets 00:40" or "55% left at 15:40" (narrow "out 00:09", "55% @15:40"). */
export function fivePart(m: Model, now: number, short: boolean): Part {
  const label = '5h'
  if (m.noData) return { label, value: 'No data', rest: '', bad: false, dim: true }
  if (m.pct >= 100) return { label, value: short ? `out to ${hm(m.resetsAt)}` : `out until ${hm(m.resetsAt)}`, rest: '', bad: true, dim: false }
  const cut = cutOff(m, now)
  if (cut !== null) return short
    ? { label, value: `out ${hm(cut)}`, rest: '', bad: true, dim: false }
    : { label, value: `cut off ${hm(cut)}`, rest: `, resets ${hm(m.resetsAt)}`, bad: true, dim: false }
  return short
    ? { label, value: `${Math.max(0, Math.round(m.arrive))}% @${hm(m.resetsAt)}`, rest: '', bad: false, dim: false, spare: true }
    : { label, value: `${Math.max(0, Math.round(m.arrive))}% left at ${hm(m.resetsAt)}`, rest: '', bad: false, dim: false, spare: true }
}

/** About how many cells the line takes: the parts, their tags, the " · " between them, and the Details button. */
export const partsWidth = (parts: Part[]) =>
  parts.reduce((w, p) => w + p.label.length + 1 + p.value.length + p.rest.length + (p.tag ? p.tag.length + 1 : 0), 0)
  + Math.max(0, parts.length - 1) * 3 + 1 + 11

// ---- the weekly card's words ----

/** The days of this window so far, each in % of the weekly limit (0 for a day not on record). */
export const pastDays = (p: WeekPlan): number[] => p.past

/** When today ends: at midnight, or at the reset when that comes first. */
export const dayEndText = (p: WeekPlan) => (p.dayEnd === p.resetsAt ? `week resets ${hm(p.dayEnd)}` : 'day ends at midnight')

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
    sub += ` Your projections have typically been off by ${one(p.miss)} points, so read it as ${lo < 0 ? `between ${one(-lo)}% short and ${one(hi)}% to spare` : `${one(lo)}–${one(hi)}% to spare`}.`
  }
  return { head: `About ${left}% left at the reset${p.miss ? ` ±${one(p.miss)}` : ''}`, tone: 'good', sub }
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
    end: `Resets ${dayDateTime(p.resetsAt)}`,
  }
}

/** Whether the today frame shows: once there's a pace, and while the limit isn't reached. */
export const showsToday = (p: WeekPlan) => !p.noData && p.basis !== 'early' && p.pct < 100

/** Today, in today's frame: the predicted line and the sentence under the bar. */
export function todayText(p: WeekPlan): { predicted: string; bad: boolean; used: string; pred: string | null; end: string; note: string } {
  const how = p.basis === 'profile' ? `your usual ${FULL_DAYS[new Date(p.dayStart).getDay()]}` : 'your pace'
  return {
    predicted: `Predicted use today: ${one(p.predicted)}% of daily budget`,
    bad: p.predicted > 100,
    used: `${one(p.usedOfBudget)}% used`,
    pred: p.predicted > p.usedOfBudget + 0.05 ? `${one(p.predicted)}% predicted` : null,
    end: `100% · ${dayEndText(p)}`,
    note: `Predicted: what’s used so far, and the rest of the day at ${how}. Today’s budget is what’s left of the week spread over the time to the reset: ${one(p.budget)}% of your weekly limit.`,
  }
}

/** The days in words, for the terminal and alt text: "Thu 20% · Fri 7% · Sat 12% now · Sun ~13.5% …". */
export function daysText(p: WeekPlan, past: readonly number[]): string {
  const early = p.basis === 'early'
  const out: string[] = past.map((v, i) => `${dayName(p.days[i]!.start)} ${one(v)}%`)
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
  return { head: `About ${Math.max(0, Math.round(p.left))}% left at the reset`, tone: 'good', badge: p.miss ? `±${one(p.miss)} pts` : null }
}


/** How far off the projection typically is, and the range that makes, under the basis. */
export function missRuns(p: WeekPlan): Run[] | null {
  if (!p.miss || weekHead(p).tone !== 'good') return null
  const left = Math.max(0, Math.round(p.left)), lo = left - p.miss, hi = left + p.miss
  return [{ s: `Typical forecast miss: ${one(p.miss)} points. Read this as ` }, strong(lo < 0 ? `between ${one(-lo)}% short and ${one(hi)}% to spare.` : `${one(lo)}–${one(hi)}% to spare.`)]
}



// ---- drawing ----

const TONE = { good: C.accent, bad: C.bad, dim: C.muted }

/**
 * A limit's use as one bar, `width` wide from `y`, on 0–100% of the limit: solid to what's used (`pct`), striped to
 * where the pace ends up by the reset (`total`, or null with no projection), a mark at 100%. Each figure is centred
 * in its own part, the total on a chip over the stripes and in red past 100%, so there's nothing to add up. Under the
 * bar, at its ends, when the window opened (`start`) and when it resets (`end`); a figure whose part is too narrow for
 * it goes between them. The y under it all comes back.
 */
function limitBar(y: number, width: number, pct: number, total: number | null, stripe: string, start: string, end: string): { svg: string; y: number } {
  const BW = width - 2, BH = 24, used = Math.min(100, pct), to = total === null ? used : Math.min(100, total), over = (total ?? 0) > 100
  let s = track(0, y, BW, BH, used / 100, to / 100, 1, { stripe })
  const ty = y + BH / 2 + SIZE.meta * 0.36
  const inBar = (label: string, x0: number, x1: number, chip: boolean, fill: string) => {
    const w = tw(label, SIZE.meta, 600), cx = (x0 + x1) / 2
    if (x1 - x0 < w + (chip ? 16 : 10)) return false
    if (chip) s += rect(cx - w / 2 - 6, y + 3, w + 12, BH - 6, `fill:${C.card}`, ' rx="4"')
    s += t(cx, ty, label, { size: SIZE.meta, weight: 600, fill, anchor: 'middle' })
    return true
  }
  const usedX = BW * used / 100, toX = BW * to / 100
  const usedIn = inBar(`${one(pct)}%`, 0, usedX, false, C.card)
  const totalIn = total === null || inBar(`~${one(total)}%`, usedX, toX, true, over ? C.bad : C.fg)
  const between: Run[] = [
    ...(usedIn ? [] : [strong(`${one(pct)}%`, C.fg, 500), { s: ' used' }]),
    ...(totalIn ? [] : [{ s: usedIn ? '' : ' · ' }, strong(`~${one(total!)}%`, over ? C.bad : C.fg, 500), { s: ' by the reset' }]),
  ]
  const row = trackLabels([[{ s: start }], between.length ? between : null, [{ s: end }]], y + BH + 8 + SIZE.meta * 1.15, width)
  return { svg: s + row.svg, y: row.y + SIZE.meta * 0.6 }
}

/** A card's headline size: the design's title size, smaller on a narrow card or a dense one. */
const headSize = (width: number, dense: boolean) => (dense ? 20 : width < NARROW ? 24 : SIZE.title)

/** The pane's masthead: the mark and the name. */
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
  s += t(m + gap, narrow ? 24 : 34, 'Token Range Monitor', { size: ts, weight: 650 })
  return drawing(s, narrow ? 30 : 48, pal)
}

/** The days' columns' height in px as designed, at a card `width` wide, and the least they're drawn at to fit a short pane. */
export const daysHeight = (width: number) => (width < NARROW ? 110 : 136)
export const DAYS_MIN = 72

/** A nice top for the days' scale: a little over the tallest, in whole even points. */
function scaleTop(max: number): number {
  const v = Math.max(max, 1) * 1.1
  return v >= 10 ? Math.ceil(v / 2) * 2 : Math.ceil(v)
}

/**
 * The weekly card, `width` wide, down to the days' dates: its header; the week's frame (the headline and
 * its range, the whole week as one bar); the days of this window as seven columns on one
 * scale (calendar days; the first and last part days where the reset falls mid-day), past days solid, today solid with its expected rest striped, later days striped, today's and later
 * days' daily budget outlined. The legend and today's frame are drawn apart (`weekLegendSvg`, `todaySvg`). `dense`, for
 * a pane too short for the cards, draws the header and headline smaller; `shrink`, px the days' columns are drawn
 * shorter than the design's so the cards fit the pane's height, down to DAYS_MIN.
 */
export function weekCardSvg(p: WeekPlan, past: readonly number[], width: number, pal: Palettes = DEFAULT_PALETTES, dense = false, shrink = 0): string {
  const W = width
  let s = `<defs>${stripes('wk', C.raised)}${stripes('wkd', C.inset)}</defs>`
  const head = cardHeader('calendar', 'This week', [], W, dense)
  s += head.svg
  let y = head.y

  // ---- the headline, its range, what it's based on ----
  const h = weekHeadline(p)
  const hs = headSize(W, dense)
  const badgeW = h.badge ? tw(h.badge, SIZE.meta, 500) + 14 : 0
  const fitsOne = tw(h.head, hs, 600) + (h.badge ? 12 + badgeW : 0) <= W
  // only the figure carries the tone (a %, or a time); the rest of the headline is in the text colour
  const headRuns: Run[] = h.head.split(/(~?\d+(?:\.\d+)?%|~\d\d:\d\d)/).filter(Boolean)
    .map((part, i) => ({ s: part, fill: i % 2 || /^~?\d/.test(part) ? TONE[h.tone] : C.fg, weight: 600 }))
  const hl = rich(headRuns, 0, y + hs * 0.95, W, hs, 1.3)
  s += hl.svg
  y = hl.y
  if (h.badge) {
    const bx = fitsOne ? tw(h.head, hs, 600) + 12 : 0, by = fitsOne ? y - hs * 0.72 : y + 12
    s += rect(bx, by, badgeW, 23, `fill:${C.raised}`, ' rx="5"') + t(bx + 7, by + 16, h.badge, { size: SIZE.meta, weight: 500, fill: C.muted })
    if (!fitsOne) y += 30
  }
  y += hs * 0.3
  const miss = missRuns(p)
  if (miss) {
    const r = rich(miss, 0, y + 5 + SIZE.meta * 1.2, W, SIZE.meta, 1.7)
    s += r.svg
    y = r.y + SIZE.meta * 0.5
  }

  // ---- the whole week as one bar ----
  if (!p.noData) {
    y += 17
    const L = weekBarLabels(p), bar = limitBar(y, W, p.pct, L.add === null ? null : p.pct + toCome(p), 'wk', `Started ${dayDateTime(p.resetsAt - 7 * DAY)}`, L.end)
    s += bar.svg
    y = bar.y
  }

  // ---- the days of this window, one scale ----
  if (!p.noData && p.pct < 100) {
    const early = p.basis === 'early', narrow = W < NARROW, n = p.days.length
    const vals = [...past, early ? p.usedToday : p.today, ...(early ? [] : p.later.map(d => d.amount)), early ? 0 : p.budgetPerDay]
    const top = scaleTop(Math.max(...vals))
    const axisW = narrow ? 32 : 36, gap = narrow ? 7 : W < 760 ? 12 : 16
    const colW = (W - axisW - 4 - gap * (n - 1)) / n
    const tall = Math.max(DAYS_MIN, daysHeight(W) - shrink)
    y += 22
    const vy = y + 13, base = y + 30 + tall
    const hOf = (v: number) => Math.max(0, Math.min(v, top)) / top * tall
    // the scale: the top and middle as dashed lines, their figures at the left
    for (const [f, label] of [[1, top], [0.5, top / 2], [0, 0]] as const) {
      const ly = base - f * tall
      if (f > 0) s += `<line x1="${axisW}" x2="${W}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" style="stroke:${C.line}" stroke-dasharray="3 3"/>`
      s += t(axisW - (narrow ? 6 : 9), ly + SIZE.meta * 0.36, `${one(label)}%`, { size: SIZE.meta, fill: C.muted, anchor: 'end' })
    }
    for (let i = 0; i < n; i++) {
      const day = p.days[i]!, x = axisW + i * (colW + gap), cx = x + colW / 2, isToday = i === p.k
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
        s += `<path d="${topRounded(x + 0.5, base - tall * 0.4, colW - 1, tall * 0.4, 4)}" fill="none" style="stroke:${C.faint}" stroke-dasharray="4 3"/>`
        v = '?'
      } else {
        const d = p.later[i - p.k - 1]!, hd = hOf(d.amount)
        if (hd > 0) s += `<path d="${topRounded(x + 0.5, base - hd, colW - 1, hd, 4)}Z" style="fill:url(#wkd);stroke:${C.accent}"/>`
        v = d.amount > 0 ? `~${one(d.amount)}%` : '0%'
      }
      // the daily budget, outlined over today and the days after it (a part day's in proportion)
      if (!early && i >= p.k) {
        const hb = hOf(isToday ? p.budget : p.budgetPerDay * day.share)
        s += `<path d="${topRounded(x - 3, base - hb, colW + 6, hb, 4)}" fill="none" style="stroke:${C.muted}"/>`
      }
      const vs = tw(v, SIZE.meta) > colW + gap - 2 ? v.replace('%', '').replace('~', '') : v
      s += t(cx, vy, vs, { size: SIZE.meta, fill: vFill, anchor: 'middle' })
      const name = dayName(day.start), date = dateName(day.start)
      s += t(cx, base + 9 + SIZE.meta * 1.15, name, { size: SIZE.meta, fill: isToday ? C.accent : C.fg, anchor: 'middle' })
      if (isToday) s += `<circle cx="${(cx + tw(name, SIZE.meta) / 2 + 6).toFixed(1)}" cy="${(base + 9 + SIZE.meta * 0.78).toFixed(1)}" r="2" style="fill:${C.accent}"/>`
      // under the name: the date; the window's part days say where they start or stop; today says it's now
      const part = day.share < 1 ? (i === 0 ? `from ${hm(day.start)}` : i === n - 1 ? `to ${hm(day.end)}` : null) : null
      const fits = (l: string) => colW + gap > tw(l, SIZE.meta) + 2
      const dl = isToday ? (fits(`${date} · now`) ? `${date} · now` : 'now')
        : part ? (fits(part) ? part : part.replace(/^\S+ /, '')) : fits(date) ? date : date.slice(4)
      s += t(cx, base + 9 + SIZE.meta * 2.65, dl, { size: SIZE.meta, fill: isToday ? C.accent : C.muted, anchor: 'middle' })
    }
    s += `<line x1="${axisW}" x2="${W}" y1="${(base + 0.5).toFixed(1)}" y2="${(base + 0.5).toFixed(1)}" style="stroke:${C.line}"/>`
    y = base + 9 + SIZE.meta * 2.65
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

/** When today passes its budget at this pace (ms): now when it already has, null when it stays within it. */
export function overBudgetAt(p: WeekPlan): number | null {
  if (p.usedOfBudget >= 100) return p.now
  if (p.predicted <= 100) return null
  // the rest of today's expected use runs evenly to the day's end
  const rest = p.today - p.usedToday
  return Math.round((p.now + (p.budget - p.usedToday) / rest * (p.dayEnd - p.now)) / 60_000) * 60_000
}

/**
 * The today card, `width` wide, laid out as the 5-hour card is: its header; when today passes its budget at
 * this pace (its time in red) or that it stays within it; and today's use as one bar on 0–100% of today's
 * budget (`limitBar`): solid for what's used, striped to the prediction, the day's start and end under it.
 */
export function todaySvg(p: WeekPlan, width: number, pal: Palettes = DEFAULT_PALETTES, dense = false): string {
  const W = width
  let s = `<defs>${stripes('td', C.raised)}</defs>`
  const head = cardHeader('bars', 'Today', [], W, dense)
  s += head.svg
  let y = head.y
  const hs = headSize(W, dense), over = overBudgetAt(p)
  const title: Run[] = over === null
    ? [{ s: 'Within today’s budget', fill: C.fg }, { s: ' at this pace', fill: C.fg }]
    : over <= p.now
      ? [{ s: 'Over today’s budget', fill: C.bad }]
      : [{ s: 'Over budget ', fill: C.fg }, { s: `~${hm(over)}`, fill: C.bad }, { s: ' at this pace', fill: C.fg }]
  const hl = rich(title, 0, y + hs * 1.0, W, hs, 1.35, { weight: 600 })
  s += hl.svg
  y = hl.y + hs * 0.35 + (dense ? 14 : 27)
  const end = p.dayEnd === p.resetsAt ? `Week resets ${hm(p.dayEnd)}` : 'Ends at midnight'
  const bar = limitBar(y, W, p.usedOfBudget, p.predicted > p.usedOfBudget + 0.05 ? p.predicted : null, 'td', `Started ${hm(p.dayStart)}`, end)
  s += bar.svg
  return drawing(s, Math.ceil(bar.y + 4), pal)
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
 * The 5-hour card, `width` wide: its header; the cut-off (its time in red) or the reset it lasts to; and the window's
 * use as one bar on that scale (`limitBar`): solid for what's used, striped to where this pace ends up by the reset.
 */
export function fiveCardSvg(m: Model, now: number, width: number, pal: Palettes = DEFAULT_PALETTES, dense = false): string {
  const W = width, opened = m.resetsAt - 5 * HOUR
  let s = `<defs>${stripes('fv', C.raised)}</defs>`
  const head = cardHeader('clock', '5-hour window', [], W, dense)
  s += head.svg
  let y = head.y
  const h = fiveHead(m, now), cut = m.noData ? null : cutOff(m, now)
  const hs = headSize(W, dense)
  const title: Run[] = cut !== null && m.pct < 100
    ? [{ s: 'Cut off ', fill: C.fg }, { s: `~${hm(cut)}`, fill: C.bad }, { s: ' at this pace', fill: C.fg }]
    : h.tone === 'good'
      ? [{ s: 'Lasts to the reset at ', fill: C.fg }, { s: hm(m.resetsAt), fill: C.accent }]
      : [{ s: h.head, fill: TONE[h.tone] }]
  const hl = rich(title, 0, y + hs * 1.0, W, hs, 1.35, { weight: 600 })
  s += hl.svg
  y = hl.y + hs * 0.35
  if (m.noData) return drawing(s, Math.ceil(y + 8), pal)

  // ---- the window's use as one bar, on the card's scale: used, then where this pace ends up by the reset ----
  y += dense ? 14 : 27
  const proj = 100 - m.arrive, bar = limitBar(y, W, m.pct, proj > m.pct ? proj : null, 'fv', `Started ${hm(opened)}`, `Resets ${hm(m.resetsAt)}`)
  s += bar.svg
  y = bar.y
  return drawing(s, Math.ceil(y + 4), pal)
}

/** A 1.3 head's figures, as the Details' grid shows them: the two paces, the last window. */
export function oldFigures(m: Model, last: LastWindow | null, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  const items = [
    { label: 'Your pace', value: m.noData ? 'No data' : rateText(m, m.rate) },
    { label: 'Safe pace', value: rateText(m, m.limit) },
    ...(last ? [{ label: LAST_LABEL, value: lastWindowText(last), fill: lastIsShort(last) ? C.bad : C.good }] : []),
  ]
  const g = metricGrid(items, width)
  return drawing(g.svg, Math.ceil(g.y), pal)
}
