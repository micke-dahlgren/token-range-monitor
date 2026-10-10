import { expect, test } from 'claude-code/testing'

import type { RangeReading } from '../types'
import { DAY, HOUR, MIN, averageNote, chartWait, emptyChartText, headerDraw, heartbeat, increments, lastWindow, lastWindowNote, lastWindowText, isWatched, needsMore, refine, parseWindow, project, resetsIn, signed, spreadLabels, usedBetween } from '../hooks/range'

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

test('each rise is shared among the responses behind it, not piled before the reading', async () => {
  // the weekly figure reads 10 for an hour (repeated every few minutes), then 11
  const readings: RangeReading[] = [0, 10, 20, 30, 40, 50].map(m => [T0 - HOUR + m * MIN, 1, 10, weekReset] as RangeReading)
  readings.push([T0, 1, 11, weekReset])
  const seen: Array<[number, number]> = [[T0 - HOUR, T0]]
  const incs = increments(readings, 'week', seen)
  // the rise came some time after the figure first read 10, not in the last minutes
  expect(incs[0]!.from).toBe(T0 - HOUR)
  // three responses: a big one early, two small ones late; the point is shared 2 : 1 : 1
  const shaped = refine(incs, [[T0 - 50 * MIN, 200], [T0 - 10 * MIN, 100], [T0 - 5 * MIN, 100]])
  expect(shaped.map(i => i.amount)).toEqual([0.5, 0.25, 0.25])
  expect(Math.abs(usedBetween(shaped, T0 - HOUR, T0 - 30 * MIN) - 0.5)).toBeLessThan(1e-9)
  // with no responses behind it, the rise stays where the reading put it
  expect(refine(incs, [])).toEqual(incs)
})

// ---- the last window ----

/** 5-hour readings for a window that resets at `reset`: `pct` at each of `minutes` into it. */
const fiveWin = (reset: number, pairs: Array<[number, number]>): RangeReading[] =>
  pairs.map(([m, pct]) => [reset - 5 * HOUR + m * MIN, 0, pct, reset])

test('the last 5-hour window that ended under the limit shows what was left', async () => {
  // the previous window reset an hour ago at 72%; the current one is under way
  const prev = T0 - HOUR
  const readings = [...fiveWin(prev, [[10, 5], [120, 40], [280, 72]]), ...fiveWin(T0 + 4 * HOUR, [[30, 6]])]
  const l = lastWindow(readings, 'five', T0)!
  expect(l.resetsAt).toBe(prev)
  expect(l.ranOutAt).toBe(null)
  expect(l.left).toBe(28)
  expect(lastWindowText(l)).toBe('+28%')
  expect(lastWindowNote(l)).toBe('It ended at 72% used.')
})

test('a 5-hour window that ran out early shows how much more it would have needed', async () => {
  // 100% in 4 hours is 25%/h, the card's since-the-reset rate; the hour locked out would have needed 25% more
  const prev = T0 - HOUR
  const l = lastWindow(fiveWin(prev, [[30, 10], [230, 95], [240, 100], [270, 100]]), 'five', T0)!
  expect(l.ranOutAt).toBe(prev - HOUR)
  expect(l.usedH).toBe(4)
  expect(l.lockedH).toBe(1)
  expect(l.left).toBe(-25)
  expect(lastWindowText(l)).toBe('−25%')
  expect(lastWindowNote(l)).toBe('It ran out 1h before its reset, after 4h of use.')
})

test('the last window hides when the record cannot say how it ended', async () => {
  const prev = T0 - HOUR
  // no window has reset yet: only the current one is on record
  expect(lastWindow(fiveWin(T0 + 2 * HOUR, [[10, 5], [100, 30]]), 'five', T0)).toBe(null)
  expect(lastWindow([], 'five', T0)).toBe(null)
  // the last reading came two hours before the reset: the rest of that window is unknown
  const early = fiveWin(prev, [[30, 20], [180, 60]])
  expect(lastWindow(early, 'five', T0)).toBe(null)
  // ...unless this computer watched to the end, so nothing more came in
  expect(lastWindowText(lastWindow(early, 'five', T0, [[prev - 3 * HOUR, prev]])!)).toBe('+40%')
  // the first reading was already 100%: when it ran out isn't known
  expect(lastWindow(fiveWin(prev, [[200, 100], [290, 100]]), 'five', T0)).toBe(null)
  // a long unwatched gap before reaching 100%
  expect(lastWindow(fiveWin(prev, [[30, 40], [240, 100]]), 'five', T0)).toBe(null)
  // a 30-minute tail is close enough
  expect(lastWindowText(lastWindow(fiveWin(prev, [[30, 40], [271, 55]]), 'five', T0)!)).toBe('+45%')
})

test('the last weekly window: ended under the limit, or ran out a day early', async () => {
  const prev = T0 - 2 * DAY
  const cur = prev + 7 * DAY
  const current: RangeReading[] = [[T0 - DAY, 1, 8, cur], [T0, 1, 15, cur]]
  // last read 10 hours before its reset, within the last 10% of the week
  const under: RangeReading[] = [[prev - 3 * DAY, 1, 40, prev], [prev - 10 * HOUR, 1, 81, prev]]
  expect(lastWindowText(lastWindow([...under, ...current], 'week', T0)!)).toBe('+19%')
  // 100% after six days is 16.7%/day; the day locked out would have needed about 17% more
  const out: RangeReading[] = [[prev - 3 * DAY, 1, 60, prev], [prev - DAY - 3 * HOUR, 1, 99, prev], [prev - DAY, 1, 100, prev]]
  const l = lastWindow([...out, ...current], 'week', T0)!
  expect(l.lockedH).toBe(24)
  expect(lastWindowText(l)).toBe('−17%')
  // read two days before its reset, and not watched since: hidden
  expect(lastWindow([[prev - 2 * DAY, 1, 70, prev], ...current], 'week', T0)).toBe(null)
})

test('the last window is the latest one to have reset, its stale readings left out', async () => {
  const older = T0 - 7 * HOUR, prev = T0 - HOUR
  const readings: RangeReading[] = [
    ...fiveWin(older, [[100, 30], [290, 90]]),
    // the reset jitters by a minute or two between readings: still one window
    [prev - 2 * HOUR, 0, 50, prev + MIN], [prev - 20 * MIN, 0, 64, prev - 2 * MIN],
    // taken after the reset but still naming it: the old figure, not the window's end
    [prev + 5 * MIN, 0, 99, prev],
    ...fiveWin(T0 + 4 * HOUR, [[20, 3]]),
  ]
  expect(lastWindowText(lastWindow(readings, 'five', T0)!)).toBe('+36%')
  // before that window reset, the one before it was the last
  expect(lastWindowText(lastWindow(readings, 'five', prev - 30 * MIN)!)).toBe('+10%')
})

test('the head shows the last window quietly, its caption ending in an info circle', async () => {
  const prev = T0 - HOUR
  const readings = [...fiveWin(prev, [[30, 10], [280, 72]]), ...fiveWin(T0 + 3 * HOUR, [[10, 5], [120, 30]])]
  const m = project(readings, 'five', T0, { type: 'reset' })!
  const head = headerDraw(m, '5-hour window', 700, undefined, '', lastWindow(readings, 'five', T0))
  expect(head.svg).toContain('>Last window<')
  expect(head.svg).toMatch(/fill-opacity="0.7"[^>]*>\+28%</)
  expect(head.info).toBeDefined()
  // without one, no fourth figure and no circle
  const plain = headerDraw(m, '5-hour window', 700, undefined, '')
  expect(plain.svg).not.toContain('Last window')
  expect(plain.info).toBeUndefined()
})
