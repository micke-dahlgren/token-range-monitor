import { expect, mock, test } from 'claude-code/testing'

import { HOUR } from '../hooks/range'

const T0 = Date.UTC(2026, 9, 12, 9, 0)

test('the band draws the context window as a thin bar under its line', async ($, on) => {
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  mock.clock(on, { now: T0 })
  let context: { window: number; tokens?: number; percent?: number } = { window: 200_000 }
  on('session.usage', () => ({ value: { context, rateLimits: [] } }) as never)
  const mount = () => $.ui.mount({ plugin: 'token-range-monitor', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 60 } as never })
  const limits = [{ kind: 'five_hour' as const, percentUsed: 20, resetsAt: new Date(T0 + 3 * HOUR).toISOString() }]

  // before a response reports the fill: no bar
  await $.session.measure({ context: { window: 200_000 }, rateLimits: limits, changed: ['rateLimits'] })
  let band = await mount()
  expect(await band.find({ key: 'band-context' })).toBeUndefined()
  await band.unmount()

  // 34% of the window: a third of the bar filled, and the figure beside it
  context = { window: 200_000, tokens: 68_000, percent: 34 }
  await $.session.measure({ context, rateLimits: limits, changed: ['context'] })
  band = await mount()
  expect(await band.find({ key: 'band-context' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: ' context 34%' })).toBeDefined()
  const filled = (await band.find({ type: 'Text', text: /^━+$/ }))?.text ?? ''
  expect(filled.length).toBe(Math.round((60 - ' context 34%'.length) * 0.34))
  await band.unmount()
})
