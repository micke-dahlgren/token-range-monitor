import { expect, test } from 'claude-code/testing'

import type { RangeReading } from '../types'
import {
  basisRuns, fiveCardSvg, fiveHead, fivePart, fiveRuns, fiveSummary, hm, missRuns, partsWidth,
  todaySvg, todayRuns, todayText, weekCardSvg, weekHead, weekHeadline, weekLegendSvg, weekPart,
} from '../hooks/cards'
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
  expect(fivePart(calm, at(11, 11), false)).toMatchObject({ value: '~55% left at 15:40', rest: '', bad: false, spare: true })
  expect(fivePart(calm, at(11, 11), true)).toMatchObject({ value: '~55% @15:40', rest: '' })
  expect(fiveHead(calm, at(11, 11)).head).toBe('Lasts to the reset at 15:40')

  // opened 19:40, read at 22:00 with 52% used: out after midnight, at 00:09, the reset at 00:40
  const late = five(at(10, 19, 40), at(10, 22), 52)
  expect(fivePart(late, at(10, 22), false)).toMatchObject({ value: 'cut off ~00:09', rest: ', resets 00:40' })
  expect(hm(late.resetsAt)).toBe('00:40')

  // the drawing names its frame and the cut-off's time, and its bar is the window's use: used, then this pace's addition
  const svg = fiveCardSvg(cut, now, 600)
  expect(svg).toContain('100% = your 5-hour limit')
  expect(svg).toContain('<tspan style="fill:var(--bad)" font-weight="600">~17:36 </tspan>')
  expect(svg).toContain('>, cut off ~17:36<')
  expect(svg).toContain('>at this pace<')
  expect(svg).not.toMatch(/NaN|Infinity|undefined/)
  // the figures under the head: what's used and the pace in bold, the time after the cut-off in red
  expect(fiveRuns(cut, now).map(r => r.s).join('')).toBe(fiveHead(cut, now).sub)
  expect(fiveRuns(cut, now).at(-1)).toMatchObject({ s: '34m after the cut-off.', fill: 'var(--bad)' })
  expect(fiveRuns(calm, at(11, 11)).map(r => r.s).join('')).toBe('3% used since 10:40, 9% an hour. About 55% to spare at the reset.')
  // the Details strip, at 1.3's pace: when it runs out, or what's left
  expect(fiveSummary(cut).map(r => r.s).join('')).toMatch(/^Runs out in \d+h \d+m · \d+m early$/)
  expect(fiveSummary(calm).map(r => r.s).join('')).toMatch(/^At the reset \d+% to spare · resets in /)
  expect(fiveCardSvg(calm, at(11, 11), 600)).toContain('Lasts to the reset at ')
})

/** A plan at Saturday 11 October 16:00 (a Thursday 11:00 reset), with what the test changes. */
const plan = (o: Partial<WeekPlan> = {}): WeekPlan => ({
  now: at(11, 16), pct: 39, resetsAt: at(15, 11), k: 2, dayStart: at(11, 11), dayEnd: at(12, 11),
  usedToday: 12, expectedToday: 13.5, today: 13.5,
  later: [0, 1, 2, 3].map(i => ({ start: at(12 + i, 11), amount: 13.5 })),
  basis: 'pace', pacePerDay: 13.5, paceDays: 7, left: 100 - (39 + 1.5 + 54), runsOutAt: null, runsOutToday: false, early: 0,
  budget: 14.6, predicted: 13.5 / 14.6 * 100, usedOfBudget: 12 / 14.6 * 100, miss: null, noData: null, ...o,
})

test('the week part: left at the reset, with its range, running out, and early before a whole day is on record', () => {
  expect(weekPart(plan(), false)).toMatchObject({ label: 'Week', value: '~6% left at reset', rest: ', in 3d 19h', bad: false, spare: true })
  expect(weekPart(plan(), true)).toMatchObject({ value: '~6% @reset', rest: ' 3d 19h' })
  expect(weekPart(plan({ miss: 12 }), false).value).toBe('~6% left at reset ±12')
  expect(weekPart(plan({ miss: 12 }), true).value).toBe('~6% @reset ±12')

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

  // the card's own words: the headline with its range apart, the basis and the range in bold
  expect(weekHeadline(plan({ miss: 12 }))).toEqual({ head: 'About 6% left at the reset', tone: 'good', badge: '±12 pts' })
  expect(weekHeadline(plan()).badge).toBe(null)
  expect(basisRuns(plan()).map(r => r.s)).toEqual(['At your pace over the last 7 whole days: ', '13.5% a day.'])
  expect(missRuns(plan({ miss: 12 }))!.map(r => r.s).join('')).toBe('Typical forecast miss: 12 points. Read this as between 6% short and 18% to spare.')
  expect(missRuns(plan({ miss: 3 }))!.map(r => r.s).join('')).toBe('Typical forecast miss: 3 points. Read this as 3–9% to spare.')
  expect(missRuns(plan())).toBe(null)
  expect(todayRuns(plan()).map(r => r.s).join('')).toBe(d.note)
  expect(todayRuns(plan()).at(-1)!.s).toBe('14.6% of your weekly limit.')

  const svg = weekCardSvg(plan({ miss: 12 }), [20, 7], 600)
  expect(svg).toContain('>This week · 100% = your weekly limit<')
  expect(svg).toContain('>±12 pts<')
  expect(svg).toContain('>+55.5% </tspan>')
  expect(svg).toContain('100% · resets Thu 11:00')
  // the days: dated, the daily budget outlined over today and the days after (five outlines), or not at all
  expect(svg).toContain('>Oct 08<')
  expect(svg).toContain('>~13.5%<')
  expect(svg.match(/fill="none" style="stroke:var\(--muted\)"/g)?.length).toBe(5)
  expect(weekCardSvg(plan(), [20, 7], 600, undefined, false)).not.toMatch(/fill="none" style="stroke:var\(--muted\)"/)
  expect(svg).not.toMatch(/NaN|Infinity|undefined/)
  // today's frame, on its panel
  const today = todaySvg(plan(), 600)
  expect(today).toContain('>Today · 100% = today’s budget<')
  expect(today).toContain('>Predicted use today<')
  expect(today).toContain('>92.5%<')
  expect(today).toContain('100% · day ends 11:00')
  expect(today).not.toMatch(/NaN|Infinity|undefined/)
  expect(todaySvg(plan(), 320)).not.toMatch(/NaN|Infinity|undefined/)
  expect(weekLegendSvg(false).svg).toContain('>Expected at your pace<')
  // early: the days to come unknown
  const early = weekCardSvg(plan({ basis: 'early', paceDays: 0 }), [20, 7], 600)
  expect(early).toContain('>?<')
  expect(weekLegendSvg(true).svg).toContain('>Not known yet<')
})

test('a day is short of a week: the reset countdown and day boundaries line up', () => {
  expect(DAY).toBe(24 * HOUR)
  expect(hm(at(10, 11) + DAY)).toBe('11:00')
})
