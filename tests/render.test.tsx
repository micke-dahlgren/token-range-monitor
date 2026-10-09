import { expect, mock, test } from 'claude-code/testing'

import type { RangeReading } from '../types'
import { DAY, HOUR } from '../hooks/range'

const T0 = Date.UTC(2026, 9, 9, 15, 0)
const weekReset = T0 + 3 * DAY + 17 * HOUR
const fiveReset = T0 + 3 * HOUR + 10 * 60_000

// a calm week, then a heavy last day; a busy 5-hour window
const READINGS: RangeReading[] = [
  ...[[168, 0], [144, 7], [120, 14], [96, 21], [72, 28], [48, 35], [24, 42], [0, 72]].map(
    ([ago, pct]): RangeReading => [T0 - ago! * HOUR, 1, pct!, weekReset]),
  ...[[110, 0], [60, 20], [30, 30], [20, 34], [10, 38], [0, 42]].map(
    ([ago, pct]): RangeReading => [T0 - ago! * 60_000, 0, pct!, fiveReset]),
]

test('the band and the pane draw on the desktop', async ($, on) => {
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const sorted = [...READINGS].sort((a, b) => a[0] - b[0])
  const clock = mock.clock(on, { now: sorted[0]![0] })
  // feed each reading through the plugin's own measure hook, at its time
  for (const [t, kind, pct, resetsAt] of sorted) {
    await clock.set(t)
    await $.session.measure({
      context: {} as never,
      rateLimits: [{ kind: kind === 1 ? 'seven_day' : 'five_hour', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }],
      changed: ['rateLimits'],
    })
  }

  const band = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120 } as never,
  })
  expect((await band.find({ key: 'reset-week' }))?.text).toBe('Resets in 3.7 days')
  await band.press({ key: 'reset-week' })
  expect((await band.find({ key: 'reset-week' }))?.text).toBe('Resets in 89 hours')
  expect(await band.find({ type: 'Text', text: /^−\d+%$/ })).toBeDefined()
  await band.unmount()

  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  expect(await pane.find({ type: 'Svg' })).toBeDefined()
  expect(String((await pane.find({ type: 'Svg' }))?.props.alt)).toMatch(/Runs out in /)
  // the selector is native widgets: press the buttons, type into the field
  // the note is drawn, so it reads from the drawing's alt text
  const note = async () => (await pane.findAll({ type: 'Svg' }))
    .map(x => String(x.props.alt)).find(alt => /^Average (over the last|since)/.test(alt) && !/, limit /.test(alt))
  const press = (key: string) => pane.press({ key })

  // a fresh install averages since the reset, with no window row
  expect(await note()).toMatch(/^Average since the reset /)
  expect(await pane.find({ key: 'win-inc' })).toBeUndefined()
  await press('mode-custom')
  for (let i = 0; i < 6; i++) await press('win-inc')
  expect(await note()).toBe('Average over the last 7d.')
  expect(String((await pane.find({ type: 'Svg' }))?.props.alt)).toMatch(/Runs out in /)

  // switching to hours keeps the count
  await press('unit-h')
  expect(await note()).toBe('Average over the last 7h.')

  // "Since reset" hides the window row; "Custom" brings the window back as it was
  await press('mode-reset')
  expect(await note()).toMatch(/^Average since the reset /)
  expect(await pane.find({ key: 'win-dec' })).toBeUndefined()
  await press('mode-custom')
  expect(await note()).toBe('Average over the last 7h.')
  await press('win-dec')
  expect(await note()).toBe('Average over the last 6h.')
  // 6 hours is the least on offer: the stepper stops there
  await press('win-dec')
  expect(await note()).toBe('Average over the last 6h.')

  // the count is shown between the stepper buttons
  expect(await pane.find({ type: 'Text', text: /^ 6 $/ })).toBeDefined()
  await press('unit-d')
  expect(await note()).toBe('Average over the last 6d.')
  await pane.unmount()

  // the charts fill the card's width, and their height follows it
  const charts = async (bodyColumns: number, bodyRows: number) => {
    const p = await $.ui.mount({
      plugin: 'token-range-monitor', surface: 'desktop', component: 'Pane', requestId: 'token-range-monitor',
      props: { title: 'Token Range Monitor', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows, contentRows: bodyRows } } as never,
    })
    const all = await p.findAll({ type: 'Svg' })
    await p.unmount()
    // every drawing fills its frame's width at its own height: framed, its height given, no scaling viewBox
    for (const x of all) {
      expect(x.props.isInteractive).toBe(true)
      expect(String(x.props.source)).not.toContain('viewBox')
      expect(String(x.props.source)).toContain(':root{width:100%')
      // every text placed: no empty coordinates
      expect(String(x.props.source)).not.toMatch(/ [xy]=""/)
    }
    // the weekly drawing (head and chart, with its plot) by its height
    return all.filter(x => String(x.props.source).includes('id="plot"')).map(x => Number(x.props.height))
  }
  const narrow = await charts(60, 50), wide = await charts(160, 50), wideTaller = await charts(160, 120)
  // the chart's height follows the card's width, not the pane's reported rows
  expect(wide[0]!).toBeGreaterThan(narrow[0]! + 60)
  expect(wideTaller[0]).toBe(wide[0])
})
