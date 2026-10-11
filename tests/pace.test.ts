import { expect, test } from 'claude-code/testing'

import type { RangeCheck, RangeDay, RangeReading } from '../types'
import { DAY, HOUR, lastWindow, project } from '../hooks/range'
import type { Watch } from '../hooks/range'
import { activeThreshold, currentReset, dailyTotals, dayIndex, dayStartOf, pace, selfCheck, typicalMiss, weekdayProfile, weekPlan } from '../hooks/pace'

const WEEK = 7 * DAY
/** Thursday 15 October 2026, 11:00 local: a weekly reset. */
const RESET = new Date(2026, 9, 15, 11, 0).getTime()
/** Local time on a day of October 2026. */
const oct = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()
const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true)

/**
 * Hourly weekly readings from `from` to `to`, its windows resetting on `reset`'s weekly beat, watched
 * throughout. Each day's `use(dayStart)` lands an hour into the day.
 */
function record(reset: number, from: number, to: number, use: (dayStart: number) => number, startPct = 0) {
  const resetAfter = (t: number) => reset + (Math.floor((t - reset) / WEEK) + 1) * WEEK
  const readings: RangeReading[] = []
  let pct = startPct, R = resetAfter(from)
  for (let t = from; t <= to; t += HOUR) {
    if (resetAfter(t) !== R) { R = resetAfter(t); pct = 0 }
    const ds = dayStartOf(t, reset)
    if (t === ds + HOUR) pct += use(ds)
    readings.push([t, 1, pct, R])
  }
  return { readings, from }
}

/** The plan at `now`, from the record as it stood then. */
function planAt(rec: { readings: RangeReading[]; from: number }, now: number, miss?: number | null) {
  const rs = rec.readings.filter(r => r[0] <= now), seen: Watch[] = [[rec.from, now]]
  return weekPlan(rs, seen, dailyTotals(rs, seen, now), now, miss)!
}

test('days line up with the weekly reset', async () => {
  expect(dayStartOf(oct(10, 12), RESET)).toBe(oct(10, 11))
  expect(dayStartOf(oct(10, 10, 59), RESET)).toBe(oct(9, 11))
  expect(dayIndex(oct(8, 11), RESET)).toBe(0)
  expect(dayIndex(oct(10, 12), RESET)).toBe(2)
  expect(dayIndex(RESET - 1, RESET)).toBe(6)
  // a reset that has passed rolls a week on, with nothing used yet
  const rs: RangeReading[] = [[oct(15, 9), 1, 80, RESET]]
  expect(currentReset(rs, oct(15, 10))).toEqual({ pct: 80, resetsAt: RESET })
  expect(currentReset(rs, oct(15, 12))).toEqual({ pct: 0, resetsAt: RESET + WEEK })
  expect(currentReset([], oct(15, 12))).toBe(null)
})

// the previous window at 7.6% a day, then 20% on Thursday and 19% on Friday: 39% at Saturday noon
const prevDays = (ds: number) => (ds < oct(8, 11) ? 7.6 : ds === oct(8, 11) ? 20 : ds === oct(9, 11) ? 19 : 0)
const saturday = (sat: number) => record(RESET, oct(1, 11), oct(11, 14), ds => (ds === oct(10, 11) ? sat : prevDays(ds)))

test('an idle evening holds the projection still until the day ends', async () => {
  const rec = saturday(0)
  const noon = planAt(rec, oct(10, 12))
  expect(noon.basis).toBe('pace')
  expect(noon.k).toBe(2)
  expect(noon.pct).toBe(39)
  // the last 7 whole days: five at 7.6, then 20 and 19
  near(noon.pacePerDay, 11)
  expect(noon.paceDays).toBe(7)
  // 100 − (39 + today at the pace + 4 more days at it)
  near(noon.left, 6)
  expect(noon.runsOutAt).toBe(null)
  for (let t = oct(10, 13); t <= oct(11, 10); t += HOUR) expect(planAt(rec, t).left).toBe(noon.left)
  // at 11:00 Saturday's 0% joins the pace, and one fewer day is left
  const next = planAt(rec, oct(11, 11))
  expect(next.k).toBe(3)
  near(next.pacePerDay, (4 * 7.6 + 39) / 7)
  near(next.left, 61 - 4 * (4 * 7.6 + 39) / 7)
  expect(next.left === noon.left).toBe(false)
})

test('a heavy day runs out at once; use under the pace leaves it be', async () => {
  // 30% lands at 12:00 on Saturday
  const heavy = saturday(30)
  near(planAt(heavy, oct(10, 11, 30)).left, 6)
  const p = planAt(heavy, oct(10, 13))
  expect(p.usedToday).toBe(30)
  expect(p.today).toBe(30)
  near(p.left, 100 - (69 + 4 * 11))
  // 69 + 11 Sunday + 11 Monday = 91: Tuesday's 11 passes 100 9/11 of the way through it
  near(p.runsOutAt!, oct(13, 11) + 9 / 11 * DAY)
  expect(p.runsOutToday).toBe(false)
  near(p.early, (RESET - p.runsOutAt!) / HOUR)
  expect(p.early > 0).toBe(true)
  // the change shows as soon as the reading does
  expect(planAt(heavy, oct(10, 12)).runsOutAt).toBe(p.runsOutAt)

  // 5% is under the pace: the same projection as the idle day's
  const light = saturday(5)
  const l = planAt(light, oct(10, 13))
  expect(l.usedToday).toBe(5)
  expect(l.today).toBe(l.expectedToday)
  near(l.left, planAt(saturday(0), oct(10, 13)).left)
})

test('the 7-day pace spans the reset; the first day of a window is no longer early', async () => {
  // 5% a day before the reset of 8 October, 12% a day after
  const rec = record(RESET, oct(1, 11), oct(9, 13), ds => (ds < oct(8, 11) ? 5 : 12))
  const first = planAt(rec, oct(8, 11, 30))
  expect(first.k).toBe(0)
  expect(first.basis).toBe('pace')
  expect(first.noData).toBe(null)
  expect(first.paceDays).toBe(7)
  near(first.pacePerDay, 5)
  near(first.left, 100 - 7 * 5)
  // a day on: six days of the old window and one of this one
  const second = planAt(rec, oct(9, 12))
  expect(second.k).toBe(1)
  expect(second.paceDays).toBe(7)
  near(second.pacePerDay, (6 * 5 + 12) / 7)
})

test('a weekday user with a Monday reset: the profile sees the weekend coming', async () => {
  // Monday resets at 09:00; 15% each weekday, weekends empty, from 21 September
  const MON = new Date(2026, 9, 19, 9, 0).getTime()
  const rec = record(MON, MON - 4 * WEEK, oct(14, 9, 30), ds => ([1, 2, 3, 4, 5].includes(new Date(ds).getDay()) ? 15 : 0))
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
  expect(withProfile.later.map(d => d.amount)).toEqual([15, 15, 0, 0])
  near(withProfile.left, 25)

  // under 14 days on record, the 7-day pace counts every day the same: five weekdays in the last seven
  const paceOnly = weekPlan(rs, seen, totals.slice(-13), now)!
  expect(paceOnly.basis).toBe('pace')
  near(paceOnly.pacePerDay, 75 / 7)
  near(paceOnly.left, 70 - 5 * 75 / 7)
  expect(withProfile.left > paceOnly.left).toBe(true)
})

test('a fresh install falls back to the hourly figure, tagged early', async () => {
  // recording began at 08:00 Saturday; no whole day yet (days start at 11:00)
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
  // a steady 10% a day for two weeks: every boundary says 30% left, and 30% was left
  const rec = record(RESET, oct(1, 11), oct(15, 12), () => 10)
  const now = oct(15, 12), seen: Watch[] = [[rec.from, now]]
  const totals = dailyTotals(rec.readings, seen, now)
  const check = selfCheck([], rec.readings, seen, totals, now)
  expect(check.map(c => c.resetsAt)).toEqual([RESET, RESET + WEEK])
  expect(check[0]!.at.map(a => a[0])).toEqual([0, 1, 2, 3, 4, 5, 6].map(j => RESET - WEEK + j * DAY))
  for (const a of check[0]!.at) near(a[1], 30)
  expect(check[0]!.actual).toBe(lastWindow(rec.readings, 'week', now, seen)!.left)
  expect(check[0]!.actual).toBe(30)
  expect(check[1]!.at.length).toBe(1)
  expect(check[1]!.actual).toBe(undefined)
  near(typicalMiss(check)!, 0)
  // run again, nothing changes
  expect(selfCheck(check, rec.readings, seen, totals, now)).toEqual(check)

  // a window whose outcome can't be told is dropped; only the last 4 completed are kept
  const old: RangeCheck[] = [2, 3, 4, 5, 6, 7].map(i => ({ resetsAt: RESET - i * WEEK, at: [[RESET - i * WEEK - DAY, 50]], actual: 40 }))
  const untold: RangeCheck = { resetsAt: RESET - WEEK, at: [[RESET - WEEK - DAY, 50]] }
  const kept = selfCheck([...old, untold], rec.readings, seen, totals, now)
  expect(kept.map(c => c.resetsAt)).toEqual([RESET - 4 * WEEK, RESET - 3 * WEEK, RESET - 2 * WEEK, RESET, RESET + WEEK])
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
  // Sunday 11 October, day 3 of the window: 41.6% used at its start, 12% since; 13.5% a day before it
  const dayStart = oct(11, 11), now = dayStart + 3 * HOUR
  const rs: RangeReading[] = [[dayStart - HOUR, 1, 41.6, RESET], [dayStart + 2 * HOUR, 1, 53.6, RESET]]
  const seen: Watch[] = [[dayStart - 2 * HOUR, now]]
  const totals: RangeDay[] = Array.from({ length: 7 }, (_, i): RangeDay => [dayStart - (7 - i) * DAY, 13.5])
  const p = weekPlan(rs, seen, totals, now)!
  expect(p.k).toBe(3)
  near(p.usedToday, 12)
  expect(p.today).toBe(13.5)
  // (100 − 41.6) ÷ 4 days
  near(p.budget, 14.6)
  near(p.predicted, 13.5 / 14.6 * 100)
  expect(Math.round(p.predicted * 100) / 100).toBe(92.47)
  near(p.usedOfBudget, 12 / 14.6 * 100)
  near(p.left, 100 - (53.6 + 1.5 + 3 * 13.5))

  // 95% at the start of the day: today's expected use passes 100 later today
  const high: RangeReading[] = [[dayStart - HOUR, 1, 95, RESET], [dayStart + HOUR, 1, 95, RESET]]
  const h = weekPlan(high, seen, totals, dayStart + 2 * HOUR)!
  expect(h.runsOutToday).toBe(true)
  near(h.runsOutAt!, dayStart + 2 * HOUR + 5 / 13.5 * 22 * HOUR)
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
  expect(dailyTotals(rec.readings, seen, now, stored)).toEqual([
    [RESET - 67 * DAY, 3], [RESET - 15 * DAY, 7], [oct(1, 11), 10], [oct(2, 11), 10], [oct(3, 11), 10],
  ])
  // a rise over a gap nothing watched counts, spread over the gap: 6 points from 23:00 to 11:00 on the 2nd
  const W = RESET - WEEK
  const gap: RangeReading[] = [[oct(1, 11), 1, 0, W], [oct(1, 23), 1, 0, W], [oct(2, 11), 1, 6, W], [oct(3, 12), 1, 6, W]]
  const t = dailyTotals(gap, [], oct(3, 12))
  expect(t.length).toBe(2)
  near(t[0]![1], 6)
  near(t[1]![1], 0)
})
