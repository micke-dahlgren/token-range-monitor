import { expect, test } from 'claude-code/testing'

import type { RangeCheck, RangeDay, RangeReading } from '../types'
import { DAY, HOUR, lastWindow, project } from '../hooks/range'
import type { Watch } from '../hooks/range'
import { activeThreshold, currentReset, dailyTotals, midnightOf, nextMidnight, pace, selfCheck, typicalMiss, weekdayProfile, weekPlan, windowDays } from '../hooks/pace'

const WEEK = 7 * DAY
/** Thursday 15 October 2026, 11:00 local: a weekly reset. */
const RESET = new Date(2026, 9, 15, 11, 0).getTime()
/** Local time on a day of October 2026. */
const oct = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()
const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true)

/**
 * Hourly weekly readings from `from` to `to`, its windows resetting on `reset`'s weekly beat, watched
 * throughout. Each calendar day's `use(midnight)` lands at noon.
 */
function record(reset: number, from: number, to: number, use: (dayStart: number) => number, startPct = 0) {
  const resetAfter = (t: number) => reset + (Math.floor((t - reset) / WEEK) + 1) * WEEK
  const readings: RangeReading[] = []
  let pct = startPct, R = resetAfter(from)
  for (let t = from; t <= to; t += HOUR) {
    if (resetAfter(t) !== R) { R = resetAfter(t); pct = 0 }
    const ds = midnightOf(t)
    if (t === ds + 12 * HOUR) pct += use(ds)
    readings.push([t, 1, pct, R])
  }
  return { readings, from }
}

/** The plan at `now`, from the record as it stood then. */
function planAt(rec: { readings: RangeReading[]; from: number }, now: number, miss?: number | null) {
  const rs = rec.readings.filter(r => r[0] <= now), seen: Watch[] = [[rec.from, now]]
  return weekPlan(rs, seen, dailyTotals(rs, seen, now), now, miss)!
}

test('days are calendar days: a mid-day reset makes part days at each end of the window', async () => {
  expect(midnightOf(oct(10, 12))).toBe(oct(10, 0))
  expect(nextMidnight(oct(10, 12))).toBe(oct(11, 0))
  // the clocks go back on 25 October: that day is 25 hours
  expect(nextMidnight(oct(25, 12)) - oct(25, 0)).toBe(25 * HOUR)
  const days = windowDays(RESET)
  expect(days.map(d => d.start)).toEqual([oct(8, 11), ...[9, 10, 11, 12, 13, 14, 15].map(d => oct(d, 0))])
  expect(days.at(-1)!.end).toBe(RESET)
  near(days[0]!.share, 13 / 24)
  near(days[1]!.share, 1)
  near(days.at(-1)!.share, 11 / 24)
  // a reset at midnight: seven whole days
  expect(windowDays(oct(15, 0)).map(d => d.share)).toEqual([1, 1, 1, 1, 1, 1, 1])
  // Monday 12 October before 11:00 is Monday, not the Sunday a reset-hour day would have said
  const p = weekPlan([[oct(12, 9), 1, 50, RESET]], [], [], oct(12, 10))!
  expect(new Date(p.dayStart).getDay()).toBe(1)
  expect(p.dayStart).toBe(oct(12, 0))
  // a reset that has passed rolls a week on, with nothing used yet
  const rs: RangeReading[] = [[oct(15, 9), 1, 80, RESET]]
  expect(currentReset(rs, oct(15, 10))).toEqual({ pct: 80, resetsAt: RESET })
  expect(currentReset(rs, oct(15, 12))).toEqual({ pct: 0, resetsAt: RESET + WEEK })
  expect(currentReset([], oct(15, 12))).toBe(null)
})

// the previous window at 7.6% a day, then 20% on Thursday and 19% on Friday: 39% at Saturday noon
const prevDays = (ds: number) => (ds < oct(8, 0) ? 7.6 : ds === oct(8, 0) ? 20 : ds === oct(9, 0) ? 19 : 0)
const saturday = (sat: number) => record(RESET, oct(1, 11), oct(11, 14), ds => (ds === oct(10, 0) ? sat : prevDays(ds)))
/** What's left at the 15 October reset: today and four more whole days at `perDay`, and the 11 hours of Thursday 15th. */
const leftAt = (used: number, today: number, perDay: number, whole = 4) => 100 - (used + today + whole * perDay + perDay * 11 / 24)

test('today is what it has used, and the pace for the hours left: an idle evening eases it', async () => {
  const rec = saturday(0)
  const noon = planAt(rec, oct(10, 12))
  expect(noon.basis).toBe('pace')
  expect(noon.k).toBe(2)
  expect(noon.pct).toBe(39)
  // the last 7 whole days: five at 7.6, then 20 and 19
  near(noon.pacePerDay, 11)
  expect(noon.paceDays).toBe(7)
  // 100 − (39 + today's 12 hours left at the pace + 4 more days at it + Thursday's 11 hours)
  near(noon.today, 11 * 12 / 24)
  near(noon.left, leftAt(39, 11 * 12 / 24, 11))
  expect(noon.runsOutAt).toBe(null)
  // each idle hour takes its share of the day's pace off what's still to come today
  for (let h = 13; h <= 23; h++) near(planAt(rec, oct(10, h)).left, leftAt(39, 11 * (24 - h) / 24, 11))
  // at midnight Saturday's 0% joins the pace, and one fewer day is left
  const next = planAt(rec, oct(11, 0))
  expect(next.k).toBe(3)
  const p = (4 * 7.6 + 39) / 7
  near(next.pacePerDay, p)
  near(next.left, leftAt(39, p, p, 3))
  expect(next.left === noon.left).toBe(false)
})

test('a heavy day runs out at once; use under the pace leaves it be', async () => {
  // 30% lands at 12:00 on Saturday
  const heavy = saturday(30)
  near(planAt(heavy, oct(10, 11, 30)).left, leftAt(39, 11 * 12.5 / 24, 11))
  const p = planAt(heavy, oct(10, 13))
  expect(p.usedToday).toBe(30)
  // what's used, and the pace for the 11 hours left
  const rest = 11 * 11 / 24
  near(p.today, 30 + rest)
  near(p.left, leftAt(69, rest, 11))
  // 69 + the rest of today + 11 Sunday + 11 Monday: Tuesday's 11 passes 100 part of the way through it
  const cum = 69 + rest + 22
  near(p.runsOutAt!, oct(13, 0) + (100 - cum) / 11 * DAY)
  expect(p.runsOutToday).toBe(false)
  near(p.early, (RESET - p.runsOutAt!) / HOUR)
  expect(p.early > 0).toBe(true)
  // the change shows as soon as the reading does
  expect(planAt(heavy, oct(10, 12)).runsOutAt === null).toBe(false)

  // 5% under the pace counts too: 5 points less left than the idle day's
  const light = saturday(5)
  const l = planAt(light, oct(10, 13))
  expect(l.usedToday).toBe(5)
  near(l.today, 5 + rest)
  near(l.left, planAt(saturday(0), oct(10, 13)).left - 5)
})

test('the 7-day pace spans the reset; the first day of a window is no longer early', async () => {
  // 5% a day before the reset of 8 October, 12% a day after
  const rec = record(RESET, oct(1, 0), oct(9, 13), ds => (ds < oct(8, 0) ? 5 : 12))
  const first = planAt(rec, oct(8, 11, 30))
  expect(first.k).toBe(0)
  expect(first.basis).toBe('pace')
  expect(first.noData).toBe(null)
  expect(first.paceDays).toBe(7)
  near(first.pacePerDay, 5)
  // the window's 13 hours of today (12.5 of them still to come), six whole days and 11 hours of the last
  near(first.expectedToday, 5 * 13 / 24)
  near(first.today, 5 * 12.5 / 24)
  near(first.left, 100 - 5 * (12.5 / 24 + 6 + 11 / 24))
  // a day on: six days of the old window and one of this one
  const second = planAt(rec, oct(9, 12))
  expect(second.k).toBe(1)
  expect(second.paceDays).toBe(7)
  near(second.pacePerDay, (6 * 5 + 12) / 7)
})

test('a weekday user with a Monday reset: the profile sees the weekend coming', async () => {
  // Monday resets at 09:00; 15% each weekday, weekends empty, from 21 September
  const MON = new Date(2026, 9, 19, 9, 0).getTime()
  const rec = record(MON, MON - 4 * WEEK - 9 * HOUR, oct(14, 9, 30), ds => ([1, 2, 3, 4, 5].includes(new Date(ds).getDay()) ? 15 : 0))
  // Wednesday before its use: Monday and Tuesday used, 30%
  const now = oct(14, 9, 30)
  const rs = rec.readings, seen: Watch[] = [[rec.from, now]]
  const totals = dailyTotals(rs, seen, now)
  expect(totals.length).toBe(23)
  const prof = weekdayProfile(totals, now)!
  expect(prof).toEqual([0, 15, 15, 15, 15, 15, 0])

  const withProfile = weekPlan(rs, seen, totals, now)!
  expect(withProfile.basis).toBe('profile')
  expect(withProfile.k).toBe(2)
  expect(withProfile.pct).toBe(30)
  expect(withProfile.expectedToday).toBe(15)
  // Thursday, Friday, the weekend, and the 9 hours of Monday before its reset
  expect(withProfile.later.map(d => d.amount)).toEqual([15, 15, 0, 0, 15 * 9 / 24])
  // today's 14.5 hours left at Wednesday's usual 15
  near(withProfile.left, 100 - (30 + 15 * 14.5 / 24 + 30 + 15 * 9 / 24))

  // under 14 days on record, the 7-day pace counts every day the same: five weekdays in the last seven
  const paceOnly = weekPlan(rs, seen, totals.slice(-13), now)!
  expect(paceOnly.basis).toBe('pace')
  near(paceOnly.pacePerDay, 75 / 7)
  near(paceOnly.left, 70 - (14.5 / 24 + 4 + 9 / 24) * 75 / 7)
  expect(withProfile.left > paceOnly.left).toBe(true)
})

test('a fresh install falls back to the hourly figure, tagged early', async () => {
  // recording began at 08:00 Saturday; no whole day yet (days start at midnight)
  const rs: RangeReading[] = Array.from({ length: 7 }, (_, i): RangeReading => [oct(10, 8 + i), 1, 30 + i, RESET])
  const seen: Watch[] = [[oct(10, 8), oct(10, 14)]]
  const now = oct(10, 14)
  expect(dailyTotals(rs, seen, now)).toEqual([])
  const p = weekPlan(rs, seen, [], now)!
  const m = project(rs, 'week', now, { type: 'reset' }, seen)!
  expect(p.basis).toBe('early')
  expect(p.left).toBe(m.arrive)
  expect(p.pacePerDay).toBe(m.rate * 24)
  expect(p.paceDays).toBe(0)
  expect(p.noData).toBe(null)
  expect(p.runsOutAt).toBe(m.over ? now + m.runsOutIn * HOUR : null)
  // just after a reset 1.3 has no estimate either
  const soon: RangeReading[] = [[oct(8, 12), 1, 2, RESET], [oct(8, 13), 1, 4, RESET]]
  const s = weekPlan(soon, [], [], oct(8, 13))!
  expect(s.basis).toBe('early')
  expect(s.noData).toBe(project(soon, 'week', oct(8, 13), { type: 'reset' })!.noData)
  expect(typeof s.noData).toBe('string')
})

test('the self-check stores each day boundary and the outcome once the window resets', async () => {
  // a steady 10% a day for two weeks, resetting at midnight: every day's start says 30% left, and 30% was left
  const R0 = oct(15, 0)
  const rec = record(R0, oct(1, 0), oct(15, 12), () => 10)
  const now = oct(15, 12), seen: Watch[] = [[rec.from, now]]
  const totals = dailyTotals(rec.readings, seen, now)
  const check = selfCheck([], rec.readings, seen, totals, now)
  expect(check.map(c => c.resetsAt)).toEqual([R0, R0 + WEEK])
  expect(check[0]!.at.map(a => a[0])).toEqual([0, 1, 2, 3, 4, 5, 6].map(j => oct(8 + j, 0)))
  for (const a of check[0]!.at) near(a[1], 30)
  expect(check[0]!.actual).toBe(lastWindow(rec.readings, 'week', now, seen)!.left)
  expect(check[0]!.actual).toBe(30)
  expect(check[1]!.at.length).toBe(1)
  expect(check[1]!.actual).toBe(undefined)
  near(typicalMiss(check)!, 0)
  // run again, nothing changes
  expect(selfCheck(check, rec.readings, seen, totals, now)).toEqual(check)

  // a window whose outcome can't be told is dropped; only the last 4 completed are kept
  const old: RangeCheck[] = [2, 3, 4, 5, 6, 7].map(i => ({ resetsAt: R0 - i * WEEK, at: [[R0 - i * WEEK - DAY, 50]], actual: 40 }))
  const untold: RangeCheck = { resetsAt: R0 - WEEK, at: [[R0 - WEEK - DAY, 50]] }
  const kept = selfCheck([...old, untold], rec.readings, seen, totals, now)
  expect(kept.map(c => c.resetsAt)).toEqual([R0 - 4 * WEEK, R0 - 3 * WEEK, R0 - 2 * WEEK, R0, R0 + WEEK])
})

test('the range shows when the typical miss is over 5 points', async () => {
  const at = (lefts: number[]): Array<[number, number]> => lefts.map((l, i): [number, number] => [i * DAY, l])
  const wide: RangeCheck[] = [{ resetsAt: WEEK, at: at([22, -2, 23]), actual: 10 }, { resetsAt: 2 * WEEK, at: at([0]) }]
  expect(typicalMiss(wide)).toBe(12)
  const narrow: RangeCheck[] = [{ resetsAt: WEEK, at: at([14, 6, 15]), actual: 10 }]
  expect(typicalMiss(narrow)).toBe(4)
  expect(typicalMiss([{ resetsAt: WEEK, at: at([30]) }])).toBe(null)

  const rec = saturday(0)
  expect(planAt(rec, oct(10, 13), typicalMiss(wide)).miss).toBe(12)
  expect(planAt(rec, oct(10, 13), typicalMiss(narrow)).miss).toBe(null)
  expect(planAt(rec, oct(10, 13)).miss).toBe(null)
})

test('an active day is at least a quarter of the median day with use', async () => {
  const days = (vals: number[]): RangeDay[] => vals.map((v, i): RangeDay => [oct(1, 11) + i * DAY, v])
  // nonzero days 2, 14, 15, 15, 15, 16: the median is 15
  expect(activeThreshold(days([15, 14, 16, 2, 0, 15, 15]))).toBe(3.75)
  expect(activeThreshold(days([0, 0]))).toBe(0)
  // three weeks from a Monday: 15% each weekday, a few prompts (2%) on Saturdays, Sundays empty
  const MON = new Date(2026, 8, 21, 9, 0).getTime()
  const weeks: RangeDay[] = Array.from({ length: 21 }, (_, i): RangeDay => {
    const ds = MON + i * DAY, wd = new Date(ds).getDay()
    return [ds, wd === 6 ? 2 : wd === 0 ? 0 : 15]
  })
  const now = MON + 21 * DAY
  expect(weekdayProfile(weeks, now)).toEqual([0, 15, 15, 15, 15, 15, 0])
  // under 14 whole days there is no profile
  expect(weekdayProfile(weeks.slice(0, 13), now)).toBe(null)
  expect(weekdayProfile(weeks.slice(0, 14), MON + 13 * DAY)).toBe(null)
  expect(pace(weeks, now)).toEqual({ perDay: (5 * 15 + 2) / 7, days: 7 })
  expect(pace([], now)).toBe(null)
})

test("today's budget and predicted use", async () => {
  // Sunday 11 October, the window's fourth day: 41.6% used at its start, 12% since; 13.5% a day before it
  const dayStart = oct(11, 0), now = dayStart + 3 * HOUR
  const rs: RangeReading[] = [[dayStart - HOUR, 1, 41.6, RESET], [dayStart + 2 * HOUR, 1, 53.6, RESET]]
  const seen: Watch[] = [[dayStart - 2 * HOUR, now]]
  const totals: RangeDay[] = Array.from({ length: 7 }, (_, i): RangeDay => [dayStart - (7 - i) * DAY, 13.5])
  const p = weekPlan(rs, seen, totals, now)!
  expect(p.k).toBe(3)
  near(p.usedToday, 12)
  // the 12 used so far, and the pace for the 21 hours left
  const today = 12 + 13.5 * 21 / 24
  near(p.today, today)
  // (100 − 41.6) over the 4 days and 11 hours to the reset, today being a whole one of them
  const budget = 58.4 / (4 + 11 / 24)
  near(p.budget, budget)
  near(p.budgetPerDay, budget)
  near(p.predicted, today / budget * 100)
  near(p.usedOfBudget, 12 / budget * 100)
  near(p.left, 100 - (41.6 + today + 3 * 13.5 + 13.5 * 11 / 24))
  expect(p.past.length).toBe(3)

  // 95% at the start of the day: the pace for the 22 hours left passes 100 later today, at 13.5% a day
  const high: RangeReading[] = [[dayStart - HOUR, 1, 95, RESET], [dayStart + HOUR, 1, 95, RESET]]
  const h = weekPlan(high, seen, totals, dayStart + 2 * HOUR)!
  expect(h.runsOutToday).toBe(true)
  near(h.runsOutAt!, dayStart + 2 * HOUR + 5 / 13.5 * DAY)
  near(h.early, (RESET - h.runsOutAt!) / HOUR)
  // already out
  const out = weekPlan([[dayStart + HOUR, 1, 100, RESET]], [], totals, dayStart + 2 * HOUR)!
  expect(out.runsOutAt).toBe(dayStart + 2 * HOUR)
  expect(out.runsOutToday).toBe(true)
})

test('daily totals keep older stored days, replace those the readings cover, and drop past 8 weeks', async () => {
  // readings from 1 October at 10% a day; stored days from before, one of them overlapping
  const rec = record(RESET, oct(1, 11), oct(4, 12), () => 10)
  const now = oct(4, 12), seen: Watch[] = [[rec.from, now]]
  const stored: RangeDay[] = [[RESET - 14 * DAY, 99], [RESET - 15 * DAY, 7], [RESET - 67 * DAY, 3], [RESET - 68 * DAY, 4]]
  // recording began at 11:00 on the 1st, so the first whole calendar day on record is the 2nd
  expect(dailyTotals(rec.readings, seen, now, stored)).toEqual([
    [RESET - 67 * DAY, 3], [RESET - 15 * DAY, 7], [oct(2, 0), 10], [oct(3, 0), 10],
  ])
  // a rise over a gap nothing watched counts, spread over the gap: 6 points from 23:00 on the 1st to 11:00 on
  // the 2nd, so 5.5 of them on the 2nd
  const W = RESET - WEEK
  const gap: RangeReading[] = [[oct(1, 11), 1, 0, W], [oct(1, 23), 1, 0, W], [oct(2, 11), 1, 6, W], [oct(3, 12), 1, 6, W]]
  const t = dailyTotals(gap, [], oct(3, 12))
  expect(t.length).toBe(1)
  near(t[0]![1], 5.5)
})
