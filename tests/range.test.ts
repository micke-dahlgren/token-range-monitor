import { expect, test } from 'claude-code/testing'

import type { RangeReading } from '../types'
import { DAY, HOUR, MIN, averageNote, chartWait, emptyChartText, headerDraw, heartbeat, paceExplain, paceText, recentPace, increments, isWatched, needsMore, parseWindow, project, resetsIn, signed, spreadLabels, usedBetween } from '../hooks/range'

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
  expect(project(readings, 'week', T0, hours(72))!.noData).toBe('3d needs 3d of recorded usage. 1h recorded so far, about 2d 23h to go.')
  // under six hours a weekly average is no estimate
  expect(project(readings, 'week', T0, hours(1))!.noData).toBe('Weekly estimates need at least 6h of data. Set the window to 6h or more.')
  expect(project(readings, 'week', T0, { type: 'reset' })!.noData).toBe(null)
  // two hours after a reset is too soon to project the week from
  const fresh: RangeReading[] = [[T0, 1, 4, T0 + 7 * DAY - 2 * HOUR]]
  expect(project(fresh, 'week', T0, { type: 'reset' })!.noData).toBe('No estimate this soon after the reset. About 4h to go.')
  expect(needsMore(hours(24), 5.5)).toBe('1d needs 1d of recorded usage. 5h 30m recorded so far, about 18h 30m to go.')
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

test("a 5-hour window just installed into averages from Anthropic's figure since it opened", async () => {
  // 20% used, the window opened 2h ago; the first reading came a minute ago
  const r: RangeReading[] = [[T0 - MIN, 0, 20, T0 + 3 * HOUR]]
  const m = project(r, 'five', T0, { type: 'reset' })!
  expect(m.noData).toBe(null)
  expect(m.winH).toBe(2)
  expect(m.rate).toBe(10)
  expect(averageNote(m)).toMatch(/^Average since the 5-hour window opened 2h ago, from Anthropic's figure/)
  // ten minutes after it opened there is no estimate yet
  expect(project([[T0, 0, 3, T0 + 4 * HOUR + 50 * MIN]], 'five', T0, { type: 'reset' })!.noData).toMatch(/after the 5-hour window opened/)
})

test('reset countdown switches units', async () => {
  const m = project(week([[1, 10], [0, 12]]), 'week', T0, hours(24))!
  expect(resetsIn(m, false)).toBe('Resets in 3.7 days')
  expect(resetsIn(m, true)).toBe('Resets in 89 hours')
})

test("the 5-hour countdown reads in hours, and in minutes under an hour", async () => {
  const five = (left: number) => project([[T0 - HOUR, 0, 10, T0 + left * HOUR], [T0, 0, 12, T0 + left * HOUR]], 'five', T0, { type: 'reset' })!
  expect(resetsIn(five(2.5), false)).toBe('Resets in 2.5 hours')
  expect(resetsIn(five(2.5), true)).toBe('Resets in 150 minutes')
  expect(resetsIn(five(0.4), false)).toBe('Resets in 24 minutes')
  expect(resetsIn(five(1 / 60), false)).toBe('Resets in 1 minute')
})

test('window text parses', async () => {
  expect(parseWindow('2d')).toEqual({ n: 2, unit: 'd' })
  expect(parseWindow('6 hours')).toEqual({ n: 6, unit: 'h' })
  expect(parseWindow('7d')).toEqual({ n: 7, unit: 'd' })
  expect(parseWindow('2w')).toBe(null)
  expect(parseWindow('9w')).toBe(null)
  expect(parseWindow('soon')).toBe(null)
})

test('line labels move apart when their lines are close, and stay inside the plot', async () => {
  // far apart: each stays on its line
  expect(spreadLabels([50, 150], 28, 20, 200)).toEqual([50, 150])
  // close: centred on the two lines, a full gap apart, in the lines' order
  expect(spreadLabels([100, 110], 28, 20, 200)).toEqual([91, 119])
  expect(spreadLabels([110, 100], 28, 20, 200)).toEqual([119, 91])
  // close to the top edge: the pair is pushed down inside the plot
  expect(spreadLabels([20, 22], 28, 20, 200)).toEqual([20, 48])
  // close to the bottom edge: pushed up
  expect(spreadLabels([199, 200], 28, 20, 200)).toEqual([172, 200])
})

test('a session idle for longer than 15 minutes counts as not watching', async () => {
  // responses ten minutes apart join into one watched stretch
  let seen = heartbeat([], T0 - 60 * MIN)
  seen = heartbeat(seen, T0 - 50 * MIN)
  expect(seen.length).toBe(1)
  // then the session sat idle for 50 minutes while another device was used
  seen = heartbeat(seen, T0)
  expect(seen.length).toBe(2)
  expect(isWatched(seen, T0 - 60 * MIN, T0 - 50 * MIN)).toBe(true)
  expect(isWatched(seen, T0 - 50 * MIN, T0)).toBe(false)
})

test('a chart waits for enough recorded usage, and says how long', async () => {
  const m = project([[T0 - 2 * HOUR, 1, 10, weekReset], [T0, 1, 12, weekReset]], 'week', T0, { type: 'reset' })!
  expect(chartWait(m, T0)).toBe(4)
  expect(emptyChartText(m, T0)![0]).toBe('Chart in about 4h')
  // a window the record doesn't cover yet, or one shorter than the least, says so in the chart's place
  const eight = project([[T0 - 6 * HOUR, 1, 10, weekReset], [T0, 1, 12, weekReset]], 'week', T0, hours(8))!
  expect(emptyChartText(eight, T0)).toEqual(['Needs 8h of recorded usage', 'About 2h to go. 6h recorded so far.'])
  const one = project([[T0 - 9 * HOUR, 1, 10, weekReset], [T0, 1, 12, weekReset]], 'week', T0, hours(1))!
  expect(emptyChartText(one, T0)![0]).toBe('Weekly averages need at least 6h')
  expect(emptyChartText(project([[T0 - 9 * HOUR, 1, 10, weekReset], [T0, 1, 12, weekReset]], 'week', T0, hours(6))!, T0)).toBe(null)
  expect(chartWait(m, T0 + 4 * HOUR)).toBe(0)
})

test("the recent pace reads the last hour off the 5-hour figure, at the account's own exchange rate", async () => {
  const fiveReset = T0 + 3 * HOUR
  const watched: Array<[number, number]> = [[T0 - 10 * HOUR, T0]]
  // six hours at 6 five-hour points for each weekly point, then a busy last hour: 12 five-hour points
  const readings: RangeReading[] = []
  for (let h = 6; h >= 1; h--) {
    readings.push([T0 - h * HOUR, 1, 40 + (6 - h), weekReset])
    readings.push([T0 - h * HOUR, 0, (6 - h) * 6, fiveReset])
  }
  readings.push([T0, 1, 47, weekReset], [T0, 0, 42, fiveReset])
  const week = project(readings, 'week', T0, { type: 'reset' }, watched)!
  const p = recentPace(readings, week, T0, watched)
  if (!p.ready) throw new Error(p.why)
  expect(Math.round(p.ratio * 10) / 10).toBe(6)
  expect(Math.round(p.recent * 10) / 10).toBe(12)
  expect(Math.round(p.rate * 10) / 10).toBe(2)
  // 53% left at 2%/h: 26.5h, well before the reset 3d 17h away
  expect(paceText(p)).toBe('At this pace, the weekly limit runs out 2d 15h early.')
  // the head shows it as a fourth figure, its caption ending in the info circle
  const head = headerDraw(week, 'This week', 700, undefined, '', p)
  expect(head.svg).toContain('>1hr pace<')
  expect(head.svg).toContain('>48.0%/day<')
  expect(head.info).toBeDefined()
  expect(paceExplain(p)).toBe('In the last hour you used 12.0% of your 5-hour limit. That\'s about 2.00% of your weekly limit, or 48.0% a day.\nThese numbers are estimates that get steadier over time.')
})

test('the recent pace waits for enough to relate the two limits, and says what for', async () => {
  const readings: RangeReading[] = [[T0 - 2 * HOUR, 1, 40, weekReset], [T0, 1, 41, weekReset], [T0 - 2 * HOUR, 0, 1, T0 + HOUR], [T0, 0, 9, T0 + HOUR]]
  const week = project(readings, 'week', T0, { type: 'reset' })!
  const p = recentPace(readings, week, T0)
  expect(p.ready).toBe(false)
  expect(paceText(p)).toBe('No pace yet. It needs your weekly usage to go up 3% while recording. Up 1% so far.')
})
