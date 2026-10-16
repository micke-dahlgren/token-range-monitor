import type { RangeCheck, RangeDay, RangeReading } from '../types'
import { DAY, HOUR, MIN, increments, lastWindow, ofKind, project, usedBetween } from './range'
import type { Watch } from './range'

const WEEK = 7 * DAY
/** Daily totals are kept 8 weeks. */
export const KEEP_DAYS = 56
/** The range (±miss) shows only when the projection has typically missed by more than this many points. */
export const RANGE_OVER = 5
/** Days on record before each weekday counts at its own usual use. */
const PROFILE_DAYS = 14
/** Two resets this close are the same one. */
const sameReset = (a: number, b: number) => Math.abs(a - b) < 5 * MIN

const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0)
const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/**
 * The current weekly window: % used and when it resets, from the latest weekly reading.
 * A reset that has passed rolls a week on with nothing used, as `project` does. Null with no weekly reading.
 */
export function currentReset(readings: readonly RangeReading[], now: number): { pct: number; resetsAt: number } | null {
  const rs = ofKind(readings, 'week'), last = rs[rs.length - 1]
  if (!last) return null
  let pct = last[2], resetsAt = last[3]
  while (resetsAt <= now) { resetsAt += WEEK; pct = 0 }
  return { pct, resetsAt }
}

/** Local midnight at or before `t`. */
export const midnightOf = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
/** The local midnight after `t`: a calendar day is 23 or 25 hours where the clocks change. */
export const nextMidnight = (t: number) => { const d = new Date(midnightOf(t)); d.setDate(d.getDate() + 1); return d.getTime() }

/** A day of the window: a calendar day, or the part of one the window covers; `share` is that part (1 for the whole day). */
export type WindowDay = { start: number; end: number; share: number }

/**
 * The days of the window resetting at `resetsAt`: calendar days, local midnight to midnight, the first from
 * when the window opened and the last to its reset. With a reset mid-day those two are part days, so a
 * window has 8 days; with a reset at midnight, 7 whole ones.
 */
export function windowDays(resetsAt: number): WindowDay[] {
  const out: WindowDay[] = []
  for (let start = resetsAt - WEEK; start < resetsAt;) {
    const m = midnightOf(start), next = nextMidnight(start), end = Math.min(next, resetsAt)
    out.push({ start, end, share: (end - start) / (next - m) })
    start = end
  }
  return out
}

/** Days that have ended by `now`, oldest first. */
const wholeDays = (totals: readonly RangeDay[], now: number) =>
  totals.filter(d => d[0] + DAY <= now).sort((a, b) => a[0] - b[0])

/**
 * Whole calendar days on record, oldest first, each with how far the weekly figure rose in it: rises over a gap
 * nothing here watched count too, since that was real use elsewhere. A day is on record once recording
 * had begun at its start. Days the readings cover are always worked out afresh, since a gap's rise can
 * arrive later and change them; older days come from `stored`, where none overlaps those. Kept KEEP_DAYS.
 */
export function dailyTotals(readings: readonly RangeReading[], seen: readonly Watch[], now: number, stored: readonly RangeDay[] = []): RangeDay[] {
  const cur = currentReset(readings, now)
  const first = ofKind(readings, 'week')[0]
  const fresh: RangeDay[] = []
  let from = now
  if (cur && first) {
    const incs = increments(readings, 'week', seen)
    // calendar days, from the first midnight recording had begun by
    from = midnightOf(first[0])
    if (from < first[0]) from = nextMidnight(first[0])
    for (let s = from; nextMidnight(s) <= now; s = nextMidnight(s)) fresh.push([s, usedBetween(incs, s, nextMidnight(s))])
  }
  const older: RangeDay[] = []
  for (const d of wholeDays(stored, from)) {
    const prev = older[older.length - 1]
    if (!prev || d[0] >= prev[0] + DAY) older.push(d)
  }
  const keepFrom = midnightOf(now) - KEEP_DAYS * DAY
  return [...older, ...fresh].filter(d => d[0] >= keepFrom)
}

/** The average of the last (up to) 7 whole days, across resets, and how many there were; null with none. */
export function pace(totals: readonly RangeDay[], now: number): { perDay: number; days: number } | null {
  // the days that ended within the last week
  const days = wholeDays(totals, now).filter(d => d[0] + 8 * DAY > now).slice(-7)
  return days.length ? { perDay: sum(days.map(d => d[1])) / days.length, days: days.length } : null
}

/** What makes a day active: ¼ of the median day with any use; 0 when no day had use. */
export function activeThreshold(totals: readonly RangeDay[]): number {
  const used = totals.map(d => d[1]).filter(x => x > 0)
  return used.length ? median(used) / 4 : 0
}

/**
 * What's usually used on each local weekday (index: `new Date(dayStart).getDay()`, 0 = Sunday): the median
 * of that weekday's days on record, 0 for a weekday never active. A weekday with no day on record counts at
 * the median of all days. Null under 14 whole days on record.
 */
export function weekdayProfile(totals: readonly RangeDay[], now: number): number[] | null {
  const days = wholeDays(totals, now)
  if (days.length < PROFILE_DAYS) return null
  const active = activeThreshold(days), all = median(days.map(d => d[1]))
  return [0, 1, 2, 3, 4, 5, 6].map(w => {
    const vs = days.filter(d => new Date(d[0]).getDay() === w).map(d => d[1])
    if (!vs.length) return all
    return vs.some(x => x > 0 && x >= active) ? median(vs) : 0
  })
}

export type WeekPlan = {
  now: number
  /** % of the weekly limit used, and when the window resets (ms). */
  pct: number
  resetsAt: number
  /** The window's calendar days (see `windowDays`), which of them is today, and when today began and ends (ms). */
  days: WindowDay[]
  k: number
  dayStart: number
  dayEnd: number
  /** % of the weekly limit used on each day before today. */
  past: number[]
  /** % of the weekly limit used since today began. */
  usedToday: number
  /** What a whole today is expected to use: the pace, or what's usual on this weekday (in proportion, for a part day). */
  expectedToday: number
  /** Today as it's predicted: what's used so far, and the expected use for the hours left in it. */
  today: number
  /** The days after today, each at the pace or its weekday's usual use (in proportion, for the window's last part day). */
  later: Array<{ start: number; end: number; amount: number }>
  /** What the days are counted at: the 7-day pace, the weekday profile, or 1.3's hourly figure while no whole day is on record. */
  basis: 'pace' | 'profile' | 'early'
  /** The 7-day pace in % a day and how many days are behind it (early: 1.3's rate × 24, and 0). */
  pacePerDay: number
  paceDays: number
  /** % of the weekly limit left at the reset; negative means short by that much. */
  left: number
  /** When it runs out (ms), whether that's today, and how many hours before the reset; null and 0 when it lasts. */
  runsOutAt: number | null
  runsOutToday: boolean
  early: number
  /** Today's budget, in % of the weekly limit: what was left at the start of today spread over the time left, and that for a whole day. */
  budget: number
  budgetPerDay: number
  /** Today's expected and actual use, in % of today's budget. */
  predicted: number
  usedOfBudget: number
  /** How far the projection typically misses, in points, when that's over RANGE_OVER; else null. */
  miss: number | null
  /** Why there's no estimate yet (early basis only): then the figures mean nothing. */
  noData: string | null
}

/**
 * The weekly projection at `now`: what's used, the rest of today at the expected use for the hours left in it,
 * and each day left at the 7-day pace (or its weekday's usual use once 14 days are on record). With no whole
 * day on record it falls back to 1.3's figure.
 * Null with no weekly reading.
 */
export function weekPlan(readings: readonly RangeReading[], seen: readonly Watch[], totals: readonly RangeDay[], now: number, miss: number | null = null): WeekPlan | null {
  const cur = currentReset(readings, now)
  if (!cur) return null
  const { pct, resetsAt } = cur
  const days = windowDays(resetsAt)
  const k = Math.max(0, days.findIndex(d => now < d.end)), { start: dayStart, end: dayEnd } = days[k]!
  const incs = increments(readings, 'week', seen)
  const usedToday = Math.min(pct, usedBetween(incs, dayStart, now))
  const past = days.slice(0, k).map(d => usedBetween(incs, d.start, d.end))
  const p = pace(totals, now)
  const profile = p ? weekdayProfile(totals, now) : null
  // with no whole day on record, 1.3's figure since the reset
  const m = p ? null : project(readings, 'week', now, { type: 'reset' }, seen)
  const pacePerDay = p ? p.perDay : (m?.rate ?? 0) * 24
  // a day at the pace or its weekday's usual use, in proportion to how much of it the window covers
  const on = (d: WindowDay) => (profile ? profile[new Date(d.start).getDay()]! : pacePerDay) * d.share
  const expectedToday = on(days[k]!)
  // what's used today so far, and the day's expected use spread evenly over the hours still to come
  const rest = expectedToday * (dayEnd - now) / (dayEnd - dayStart), today = usedToday + rest
  const later: WeekPlan['later'] = days.slice(k + 1).map(d => ({ start: d.start, end: d.end, amount: on(d) }))

  let left: number, runsOutAt: number | null = null
  if (m) {
    left = m.arrive
    if (pct >= 100) runsOutAt = now
    else if (m.over) runsOutAt = now + m.runsOutIn * HOUR
  } else {
    left = 100 - (pct + rest + sum(later.map(d => d.amount)))
    if (pct >= 100) runsOutAt = now
    // today's expected use still to come, spread evenly to the day's end
    else if (pct + rest > 100) runsOutAt = now + (100 - pct) / rest * (dayEnd - now)
    else {
      // each later day spread evenly over its hours
      let cum = pct + rest
      for (const d of later) {
        if (cum + d.amount > 100) { runsOutAt = d.start + (100 - cum) / d.amount * (d.end - d.start); break }
        cum += d.amount
      }
    }
  }
  // what was left at the start of today, spread evenly over the time to the reset
  const budgetPerDay = (100 - (pct - usedToday)) * DAY / (resetsAt - dayStart)
  const budget = budgetPerDay * (dayEnd - dayStart) / DAY
  const ofBudget = (x: number) => (budget > 0 ? x / budget * 100 : x > 0 ? Infinity : 0)
  return {
    now, pct, resetsAt, days, k, dayStart, dayEnd, past, usedToday, expectedToday, today, later,
    basis: m ? 'early' : profile ? 'profile' : 'pace',
    pacePerDay, paceDays: p ? p.days : 0,
    left, runsOutAt, runsOutToday: runsOutAt !== null && runsOutAt < dayEnd,
    early: runsOutAt === null ? 0 : Math.max(0, (resetsAt - runsOutAt) / HOUR),
    budget, budgetPerDay, predicted: ofBudget(today), usedOfBudget: ofBudget(usedToday),
    miss: miss !== null && miss > RANGE_OVER ? Math.round(miss * 10) / 10 : null,
    noData: m ? m.noData : null,
  }
}

/** Watched spans as they stood at `t`. */
const seenAt = (seen: readonly Watch[], t: number): Watch[] => seen.filter(w => w[0] <= t).map(w => [w[0], Math.min(w[1], t)])

/**
 * The self-check: for the current window and the one just ended, what the projection said was left at
 * the start of each of its days, worked out from the record as it stood then where it's missing. Once a window has
 * reset, what was actually left (Last window's figure); a window whose outcome can't be trusted is
 * dropped. Keeps the last 4 completed windows and the current one.
 */
export function selfCheck(check: readonly RangeCheck[], readings: readonly RangeReading[], seen: readonly Watch[], totals: readonly RangeDay[], now: number): RangeCheck[] {
  const out: RangeCheck[] = check.map(c => ({ ...c, at: [...c.at] }))
  const find = (resetsAt: number) => out.find(c => sameReset(c.resetsAt, resetsAt))
  const cur = currentReset(readings, now)
  const first = ofKind(readings, 'week')[0]
  const last = lastWindow(readings, 'week', now, seen)
  if (cur && first) {
    // the window just ended is filled only when its outcome is known
    const wins = [cur.resetsAt, ...(last && sameReset(last.resetsAt, cur.resetsAt - WEEK) ? [last.resetsAt] : [])]
    for (const resetsAt of wins) {
      let c = find(resetsAt)
      if (c?.actual !== undefined) continue
      if (!c) { c = { resetsAt, at: [] }; out.push(c) }
      for (const { start: b } of windowDays(c.resetsAt)) {
        if (b > now || b < first[0] || c.at.some(a => Math.abs(a[0] - b) < 5 * MIN)) continue
        const plan = weekPlan(readings.filter(r => r[0] <= b), seenAt(seen, b), totals.filter(d => d[0] + DAY <= b), b)
        if (plan && !plan.noData && sameReset(plan.resetsAt, c.resetsAt)) c.at.push([b, plan.left])
      }
      c.at.sort((x, y) => x[0] - y[0])
    }
  }
  const done: RangeCheck[] = [], open: RangeCheck[] = []
  for (const c of out.sort((a, b) => a.resetsAt - b.resetsAt)) {
    if (!c.at.length) continue
    if (c.resetsAt > now) { open.push(c); continue }
    if (c.actual === undefined) {
      if (!last || !sameReset(last.resetsAt, c.resetsAt)) continue
      c.actual = last.left
    }
    done.push(c)
  }
  return [...done.slice(-4), ...open.slice(-1)]
}

/** How far the projection typically misses: the median of |said − actual| over every snapshot of the completed windows; null when none has completed. */
export function typicalMiss(check: readonly RangeCheck[]): number | null {
  const errs = check.flatMap(c => (c.actual === undefined ? [] : c.at.map(a => Math.abs(a[1] - c.actual!))))
  return errs.length ? median(errs) : null
}
