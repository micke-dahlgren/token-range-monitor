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
  // the countdown is plain text: no unit to switch
  expect(await band.find({ key: 'reset-week' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /^runs out in \d/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^, \S.* early$/ })).toBeDefined()
  await band.unmount()

  // a narrow column: the short form, still one line
  const thin = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 40 } as never,
  })
  expect(await thin.find({ type: 'Text', text: /^out in \d/ })).toBeDefined()
  expect(await thin.find({ type: 'Text', text: /^runs out in / })).toBeUndefined()
  await thin.unmount()

  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  expect(await pane.find({ type: 'Svg' })).toBeDefined()
  // the models card follows the two limits' cards, still learning with no responses seen
  // compact until its Details opens: a summary line, then the full card
  expect(await pane.find({ type: 'Text', text: /^Learning from your responses.$|learning|×/ })).toBeDefined()
  expect((await pane.findAll({ type: 'Svg' })).some(x => String(x.props.alt).startsWith('Models.'))).toBe(false)
  await pane.press({ key: 'details-btn-models' })
  expect((await pane.findAll({ type: 'Svg' })).some(x => String(x.props.alt).startsWith('Models.'))).toBe(true)
  await pane.press({ key: 'details-btn-models' })
  expect(String((await pane.find({ type: 'Svg' }))?.props.alt)).toMatch(/Runs out in /)
  // the selector is native widgets: press the buttons, type into the field
  // the note is text, beside the controls
  const note = async () => (await pane.find({ type: 'Text', text: /^Average (over the last|since)/ }))?.children?.join('') as string | undefined
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
    // every drawing a plain image (an interactive frame flashes on every redraw), its width the card's and a viewBox
    // so it scales evenly, its height left to its proportions; no tooltip left in it
    for (const x of all) {
      expect(x.props.isInteractive).toBeFalsy()
      expect(x.props.height).toBeUndefined()
      // shown one step larger than laid out: the size is the viewBox's times 1.125, both ways
      const [, w, h, vw, vh] = /^<svg [^>]*width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/.exec(String(x.props.source))!.map(Number)
      expect(Math.abs(w! / vw! - 1.125)).toBeLessThan(0.01)
      expect(Math.abs(h! / vh! - 1.125)).toBeLessThan(0.02)
      expect(String(x.props.source)).not.toContain('class="info"')
      // every text placed: no empty coordinates
      expect(String(x.props.source)).not.toMatch(/ [xy]=""/)
    }
    // the weekly drawing (head and chart, with its plot) by its height
    return all.filter(x => String(x.props.source).includes('id="plot"')).map(x => Number(/^<svg [^>]* height="(\d+)"/.exec(String(x.props.source))![1]))
  }
  // the charts fill the pane's height: a tall pane grows them to their most, never beyond
  const tall = await charts(160, 300)
  expect(tall[0]).toBe(440)
  expect((await charts(160, 600))[0]).toBe(440)
  // a shorter pane shrinks them to fit, down to their least, below which the pane scrolls
  const mid = await charts(160, 50), short = await charts(160, 30), tiny = await charts(160, 10)
  expect(mid[0]!).toBeLessThan(tall[0]!)
  expect(short[0]!).toBeLessThanOrEqual(mid[0]!)
  expect(tiny[0]).toBe(200)
})

test('both cards show the last window, on the desktop and in the terminal', async ($, on) => {
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  // the previous 5-hour window ended at 72% just before it reset an hour ago; the previous week ran out a day early
  const prevFive = T0 - HOUR, prevWeek = weekReset - 7 * DAY
  const earlier: RangeReading[] = [
    [prevFive - 4 * HOUR, 0, 20, prevFive], [prevFive - 20 * 60_000, 0, 72, prevFive],
    [prevWeek - 3 * DAY, 1, 60, prevWeek], [prevWeek - DAY - 3 * HOUR, 1, 99, prevWeek], [prevWeek - DAY, 1, 100, prevWeek],
  ]
  const readings = [...earlier, ...READINGS].sort((a, b) => a[0] - b[0])
  const clock = mock.clock(on, { now: readings[0]![0] })
  for (const [t, kind, pct, resetsAt] of readings) {
    await clock.set(t)
    await $.session.measure({
      context: {} as never,
      rateLimits: [{ kind: kind === 1 ? 'seven_day' : 'five_hour', percentUsed: pct, resetsAt: new Date(resetsAt).toISOString() }],
      changed: ['rateLimits'],
    })
  }
  const PANE = { component: 'Pane', requestId: 'token-range-monitor', props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 60, placement: 'dock' } as never } as const

  // the desktop: drawn in each card's head, with its info circle and tooltip
  const desk = await $.ui.mount({ plugin: 'token-range-monitor', surface: 'desktop', ...PANE })
  const alts = (await desk.findAll({ type: 'Svg' })).map(x => String(x.props.alt))
  expect(alts.some(a => a.startsWith('This week.') && a.includes('Last window 17% short. It ran out 1d before its reset, after 6d of use.'))).toBe(true)
  expect(alts.some(a => a.startsWith('5-hour window.') && a.includes('Last window 28% to spare. It ended at 72% used.'))).toBe(true)
  const sources = (await desk.findAll({ type: 'Svg' })).map(x => String(x.props.source)).filter(src => src.includes('>Last window<'))
  expect(sources.length).toBe(2)
  for (const src of sources) expect(src).not.toContain('class="info"')
  // what Last window means: behind a Details button on each card, opened by a press
  for (const k of ['week', 'five', 'models']) expect(await desk.find({ type: 'Button', key: `details-btn-${k}` })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^It ended at 72% used\.$/ })).toBeUndefined()
  await desk.press({ key: 'details-btn-five' })
  expect(await desk.find({ type: 'Text', text: /^It ended at 72% used\.$/ })).toBeDefined()
  expect((await desk.find({ type: 'Button', key: 'details-btn-five' }))?.props.label).toBe('Hide details')
  await desk.unmount()

  // the terminal: a dim line under the figures
  const term = await $.ui.mount({ plugin: 'token-range-monitor', surface: 'terminal', ...PANE })
  expect((await term.findAll({ type: 'Text', text: /^Last window$/ })).length).toBe(2)
  expect(await term.find({ type: 'Text', text: '28% to spare' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '17% short' })).toBeDefined()
  await term.unmount()

  // the band above the prompt doesn't show it
  const band = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120 } as never,
  })
  expect(await band.find({ type: 'Text', text: 'Last window' })).toBeUndefined()
  await band.unmount()
})
