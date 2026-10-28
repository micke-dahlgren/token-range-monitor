import { expect, test } from 'claude-code/testing'

import type { RangeReading } from '../types'
import {
  fiveCardSvg, fiveHead, fivePart, fiveSummary, hm, missRuns, partsWidth,
  overBudgetAt, todaySvg, todayText, weekCardSvg, weekHead, weekHeadline, weekLegendSvg, weekPart,
} from '../hooks/cards'
import { windowDays } from '../hooks/pace'
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
  expect(fivePart(cut, now, false)).toMatchObject({ value: 'cut off 17:36', rest: ', resets 18:10', bad: true })
  expect(fivePart(cut, now, true)).toMatchObject({ value: 'out 17:36', rest: '' })
  expect(fiveHead(cut, now).head).toBe('Cut off ~17:36 at this pace')
  expect(fiveHead(cut, now).sub).toBe('64% used since 13:10, 22.6% an hour. It resets at 18:10, 34m after the cut-off.')

  // 3% in 20 minutes lasts: 9% an hour for the 4h 40m left
  const calm = five(at(11, 10, 40), at(11, 11), 3)
  expect(fivePart(calm, at(11, 11), false)).toMatchObject({ value: '55% left at 15:40', rest: '', bad: false, spare: true })
  expect(fivePart(calm, at(11, 11), true)).toMatchObject({ value: '55% @15:40', rest: '' })
  expect(fiveHead(calm, at(11, 11)).head).toBe('Lasts to the reset at 15:40')

  // opened 19:40, read at 22:00 with 52% used: out after midnight, at 00:09, the reset at 00:40
  const late = five(at(10, 19, 40), at(10, 22), 52)
  expect(fivePart(late, at(10, 22), false)).toMatchObject({ value: 'cut off 00:09', rest: ', resets 00:40' })
  expect(hm(late.resetsAt)).toBe('00:40')

  // the drawing names the cut-off's time, and its bar is the window's use: used, then this pace's addition
  const svg = fiveCardSvg(cut, now, 600)
  expect(svg).not.toContain('100% = your 5-hour limit')
  expect(svg).not.toContain('since 13:10')
  expect(svg).toContain('<tspan style="fill:var(--bad)" font-weight="600">~17:36 </tspan>')
  // the bar's figures in their parts: what's used, and where this pace ends up, in red past the limit
  expect(svg).toContain('>64%<')
  expect(svg).toMatch(/style="fill:var\(--bad\)"[^>]*>~11\d(\.\d)?%</)
  expect(svg).toContain('>Started 13:10<')
  expect(svg).toContain('>Resets 18:10<')
  expect(svg).not.toContain('Opened 13:10')
  expect(svg).not.toContain('100% · resets')
  expect(svg).not.toMatch(/NaN|Infinity|undefined/)
  // the Details strip, at 1.3's pace: when it runs out, or what's left
  expect(fiveSummary(cut).map(r => r.s).join('')).toMatch(/^Runs out in \d+h \d+m · \d+m early$/)
  expect(fiveSummary(calm).map(r => r.s).join('')).toMatch(/^At the reset \d+% to spare · resets in /)
  expect(fiveCardSvg(calm, at(11, 11), 600)).toContain('Lasts to the reset at ')
})

/**
 * A plan at Sunday 11 October 16:00 (a Thursday 11:00 reset), with what the test changes: the window's days run
 * from Thursday 11:00 to midnight, then calendar days, to Thursday 11:00; today is the fourth.
 */
const plan = (o: Partial<WeekPlan> = {}): WeekPlan => ({
  now: at(11, 16), pct: 39, resetsAt: at(15, 11), days: windowDays(at(15, 11)), k: 3, dayStart: at(11, 0), dayEnd: at(12, 0),
  past: [5, 20, 7], usedToday: 12, expectedToday: 13.5, today: 13.5,
  later: [0, 1, 2, 3].map(i => ({ start: at(12 + i, 0), end: i < 3 ? at(13 + i, 0) : at(15, 11), amount: 13.5 })),
  basis: 'pace', pacePerDay: 13.5, paceDays: 7, left: 100 - (39 + 1.5 + 54), runsOutAt: null, runsOutToday: false, early: 0,
  budget: 14.6, budgetPerDay: 14.6, predicted: 13.5 / 14.6 * 100, usedOfBudget: 12 / 14.6 * 100, miss: null, noData: null, ...o,
})

test('the week part: left at the reset, with its range, running out, and early before a whole day is on record', () => {
  expect(weekPart(plan(), false)).toMatchObject({ label: 'Week', value: '6% left at reset', rest: ', in 3d 19h', bad: false, spare: true })
  expect(weekPart(plan(), true)).toMatchObject({ value: '6% @reset', rest: ' 3d 19h' })
  expect(weekPart(plan({ miss: 12 }), false).value).toBe('6% left at reset ±12')
  expect(weekPart(plan({ miss: 12 }), true).value).toBe('6% @reset ±12')
  // the miss is shown to one decimal, as every figure is
  expect(weekPart(plan({ miss: 7.505208333333336 }), false).value).toBe('6% left at reset ±7.5')
  expect(weekHeadline(plan({ miss: 7.505208333333336 })).badge).toBe('±7.5 pts')
  expect(missRuns(plan({ miss: 7.25 }))!.map(r => r.s).join('')).toBe('Typical forecast miss: 7.3 points. Read this as between 1.3% short and 13.3% to spare.')

  const short = plan({ left: -20, runsOutAt: at(14, 12, 50), early: 22 })
  expect(weekPart(short, false)).toMatchObject({ value: 'runs out Wed 12:45', rest: ', 22h early', bad: true })
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
  expect(d.end).toBe('100% · day ends at midnight')
  expect(todayText(plan({ k: 7, dayStart: at(15, 0), dayEnd: at(15, 11) })).end).toBe('100% · week resets 11:00')
  expect(d.note).toBe('Predicted: what’s used so far, and the rest of the day at your pace. Today’s budget is what’s left of the week spread over the time to the reset: 14.6% of your weekly limit.')
  expect(todayText(plan({ usedToday: 16, today: 16, predicted: 16 / 14.6 * 100 })).bad).toBe(true)

  // the card's own words: the headline with its range apart, the range in bold
  expect(weekHeadline(plan({ miss: 12 }))).toEqual({ head: 'About 6% left at the reset', tone: 'good', badge: '±12 pts' })
  expect(weekHeadline(plan()).badge).toBe(null)
  expect(missRuns(plan({ miss: 12 }))!.map(r => r.s).join('')).toBe('Typical forecast miss: 12 points. Read this as between 6% short and 18% to spare.')
  expect(missRuns(plan({ miss: 3 }))!.map(r => r.s).join('')).toBe('Typical forecast miss: 3 points. Read this as 3–9% to spare.')
  expect(missRuns(plan())).toBe(null)

  const svg = weekCardSvg(plan({ miss: 12 }), [5, 20, 7], 600)
  // no frame label, basis line or days' caption: the headline, its badge and the bar say it
  expect(svg).not.toContain('100% = your weekly limit')
  expect(svg).not.toContain('At your pace over the last')
  expect(svg).not.toContain('Each day, in % of your weekly limit')
  expect(svg).toContain('>±12 pts<')
  // the striped part shows where the pace ends up, a total: 39 + 55.5
  expect(svg).toContain('>39%<')
  expect(svg).toContain('>~94.5%<')
  expect(svg).not.toContain('+55.5%')
  expect(svg).toContain('>Started Thu · Oct 08 · 11:00<')
  expect(svg).toContain('>Resets Thu · Oct 15 · 11:00<')
  expect(svg).not.toContain('in 3d')
  // the days: dated, the daily budget outlined over today and the days after (five outlines)
  // the headline: only its figure in the tone
  expect(svg).toMatch(/style="fill:var\(--fg\)" font-weight="600">About <\/tspan><tspan style="fill:var\(--accent\)" font-weight="600">6%/)
  // calendar days: the window's first and last are part days, saying where they start and stop
  expect(svg).toContain('>from 11:00<')
  expect(svg).toContain('>Oct 09<')
  expect(svg).toContain('>to 11:00<')
  expect(svg).toContain('>~13.5%<')
  expect(svg.match(/fill="none" style="stroke:var\(--muted\)"/g)?.length).toBe(5)
  expect(svg).not.toMatch(/NaN|Infinity|undefined/)
  // today's frame, on its panel
  const today = todaySvg(plan(), 600)
  expect(today).not.toContain('100% = today’s budget')
  expect(today).not.toContain('Today’s budget is')
  // laid out as the 5-hour card: the headline, then the bar on today's budget with the day's ends under it
  expect(today).toContain('>Today<')
  expect(today).toContain('Within today’s budget at this pace')
  expect(today).toContain('>82.2%<')
  expect(today).toContain('>Started 00:00<')
  expect(today).toContain('>Ends at midnight<')
  // past the budget later today: when, in red
  const over = plan({ usedToday: 10, today: 17.5, usedOfBudget: 10 / 14.6 * 100, predicted: 17.5 / 14.6 * 100 })
  expect(overBudgetAt(over)).toBe(Math.round((at(11, 16) + 4.6 / 7.5 * 8 * HOUR) / 60_000) * 60_000)
  expect(todaySvg(over, 600)).toContain(`>~${hm(overBudgetAt(over)!)} </tspan>`)
  expect(overBudgetAt(plan({ usedOfBudget: 110 }))).toBe(at(11, 16))
  expect(todaySvg(plan({ usedOfBudget: 110 }), 600)).toContain('Over today’s budget')
  expect(today).not.toMatch(/NaN|Infinity|undefined/)
  expect(todaySvg(plan(), 320)).not.toMatch(/NaN|Infinity|undefined/)
  expect(weekLegendSvg(false).svg).toContain('>Expected at your pace<')
  // early: the days to come unknown
  const early = weekCardSvg(plan({ basis: 'early', paceDays: 0 }), [5, 20, 7], 600)
  expect(early).toContain('>?<')
  expect(weekLegendSvg(true).svg).toContain('>Not known yet<')
})

test('a day is short of a week: the reset countdown and day boundaries line up', () => {
  expect(DAY).toBe(24 * HOUR)
  expect(hm(at(10, 11) + DAY)).toBe('11:00')
})
