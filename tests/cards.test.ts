import { expect, test } from 'claude-code/testing'

import type { RangeReading } from '../types'
import { fiveCardSvg, fiveHead, fivePart, hm, partsWidth, projectsSvg, todayText, weekCardSvg, weekHead, weekPart } from '../hooks/cards'
import type { WeekPlan } from '../hooks/pace'
import { DAY, HOUR, MIN, project } from '../hooks/range'

// local times, so the clock words don't depend on the zone the tests run in
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()

/** A 5-hour window from `opened`, read at `now` with `pct` used. */
const five = (opened: number, now: number, pct: number) => {
  const r: RangeReading[] = [[opened + MIN, 0, 0, opened + 5 * HOUR], [now, 0, pct, opened + 5 * HOUR]]
  return project(r, 'five', now, { type: 'reset' })!
}

test('the 5-hour part reads in clock times: a cut-off, lasting to the reset, a reset after midnight', () => {
  // 64% in 2h 50m: 22.6% an hour, out at ~17:36, before the 18:10 reset
  const now = at(10, 16), cut = five(at(10, 13, 10), now, 64)
  expect(fivePart(cut, now, false)).toMatchObject({ value: 'cut off ~17:36', rest: ', resets 18:10', bad: true })
  expect(fivePart(cut, now, true)).toMatchObject({ value: 'out 17:36', rest: '' })
  expect(fiveHead(cut, now).head).toBe('Cut off ~17:36 at this pace')
  expect(fiveHead(cut, now).sub).toBe('64% used since 13:10, 22.6% an hour. It resets at 18:10, 34m after the cut-off.')

  // 3% in 20 minutes lasts: 9% an hour for the 4h 40m left
  const calm = five(at(11, 10, 40), at(11, 11), 3)
  expect(fivePart(calm, at(11, 11), false)).toMatchObject({ value: '55% to spare', rest: ', resets 15:40', bad: false })
  expect(fivePart(calm, at(11, 11), true)).toMatchObject({ value: '+55%', rest: ' 15:40' })
  expect(fiveHead(calm, at(11, 11)).head).toBe('Lasts to the reset at 15:40')

  // opened 19:40, read at 22:00 with 52% used: out after midnight, at 00:09, the reset at 00:40
  const late = five(at(10, 19, 40), at(10, 22), 52)
  expect(fivePart(late, at(10, 22), false)).toMatchObject({ value: 'cut off ~00:09', rest: ', resets 00:40' })
  expect(hm(late.resetsAt)).toBe('00:40')

  // the drawing names its frame and marks the cut-off in words
  const svg = fiveCardSvg(cut, now, 600)
  expect(svg).toContain('100% = YOUR 5-HOUR LIMIT')
  expect(svg).toContain('cut off ~17:36')
  expect(svg).not.toMatch(/NaN|Infinity|undefined/)
})

/** A plan at Saturday 11 October 16:00 (a Thursday 11:00 reset), with what the test changes. */
const plan = (o: Partial<WeekPlan> = {}): WeekPlan => ({
  now: at(11, 16), pct: 39, resetsAt: at(15, 11), k: 2, dayStart: at(11, 11), dayEnd: at(12, 11),
  usedToday: 12, expectedToday: 13.5, today: 13.5,
  later: [0, 1, 2, 3].map(i => ({ start: at(12 + i, 11), amount: 13.5 })),
  basis: 'pace', pacePerDay: 13.5, paceDays: 7, left: 100 - (39 + 1.5 + 54), runsOutAt: null, runsOutToday: false, early: 0,
  budget: 14.6, predicted: 13.5 / 14.6 * 100, usedOfBudget: 12 / 14.6 * 100, miss: null, noData: null, ...o,
})

test('the week part: to spare, with its range, running out, and early before a whole day is on record', () => {
  expect(weekPart(plan(), false)).toMatchObject({ label: 'Week', value: '6% to spare', rest: ', resets in 3d 19h', bad: false })
  expect(weekPart(plan(), true)).toMatchObject({ value: '+6%', rest: ' 3d 19h' })
  expect(weekPart(plan({ miss: 12 }), false).value).toBe('6% to spare ±12')
  expect(weekPart(plan({ miss: 12 }), true).value).toBe('+6% ±12')

  const short = plan({ left: -20, runsOutAt: at(14, 12, 50), early: 22 })
  expect(weekPart(short, false)).toMatchObject({ value: 'runs out Wed ~12:45', rest: ', 22h early', bad: true })
  expect(weekPart(short, true)).toMatchObject({ value: 'out Wed 12:45', rest: '' })
  expect(weekPart(plan({ left: -2, runsOutAt: at(11, 23), runsOutToday: true, early: 84 }), false).value).toBe('runs out later today')

  const early = plan({ basis: 'early', paceDays: 0 })
  expect(weekPart(early, false).tag).toBe('early')
  expect(weekPart(early, true).tag).toBe('early')
  expect(partsWidth([weekPart(early, false)])).toBeGreaterThan(partsWidth([weekPart(plan(), false)]))
  expect(weekPart(plan({ basis: 'early', noData: 'No estimate this soon after the reset.' }), false)).toMatchObject({ value: 'No data', dim: true })
})

test('the weekly card: every % names its 100%, and today is in today’s budget', () => {
  const head = weekHead(plan({ miss: 12 }))
  expect(head.head).toBe('About 6% left at the reset ±12')
  expect(head.sub).toBe('At your pace over the last 7 days: 13.5% a day. Your projections have typically been off by 12 points, so read it as between 6% short and 18% to spare.'.replace('7 days', '7 whole days'))
  expect(weekHead(plan({ basis: 'profile' })).sub).toBe('At what you usually use on each of the days left.')
  expect(weekHead(plan({ left: -20, runsOutAt: at(14, 12, 50), early: 22 })).head).toBe('Runs out Wed ~12:45, 22h before the reset')

  // 13.5 ÷ 14.6: 92.5% of the daily budget; red only past 100%
  const d = todayText(plan())
  expect(d.predicted).toBe('Predicted use today: 92.5% of daily budget')
  expect(d.bad).toBe(false)
  expect(d.used).toBe('82.2% used')
  expect(d.end).toBe('100% · day ends 11:00')
  expect(d.note).toBe('Until the day ends, today counts as at least one day at your pace, 92.5% of the budget. Today’s budget is what’s left of the week divided by the days left: 14.6% of your weekly limit.')
  expect(todayText(plan({ usedToday: 16, today: 16, predicted: 16 / 14.6 * 100 })).bad).toBe(true)
  // the floor's sentence only while today's use is under the pace
  expect(todayText(plan({ usedToday: 14, today: 14 })).note).toMatch(/^Today’s budget is/)

  const svg = weekCardSvg(plan(), [20, 7], 600)
  expect(svg).toContain('THIS WEEK · 100% = YOUR WEEKLY LIMIT')
  expect(svg).toContain('TODAY · 100% = TODAY’S BUDGET')
  expect(svg).toContain('+55.5% at this pace')
  expect(svg).toContain('100% · resets Thu 11:00')
  expect(svg).not.toMatch(/NaN|Infinity|undefined/)
  // early: no today frame, the days to come unknown
  const early = weekCardSvg(plan({ basis: 'early', paceDays: 0 }), [20, 7], 600)
  expect(early).not.toContain('TODAY · 100%')
  expect(early).toContain('>?<')
})

test('the projects card adds up to the weekly limit, and lists Other’s parts when opened', () => {
  const sp = {
    used: 39, rows: [{ name: 'token-range-monitor', pct: 20 }, { name: 'blog', pct: 5 }],
    other: { chats: 9, devices: 4, before: 1, away: 0 }, otherTotal: 14, unused: 61,
  }
  const closed = projectsSvg(sp, 600, false)
  expect(closed).toContain('This week · 39% used, 61% unused')
  expect(closed).toContain('>Other ▸<')
  expect(closed).not.toContain('Desktop chats')
  const open = projectsSvg(sp, 600, true)
  expect(open).toContain('Desktop chats')
  expect(open).toContain('Other devices')
  expect(open).not.toContain('>Away<')
  expect(open).toContain('Project names stay on this computer.')
  // a narrow card leaves the bars out, never the figures
  expect(projectsSvg(sp, 300, false)).toContain('>20%<')
})

test('a day is short of a week: the reset countdown and day boundaries line up', () => {
  expect(DAY).toBe(24 * HOUR)
  expect(hm(at(10, 11) + DAY)).toBe('11:00')
})
