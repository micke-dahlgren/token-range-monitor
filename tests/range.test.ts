import { expect, test } from 'claude-code/testing'

import type { RangeReading } from '../types'
import { DAY, HOUR, MIN, increments, needsMore, parseWindow, project, resetsIn, signed, usedBetween } from '../hooks/range'

const hours = (h: number) => ({ type: 'hours', hours: h }) as const

const T0 = Date.UTC(2026, 9, 9, 15, 0)
const weekReset = T0 + 3 * DAY + 17 * HOUR

/** Weekly readings: `pct` at each of `hoursAgo`, same reset. */
const week = (pairs: Array<[number, number]>): RangeReading[] =>
  pairs.map(([hoursAgo, pct]) => [T0 - hoursAgo * HOUR, 1, pct, weekReset])

test('a heavy last day projects over, a calm week projects under', async () => {
  // 7% a day for six days, then 30% in the last 24 hours: 72% used with 3d 17h left
  const readings = week([[168, 0], [144, 7], [120, 14], [96, 21], [72, 28], [48, 35], [24, 42], [0, 72]])
  const lastDay = project(readings, 'week', T0, hours(24))!
  expect(lastDay.over).toBe(true)
  expect(Math.round(lastDay.rate * 24)).toBe(30)
  expect(lastDay.runsOutIn).toBeLessThan(lastDay.left)

  const lastWeek = project(readings, 'week', T0, hours(168))!
  expect(Math.round(lastWeek.rate * 24)).toBe(10)
  // 72 + 10%/day × 3.71 days ≈ 110% → about −10% at reset
  expect(signed(lastWeek.arrive)).toBe('−10%')
})

test('rounding wobble inside one window is not counted twice', async () => {
  const readings = week([[3, 40], [2, 39], [1, 41]])
  const total = increments(readings, 'week').reduce((a, i) => a + i.amount, 0)
  expect(total).toBe(1)
})

test('after a reset the new window counts from zero', async () => {
  const before: RangeReading = [T0 - 2 * HOUR, 1, 95, T0 - HOUR]
  const after: RangeReading = [T0, 1, 3, T0 - HOUR + 7 * DAY]
  // watched throughout, so the rise sits in the minutes before the reading
  const incs = increments([before, after], 'week', [[T0 - 3 * HOUR, T0]])
  expect(incs.length).toBe(1)
  expect(incs[0]!.amount).toBe(3)
  expect(Math.round(usedBetween(incs, T0 - 10 * MIN, T0) * 1000)).toBe(3000)
})

test('usage from a gap this computer slept through goes into the current 5-hour window', async () => {
  // the laptop's last reading was 18h ago; the desktop then worked 13:00–15:00 (2h ago to now),
  // opening a 5-hour window 2h ago; the laptop wakes now and sees the week rise 40 → 46
  const weekly: RangeReading[] = [[T0 - 18 * HOUR, 1, 40, weekReset], [T0, 1, 46, weekReset]]
  const five: RangeReading = [T0, 0, 30, T0 + 3 * HOUR]
  const incs = increments([...weekly, five], 'week', [[T0 - 19 * HOUR, T0 - 18 * HOUR]])
  expect(incs.length).toBe(1)
  expect(incs[0]!.start).toBe(T0 - 2 * HOUR)
  expect(incs[0]!.hole).toEqual([T0 - 18 * HOUR, T0 - 2 * HOUR])
  expect(Math.round(usedBetween(incs, T0 - 2 * HOUR, T0))).toBe(6)

  // with no 5-hour window opened in the gap, the rise is spread evenly over it
  const even = increments(weekly, 'week', [])
  expect(even[0]!.start).toBe(T0 - 18 * HOUR)
  expect(even[0]!.hole).toEqual([T0 - 18 * HOUR, T0])
  expect(Math.round(usedBetween(even, T0 - 9 * HOUR, T0))).toBe(3)
})

test('without enough behind the average there is no estimate', async () => {
  // recording began an hour ago, 3d 7h into the week
  const readings = week([[1, 50], [0, 52]])
  expect(project(readings, 'week', T0, hours(72))!.noData).toBe('3d needs 3d 0h of recorded usage. 1h 00m recorded so far, about 2d 23h to go.')
  // under six hours a weekly average is no estimate
  expect(project(readings, 'week', T0, hours(1))!.noData).toBe('Weekly estimates need at least 6h 00m of data. Set the window to 6h 00m or more.')
  expect(project(readings, 'week', T0, { type: 'reset' })!.noData).toBe(null)
  // two hours after a reset is too soon to project the week from
  const fresh: RangeReading[] = [[T0, 1, 4, T0 + 7 * DAY - 2 * HOUR]]
  expect(project(fresh, 'week', T0, { type: 'reset' })!.noData).toBe('No estimate this soon after the reset. About 4h 00m to go.')
  expect(needsMore(hours(24), 5.5)).toBe('1d needs 1d 0h of recorded usage. 5h 30m recorded so far, about 18h 30m to go.')
})

test("since the reset uses Anthropic's figure; a window uses only what was recorded", async () => {
  // 52% used, 3d 7h into the week; recording began seven hours ago
  const readings = week([[7, 45], [1, 50], [0, 52]])
  const sinceReset = project(readings, 'week', T0, { type: 'reset' })!
  expect(sinceReset.winH).toBe(79)
  expect(Math.round(sinceReset.rate * 79)).toBe(52)
  const recorded = project(readings, 'week', T0, hours(7))!
  expect(recorded.winH).toBe(7)
  expect(Math.round(recorded.rate * 7)).toBe(7)
})

test('reset countdown switches units', async () => {
  const m = project(week([[1, 10], [0, 12]]), 'week', T0, hours(24))!
  expect(resetsIn(m, false)).toBe('Resets in 3.7 days')
  expect(resetsIn(m, true)).toBe('Resets in 89 hours')
})

test('window text parses', async () => {
  expect(parseWindow('2d')).toEqual({ n: 2, unit: 'd' })
  expect(parseWindow('6 hours')).toEqual({ n: 6, unit: 'h' })
  expect(parseWindow('7d')).toEqual({ n: 7, unit: 'd' })
  expect(parseWindow('2w')).toBe(null)
  expect(parseWindow('9w')).toBe(null)
  expect(parseWindow('soon')).toBe(null)
})
