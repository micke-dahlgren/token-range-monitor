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
  // 1.4: the week at the last whole days' pace, the 5-hour cut-off as a clock time
  expect(await band.find({ type: 'Text', text: /^\d+% to spare$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^, resets in \d/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^cut off ~\d\d:\d\d$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^, resets \d\d:\d\d$/ })).toBeDefined()
  await band.unmount()

  // a narrow column: the short form, still one line
  const thin = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 40 } as never,
  })
  expect(await thin.find({ type: 'Text', text: /^\+\d+%$/ })).toBeDefined()
  expect(await thin.find({ type: 'Text', text: /^out \d\d:\d\d$/ })).toBeDefined()
  expect(await thin.find({ type: 'Text', text: /^cut off / })).toBeUndefined()
  await thin.unmount()

  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 60, placement: 'dock' } as never,
  })
  expect(await pane.find({ type: 'Svg' })).toBeDefined()
  // the weekly card: the week's frame and today's, each saying what its 100% is
  const weekAlt = async () => (await pane.findAll({ type: 'Svg' })).map(x => String(x.props.alt)).filter(a => a.startsWith('This week, ') || a.startsWith('Today, ')).join(' ')
  expect(await weekAlt()).toMatch(/^This week, 100% = your weekly limit\. About \d+% left at the reset\./)
  expect(await weekAlt()).toMatch(/Today, 100% = today's budget\. Predicted use today: [\d.]+% of daily budget\./)
  // no comparison with the previous release
  expect(await pane.find({ type: 'Text', text: /^1\.3 shows/ })).toBeUndefined()
  // the daily budget's outlines switch off and on, and the switch says which
  const weekSource = async () => String((await pane.findAll({ type: 'Svg' })).find(x => String(x.props.alt).startsWith('This week, '))?.props.source)
  expect(await weekSource()).toMatch(/fill="none" style="stroke:var\(--muted\)"/)
  await pane.press({ key: 'budget-toggle' })
  expect((await pane.find({ key: 'budget-toggle' }))?.props.label).toBe('☐ Show daily budget')
  expect(await weekSource()).not.toMatch(/fill="none" style="stroke:var\(--muted\)"/)
  await pane.press({ key: 'budget-toggle' })
  expect((await pane.find({ key: 'budget-toggle' }))?.props.label).toBe('☑ Show daily budget')
  // "Expand all details" opens every card's Details and Other at once; again, closes them
  await pane.press({ key: 'expand-all' })
  for (const k of ['week', 'five', 'models']) expect((await pane.find({ key: `details-btn-${k}` }))?.props.label).toBe('Hide details ▴')
  expect((await pane.find({ key: 'other-toggle' }))?.props.label).toBe('▾ Other')
  expect((await pane.find({ key: 'expand-all' }))?.props.label).toBe('Collapse details')
  await pane.press({ key: 'expand-all' })
  for (const k of ['week', 'five', 'models']) expect((await pane.find({ key: `details-btn-${k}` }))?.props.label).toBe('Details ▾')
  expect((await pane.find({ key: 'other-toggle' }))?.props.label).toBe('▸ Other')
  // the models card follows the two limits' cards, still learning with no responses seen
  // compact until its Details opens: a summary line, then the full card
  expect((await pane.findAll({ type: 'Svg' })).some(x => /^Models, learning: Learning from your responses.$/.test(String(x.props.alt)))).toBe(true)
  expect((await pane.findAll({ type: 'Svg' })).some(x => String(x.props.alt).startsWith('Models.'))).toBe(false)
  await pane.press({ key: 'details-btn-models' })
  expect((await pane.findAll({ type: 'Svg' })).some(x => String(x.props.alt).startsWith('Models.'))).toBe(true)
  await pane.press({ key: 'details-btn-models' })
  // 1.3's card is behind the weekly card's Details: its head, chart and controls
  const oldHead = async () => (await pane.findAll({ type: 'Svg' })).map(x => String(x.props.alt)).find(a => a.startsWith('This week.'))
  expect(await oldHead()).toBeUndefined()
  await pane.press({ key: 'details-btn-week' })
  expect(await oldHead()).toMatch(/Runs out in /)
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
  expect(await oldHead()).toMatch(/Runs out in /)

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
      // shown at the size laid out: the design's type sizes, scaling evenly with the card's width
      const [, w, h, vw, vh] = /^<svg [^>]*width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/.exec(String(x.props.source))!.map(Number)
      expect(w).toBe(vw)
      expect(h).toBe(vh)
      expect(String(x.props.source)).not.toContain('class="info"')
      // every text placed: no empty coordinates, no number gone wrong
      expect(String(x.props.source)).not.toMatch(/ [xy]=""|NaN|Infinity|undefined/)
    }
    // the weekly drawing (head and chart, with its plot) by its height
    return all.filter(x => String(x.props.source).includes('id="plot"')).map(x => Number(/^<svg [^>]* height="(\d+)"/.exec(String(x.props.source))![1]))
  }
  // the charts sit behind Details, so their height follows the card's width alone: a wide card, their most
  const wideChart = await charts(160, 300)
  expect(Math.abs(wideChart[0]! - 440)).toBeLessThan(2)
  expect((await charts(160, 10))[0]).toBe(wideChart[0])
  // a narrow one, their least
  expect(Math.abs((await charts(40, 300))[0]! - 260)).toBeLessThan(2)
})

test('both cards show the last window, on the desktop and in the terminal', async ($, on) => {
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  // the previous 5-hour window ended at 72% just before it reset, as the current one opened; the previous week ran out a day early
  const prevFive = fiveReset - 5 * HOUR, prevWeek = weekReset - 7 * DAY
  const earlier: RangeReading[] = [
    [prevFive - 4 * HOUR, 0, 20, prevFive], [prevFive - 20 * 60_000, 0, 72, prevFive],
    [prevWeek - 3 * DAY, 1, 60, prevWeek], [prevWeek - DAY - 3 * HOUR, 1, 99, prevWeek], [prevWeek - DAY, 1, 100, prevWeek],
  ]
  // this week's readings from before it opened would name it while the previous one ran: none can
  const current = READINGS.filter(r => r[1] === 0 || r[0] >= weekReset - 7 * DAY)
  const readings = [...earlier, ...current].sort((a, b) => a[0] - b[0])
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
  // 1.3's head, with Last window, is behind each card's Details
  expect((await desk.findAll({ type: 'Svg' })).some(x => String(x.props.alt).startsWith('This week.'))).toBe(false)
  for (const k of ['week', 'five', 'models']) expect(await desk.find({ type: 'Button', key: `details-btn-${k}` })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /^It ended at 72% used\.$/ })).toBeUndefined()
  await desk.press({ key: 'details-btn-five' })
  await desk.press({ key: 'details-btn-week' })
  const alts = (await desk.findAll({ type: 'Svg' })).map(x => String(x.props.alt))
  expect(alts.some(a => a.startsWith('This week.') && a.includes('Last window 17% short. It ran out 1d before its reset, after 6d of use.'))).toBe(true)
  expect(alts.some(a => a.startsWith('5-hour window.') && a.includes('Last window 28% to spare. It ended at 72% used.'))).toBe(true)
  const sources = (await desk.findAll({ type: 'Svg' })).map(x => String(x.props.source)).filter(src => src.includes('>Last window<'))
  expect(sources.length).toBe(2)
  for (const src of sources) expect(src).not.toContain('class="info"')
  // what Last window means, under it
  expect(await desk.find({ type: 'Text', text: /^It ended at 72% used\.$/ })).toBeDefined()
  expect((await desk.find({ type: 'Button', key: 'details-btn-five' }))?.props.label).toBe('Hide details ▴')
  await desk.unmount()

  // the terminal: each card's bars, each bar saying what its 100% is
  const term = await $.ui.mount({ plugin: 'token-range-monitor', surface: 'terminal', ...PANE })
  expect(await term.find({ type: 'Text', text: '100% = weekly limit' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^Predicted use today: [\d.]+% of daily budget$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^100% = today’s budget, [\d.]+% of the week$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '100% = 5-hour limit' })).toBeDefined()
  expect(await term.find({ key: 'week-bar' })).toBeDefined()
  expect(await term.find({ key: 'week-days' })).toBeDefined()
  expect(await term.find({ key: 'five-bar' })).toBeDefined()
  // compact: the cards keep their border but drop the desktop's padding rows and gaps
  for (const k of ['week', 'five', 'models']) {
    const card = await term.find({ key: `block-${k}` })
    expect(card?.props.padding).toBeUndefined()
    expect(card?.props.gap).toBe(0)
    expect(card?.props.marginBottom).toBe(0)
  }
  // the week and 5-hour cards have no Details in the terminal
  expect(await term.find({ type: 'Button', key: 'details-btn-week' })).toBeUndefined()
  expect(await term.find({ type: 'Button', key: 'details-btn-five' })).toBeUndefined()
  // the models card is one line until its Details opens
  expect(await term.find({ type: 'Text', text: /^This week \d+% used/ })).toBeUndefined()
  await term.press({ key: 'details-btn-models' })
  expect(await term.find({ type: 'Text', text: /^This week \d+% used/ })).toBeDefined()
  await term.unmount()

  // the band above the prompt doesn't show it
  const band = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120 } as never,
  })
  expect(await band.find({ type: 'Text', text: 'Last window' })).toBeUndefined()
  await band.unmount()
})
