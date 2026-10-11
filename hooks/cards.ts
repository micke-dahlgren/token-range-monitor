import type { Palettes, RangeDay } from '../types'
import { C, DAY, FONT, HOUR, MONO, drawing, dur, esc, spare } from './range'
import type { BandPart, Model } from './range'
import type { WeekPlan } from './pace'
import { OTHER_INFO } from './projects'
import type { OtherPart, ProjectSplit } from './projects'
import { DEFAULT_PALETTES } from './theme'

/**
 * 1.4's cards: the weekly card in two frames (the week, 100% = the weekly
 * limit; today, 100% = today's budget), the projects card and the 5-hour card,
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

/** One limit's part of the line: as 1.3's, plus whether it reads as short, and a tag ("early"). */
export type Part = BandPart & { bad: boolean; dim: boolean; tag?: string }

/**
 * The week's part. Lasting: "6% to spare ±12, resets in 4d 13h" (narrow "+6% 4d 13h"). Short: "runs out
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
    ? { label, value: `+${Math.max(0, Math.round(p.left))}%${miss}`, rest: ` ${dur(leftH)}`, bad: false, dim: false, ...tag }
    : { label, value: `${spare(Math.max(0, p.left))}${miss}`, rest: `, resets in ${dur(leftH)}`, bad: false, dim: false, ...tag }
}

/** When the 5-hour limit runs out at this pace (ms), or null when it lasts to the reset. */
export const cutOff = (m: Model, now: number) => (m.over && !m.noData ? Math.round((now + m.runsOutIn * HOUR) / 60_000) * 60_000 : null)

/** The 5-hour part, in clock times: "cut off ~00:09, resets 00:40" or "55% to spare, resets 15:40" (narrow "out 00:09", "+55% 15:40"). */
export function fivePart(m: Model, now: number, short: boolean): Part {
  const label = '5h'
  if (m.noData) return { label, value: 'No data', rest: '', bad: false, dim: true }
  if (m.pct >= 100) return { label, value: short ? `out to ${hm(m.resetsAt)}` : `out until ${hm(m.resetsAt)}`, rest: '', bad: true, dim: false }
  const cut = cutOff(m, now)
  if (cut !== null) return short
    ? { label, value: `out ${hm(cut)}`, rest: '', bad: true, dim: false }
    : { label, value: `cut off ~${hm(cut)}`, rest: `, resets ${hm(m.resetsAt)}`, bad: true, dim: false }
  return short
    ? { label, value: `+${Math.round(m.arrive)}%`, rest: ` ${hm(m.resetsAt)}`, bad: false, dim: false }
    : { label, value: spare(m.arrive), rest: `, resets ${hm(m.resetsAt)}`, bad: false, dim: false }
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

// ---- drawing ----

type Txt = { size: number; weight?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; mono?: boolean; opacity?: number; caps?: boolean }
const t = (x: number | string, y: number, s: string, o: Txt) =>
  `<text x="${typeof x === 'number' ? x.toFixed(1) : x}" y="${y.toFixed(1)}" text-anchor="${o.anchor ?? 'start'}" style="fill:${o.fill ?? C.fg}"${o.opacity !== undefined ? ` fill-opacity="${o.opacity}"` : ''} font-family="${o.mono ? MONO : FONT}" font-size="${o.size}px" font-weight="${o.weight ?? 400}"${o.caps ? ' letter-spacing="0.04em"' : ''}>${esc(o.caps ? s.toUpperCase() : s)}</text>`
/** About how wide a text runs. */
const tw = (s: string, size: number, mono = false) => s.length * size * (mono ? 0.6 : 0.56)
const rect = (x: number, y: number, w: number, h: number, style: string, extra = '') =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" style="${style}"${extra}/>`
/** A box with only its top corners rounded, as a path. */
const topRounded = (x: number, y: number, w: number, h: number, r: number) => {
  r = Math.max(0, Math.min(r, w / 2, h))
  return `M${x.toFixed(1)} ${(y + h).toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)}H${(x + w - r).toFixed(1)}Q${(x + w).toFixed(1)} ${y.toFixed(1)} ${(x + w).toFixed(1)} ${(y + r).toFixed(1)}V${(y + h).toFixed(1)}`
}
/** Neutral stripes: what the pace adds, never a warning. */
const STRIPES = `<defs><pattern id="st" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="7" style="fill:${C.fg}" fill-opacity="0.45"/></pattern></defs>`
const rule = (y: number) => `<line x1="0" x2="100%" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" style="stroke:${C.fg}" stroke-opacity="0.14"/>`
const TONE = { good: C.under, bad: C.bad, dim: C.dim }

/** Words broken into lines that fit `width` at `size`. */
function wrap(s: string, width: number, size: number, mono = false): string[] {
  const lines: string[] = []
  for (const word of s.split(' ')) {
    const last = lines[lines.length - 1]
    if (last !== undefined && tw(`${last} ${word}`, size, mono) <= width) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return lines
}
/** Wrapped lines from `y` (the first baseline), and the y after them. */
function para(s: string, y: number, width: number, o: Txt, lh = 1.4): { svg: string; y: number } {
  const lines = wrap(s, width, o.size, o.mono)
  return { svg: lines.map((l, i) => t(0, y + i * o.size * lh, l, o)).join(''), y: y + (lines.length - 1) * o.size * lh }
}
/** Labels in a row, spread like flex's space-between; onto more rows where they don't fit. */
function labelRow(items: Array<{ s: string; fill?: string; weight?: number }>, y: number, width: number, size = 12): { svg: string; y: number } {
  const ws = items.map(i => tw(i.s, size, true))
  if (ws.reduce((a, w) => a + w, 0) + (items.length - 1) * 12 <= width) {
    const gaps = items.length > 1 ? (width - ws.reduce((a, w) => a + w, 0)) / (items.length - 1) : 0
    let x = 0, s = ''
    items.forEach((it, i) => { s += t(x, y, it.s, { size, mono: true, fill: it.fill ?? C.dim, ...(it.weight ? { weight: it.weight } : {}) }); x += ws[i]! + gaps })
    return { svg: s, y }
  }
  let s = ''
  items.forEach((it, i) => { s += t(0, y + i * size * 1.45, it.s, { size, mono: true, fill: it.fill ?? C.dim, ...(it.weight ? { weight: it.weight } : {}) }) })
  return { svg: s, y: y + (items.length - 1) * size * 1.45 }
}

/** A card's title row: the name at the left, a quiet line at the right (under it where there's no room). */
function titleRow(title: string, right: string, width: number): { svg: string; y: number } {
  const y = 19
  if (tw(title, 19.2) + tw(right, 12, true) + 16 <= width) return { svg: t(0, y, title, { size: 19.2, weight: 500 }) + t('100%', y, right, { size: 12, mono: true, fill: C.dim, anchor: 'end' }), y }
  return { svg: t(0, y, title, { size: 19.2, weight: 500 }) + t(0, y + 18, right, { size: 12, mono: true, fill: C.dim }), y: y + 18 }
}

/**
 * The weekly card, `width` wide: "This week" and when it resets; the week's frame (the head, what it's
 * based on, the whole week as one bar, the days of this window on one scale with today's and later days'
 * daily budget outlined); then today's frame (the predicted use in % of today's budget, today's bar, and
 * the one sentence that gives the budget in week terms).
 */
export function weekCardSvg(p: WeekPlan, past: readonly number[], width: number, pal: Palettes = DEFAULT_PALETTES): string {
  const W = width
  let s = STRIPES
  const top = titleRow('This week', `Resets ${dayTime(p.resetsAt)} · in ${dur((p.resetsAt - p.now) / HOUR)}`, W)
  s += top.svg
  let y = top.y + 26
  s += t(0, y, 'This week · 100% = your weekly limit', { size: 11, weight: 500, mono: true, fill: C.dim, caps: true })
  const h = weekHead(p)
  const head = para(h.head, y + 28, W, { size: 20.8, weight: 600, fill: TONE[h.tone] }, 1.25)
  s += head.svg
  const sub = para(h.sub, head.y + 22, W, { size: 13, fill: C.dim })
  s += sub.svg
  y = sub.y + 16

  // ---- the whole week as one bar ----
  if (!p.noData) {
    const used = Math.min(100, p.pct), end = p.basis === 'early' ? used : Math.min(100, p.pct + toCome(p))
    const bx = (v: number) => v / 100 * (W - 2)
    s += rect(0, y, W - 2, 18, `fill:${C.fg}`, ' fill-opacity="0.09" rx="5"')
    s += rect(0, y, bx(used), 18, `fill:${C.fg}`, ' fill-opacity="0.75" rx="3"')
    if (end > used) s += rect(bx(used), y, bx(end) - bx(used), 18, 'fill:url(#st)')
    s += rect(W - 2, y - 5, 2, 28, `fill:${C.fg}`)
    const L = weekBarLabels(p)
    const row = labelRow([{ s: L.used }, ...(L.add ? [{ s: L.add, ...(L.addBad ? { fill: C.bad } : {}) }] : []), { s: L.end }], y + 18 + 18, W)
    s += row.svg
    y = row.y + 22
  }

  // ---- the days of this window, one scale ----
  if (!p.noData && p.pct < 100) {
    const early = p.basis === 'early', open = p.resetsAt - 7 * DAY
    const vals = [...past, early ? p.usedToday : p.today, ...(early ? [] : p.later.map(d => d.amount)), early ? 0 : p.budget]
    const max = Math.max(...vals, 1) * 1.1, area = 96, gap = 6, colW = (W - gap * 6) / 7
    const vy = y + 12, ay = vy + 6, base = ay + area
    const hOf = (v: number) => Math.max(0, v) / max * area
    for (let i = 0; i < 7; i++) {
      const x = i * (colW + gap), cx = x + colW / 2, isToday = i === p.k
      let v = '', vFill: string = C.dim, vWeight = 400
      if (i < p.k) {
        const hv = hOf(past[i] ?? 0)
        if (hv > 0) s += `<path d="${topRounded(x, base - hv, colW, hv, 4)}Z" style="fill:${C.fg}" fill-opacity="0.6"/>`
        v = `${one(past[i] ?? 0)}%`
      } else if (isToday) {
        const over = !early && p.usedToday > p.budget
        const hu = hOf(p.usedToday), hr = early ? 0 : hOf(p.today - p.usedToday)
        if (hr > 0) s += `<path d="${topRounded(x, base - hu - hr, colW, hr, 4)}Z" style="fill:url(#st)"/>`
        if (hu > 0) s += hr > 0 ? rect(x, base - hu, colW, hu, `fill:${over ? C.bad : C.fg}`, ` fill-opacity="${over ? 0.9 : 0.6}"`)
          : `<path d="${topRounded(x, base - hu, colW, hu, 4)}Z" style="fill:${over ? C.bad : C.fg}" fill-opacity="${over ? 0.9 : 0.6}"/>`
        v = `${one(p.usedToday)}%`; vFill = over ? C.bad : C.fg; vWeight = 600
      } else if (early) {
        s += `<path d="${topRounded(x, base - area * 0.4, colW, area * 0.4, 4)}" fill="none" style="stroke:${C.off}" stroke-dasharray="4 3"/>`
        v = '?'
      } else {
        const d = p.later[i - p.k - 1]!, hd = hOf(d.amount)
        if (hd > 0) s += `<path d="${topRounded(x, base - hd, colW, hd, 4)}Z" style="fill:url(#st)"/>`
        v = d.amount > 0 ? `~${one(d.amount)}%` : '0%'
      }
      // the daily budget, outlined over today and the days after it
      if (!early && i >= p.k) s += `<path d="${topRounded(x - 2, base - hOf(p.budget), colW + 4, hOf(p.budget), 5)}" fill="none" style="stroke:${C.dim}" stroke-width="1.5"/>`
      const vs = tw(v, 11, true) > colW ? v.replace('%', '') : v
      s += t(cx, vy, vs, { size: 11, mono: true, fill: vFill, weight: vWeight, anchor: 'middle' })
      const name = dayName(open + i * DAY) + (isToday && colW > 52 ? ' ·now' : '')
      s += t(cx, base + 18, name, { size: 11, mono: true, fill: isToday ? C.fg : C.dim, weight: isToday ? 600 : 400, anchor: 'middle' })
    }
    s += `<line x1="0" x2="100%" y1="${base.toFixed(1)}" y2="${base.toFixed(1)}" style="stroke:${C.fg}" stroke-opacity="0.2"/>`
    y = base + 18 + 22
    // the legend: what each mark means, flowing onto more lines where it must
    const keys: Array<{ mark: string; s: string }> = [
      { mark: rect(0, -9, 12, 10, `fill:${C.fg}`, ' fill-opacity="0.6" rx="2"'), s: 'used' },
      { mark: rect(0, -9, 12, 10, 'fill:url(#st)', ' rx="2"'), s: early ? 'not known yet' : 'expected at your pace' },
      ...(early ? [] : [{ mark: `<path d="M0 1V-7Q0 -9 2 -9H10Q12 -9 12 -7V1" fill="none" style="stroke:${C.dim}" stroke-width="1.5"/>`, s: 'daily budget, the most per day that still reaches the reset' }]),
    ]
    let lx = tw('Each day, in % of your weekly limit:', 12) + 16
    s += t(0, y, 'Each day, in % of your weekly limit:', { size: 12, fill: C.dim })
    for (const k of keys) {
      const kw = 17 + tw(k.s, 12)
      if (lx > 0 && lx + kw > W) { lx = 0; y += 18 }
      s += `<g transform="translate(${lx.toFixed(1)} ${y.toFixed(1)})">${k.mark}</g>` + t(lx + 17, y, k.s, { size: 12, fill: C.dim })
      lx += kw + 16
    }
    y += 12
  }

  // ---- today, in today's frame ----
  if (showsToday(p)) {
    const d = todayText(p)
    y += 14
    s += rule(y)
    y += 24
    s += t(0, y, 'Today · 100% = today’s budget', { size: 11, weight: 500, mono: true, fill: C.dim, caps: true })
    y += 24
    s += t(0, y, d.predicted, { size: 14, weight: 600, fill: d.bad ? C.bad : C.fg })
    y += 12
    const scaleTo = Math.max(100, p.predicted, p.usedOfBudget) * 1.05, bx = (v: number) => v / scaleTo * (W - 2)
    s += rect(0, y, W - 2, 18, `fill:${C.fg}`, ' fill-opacity="0.09" rx="5"')
    s += rect(0, y, bx(p.usedOfBudget), 18, `fill:${p.usedOfBudget > 100 ? C.bad : C.fg}`, ` fill-opacity="${p.usedOfBudget > 100 ? 0.9 : 0.75}" rx="3"`)
    if (p.predicted > p.usedOfBudget) s += rect(bx(p.usedOfBudget), y, bx(p.predicted) - bx(p.usedOfBudget), 18, 'fill:url(#st)')
    s += rect(bx(100) - 1, y - 5, 2, 28, `fill:${C.fg}`)
    const row = labelRow([{ s: d.used }, ...(d.pred ? [{ s: d.pred }] : []), { s: d.end }], y + 18 + 18, W)
    s += row.svg
    const note = para(d.note, row.y + 22, W, { size: 12, fill: C.dim })
    s += note.svg
    y = note.y
  }
  return drawing(s, Math.ceil(y + 8), pal)
}

// ---- the projects card ----

const OTHER_ORDER: OtherPart[] = ['chats', 'devices', 'before', 'away']

/**
 * The projects card, `width` wide: this week's use split by project in % of the weekly limit, largest
 * first, in one neutral colour; Other (its parts listed under it when `otherOpen`); Unused, dashed; and
 * the total, the weekly limit, 100%. A narrow card leaves the bars out.
 */
export function projectsSvg(sp: ProjectSplit, width: number, otherOpen: boolean, pal: Palettes = DEFAULT_PALETTES): string {
  const W = width
  let s = ''
  const top = titleRow('Projects', `This week · ${one(sp.used)}% used, ${one(sp.unused)}% unused`, W)
  s += top.svg
  let y = top.y + 14
  // the split as one stacked bar: each project, Other, and what's unused left as the dashed outline
  s += rect(0.5, y + 0.5, W - 1, 11, `fill:none;stroke:${C.off}`, ' rx="4" stroke-dasharray="4 3"')
  let x = 0
  sp.rows.forEach((r, i) => {
    const w = r.pct / 100 * W
    s += rect(x, y, w, 12, `fill:${C.limit}`, ` fill-opacity="${Math.max(0.3, 0.95 - i * 0.22)}"`)
    x += w
  })
  s += rect(x, y, sp.otherTotal / 100 * W, 12, `fill:${C.off}`)
  y += 12 + 22
  const bars = W >= 420
  const numW = 64, nameW = bars ? (W - numW - 20) * 1.3 / 2.9 : W - numW - 10, barX = nameW + 10, barW = bars ? W - numW - 20 - nameW : 0
  const maxRow = Math.max(...sp.rows.map(r => r.pct), sp.otherTotal, sp.unused, 0.0001)
  s += t(0, y, 'Project', { size: 11, mono: true, fill: C.dim }) + t('100%', y, 'Of limit', { size: 11, mono: true, fill: C.dim, anchor: 'end' })
  y += 8
  const fitName = (n: string, size: number) => {
    if (tw(n, size) <= nameW) return n
    let c = n
    while (c.length > 1 && tw(`${c}…`, size) > nameW) c = c.slice(0, -1)
    return `${c}…`
  }
  const row = (name: string, v: number, o: { fill?: string; dashed?: boolean; nameFill?: string; weight?: number; total?: boolean } = {}) => {
    s += rule(y)
    const ty = y + 22
    s += t(0, ty, fitName(name, 14), { size: 14, weight: o.weight ?? 500, fill: o.nameFill ?? C.fg })
    if (bars) {
      if (o.dashed) s += rect(barX + 0.5, ty - 9.5, v / maxRow * (barW - 1), 7, `fill:none;stroke:${C.off}`, ' rx="4" stroke-dasharray="4 3"')
      else if (!o.total) {
        s += rect(barX, ty - 10, barW, 8, `fill:${C.fg}`, ' fill-opacity="0.1" rx="4"')
        s += rect(barX, ty - 10, v / maxRow * barW, 8, `fill:${o.fill ?? C.limit}`, ' rx="4"')
      }
    }
    s += t('100%', ty, `${one(v)}%`, { size: 13, mono: true, anchor: 'end', fill: o.nameFill ?? C.fg })
    y = ty + 12
  }
  for (const r of sp.rows) row(r.name, r.pct)
  row(`Other ${otherOpen ? '▾' : '▸'}`, sp.otherTotal, { fill: C.off })
  if (otherOpen) {
    for (const k of OTHER_ORDER) {
      if (!(sp.other[k] > 0)) continue
      const info = OTHER_INFO[k]
      y += 4
      s += t(16, y + 14, info.label, { size: 13 }) + t('100%', y + 14, `${one(sp.other[k])}%`, { size: 12, mono: true, anchor: 'end', fill: C.dim })
      const d = para(info.text, y + 31, W - 16, { size: 12, fill: C.dim })
      s += `<g transform="translate(16 0)">${d.svg}</g>`
      y = d.y + 8
    }
  }
  row('Unused', sp.unused, { dashed: true, nameFill: C.dim })
  row('Weekly limit', 100, { weight: 600, total: true })
  y += 6
  s += t(0, y + 12, 'Project names stay on this computer.', { size: 12, fill: C.dim })
  return drawing(s, Math.ceil(y + 18), pal)
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

/**
 * The 5-hour card, `width` wide: the head, and a line from the window's opening to its reset, solid up to
 * now, neutral stripes for the projection, a red line at the cut-off with its time in red.
 */
export function fiveCardSvg(m: Model, now: number, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  const W = width, opened = m.resetsAt - 5 * HOUR
  let s = STRIPES
  const top = titleRow('5-hour window', `Opened ${hm(opened)} · resets ${hm(m.resetsAt)}`, W)
  s += top.svg
  let y = top.y + 26
  s += t(0, y, '100% = your 5-hour limit', { size: 11, weight: 500, mono: true, fill: C.dim, caps: true })
  const h = fiveHead(m, now)
  const head = para(h.head, y + 28, W, { size: 20.8, weight: 600, fill: TONE[h.tone] }, 1.25)
  s += head.svg
  const sub = para(h.sub, head.y + 22, W, { size: 13, fill: C.dim })
  s += sub.svg
  y = sub.y + 40
  // the line, its marks' labels above (now, the reset) and below (the opening, the cut-off)
  const span = m.resetsAt - opened, X = (tm: number) => Math.max(0, Math.min(1, (tm - opened) / span)) * (W - 2)
  const cut = m.noData ? null : cutOff(m, now)
  const nowX = X(now), endX = cut !== null ? X(cut) : W - 2
  s += rect(0, y, W - 2, 10, `fill:${C.fg}`, ' fill-opacity="0.09" rx="5"')
  s += rect(0, y, nowX, 10, `fill:${C.fg}`, ' fill-opacity="0.7" rx="3"')
  if (!m.noData && endX > nowX) s += rect(nowX, y, endX - nowX, 10, 'fill:url(#st)')
  const mark = (x: number, fill: string, w = 2) => rect(x - w / 2, y - 6, w, 22, `fill:${fill}`)
  const label = (x: number, ly: number, str: string, o: { fill?: string; weight?: number } = {}) => {
    const lw = tw(str, 11, true), lx = Math.max(0, Math.min(W - lw, x - lw / 2))
    return t(lx, ly, str, { size: 11, mono: true, fill: o.fill ?? C.dim, ...(o.weight ? { weight: o.weight } : {}) })
  }
  s += mark(1, C.fg) + t(0, y + 32, hm(opened), { size: 11, mono: true, fill: C.dim })
  s += mark(W - 1, C.fg)
  const resetL = `reset ${hm(m.resetsAt)}`, nowL = `now ${hm(now)}`
  s += t('100%', y - 12, resetL, { size: 11, mono: true, fill: C.dim, anchor: 'end' })
  // now's label keeps clear of the reset's
  const nowLx = Math.min(nowX - tw(nowL, 11, true) / 2, W - tw(resetL, 11, true) - 12 - tw(nowL, 11, true))
  s += mark(nowX, C.fg) + t(Math.max(0, nowLx), y - 12, nowL, { size: 11, mono: true, fill: C.dim })
  if (cut !== null) s += mark(endX, C.bad, 3) + label(endX, y + 32, `cut off ~${hm(cut)}`, { fill: C.bad, weight: 600 })
  return drawing(s, Math.ceil(y + 40), pal)
}
