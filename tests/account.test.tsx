import { expect, mock, test } from 'claude-code/testing'

import type { RangeReading } from '../types'
import { DAY, HOUR } from '../hooks/range'

const T0 = Date.UTC(2026, 9, 9, 15, 0)
const weekReset = T0 + 3 * DAY + 17 * HOUR
const fiveReset = T0 + 2 * HOUR

test("the record is the signed-in account's: an older record moves under it, another account's stays out", async ($, on) => {
  const weekly: RangeReading[] = [[T0 - 30 * HOUR, 1, 20, weekReset], [T0 - HOUR, 1, 30, weekReset]]
  const fiveHour: RangeReading[] = [[T0 - 30 * 60_000, 0, 10, fiveReset], [T0 - 60_000, 0, 40, fiveReset]]
  mock.store(on, { 'r:old': weekly, 'other.org/r:x': fiveHour })
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on, { now: T0 })
  let signedIn = 'me'
  on('fs.read', ($, e, next) =>
    e.path === '/home/t/.claude.json' ? { value: JSON.stringify({ oauthAccount: { accountUuid: signedIn, organizationUuid: 'org' } }) } : next(e))
  on('session.usage', () => ({ value: { rateLimits: [] } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/home/t', surface: 'desktop', isInteractive: true })

  const shown = async () => {
    const pane = await $.ui.mount({
      plugin: 'token-range-monitor', surface: 'desktop', component: 'Pane', requestId: 'token-range-monitor',
      props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
    })
    const out = {
      week: (await pane.find({ type: 'Text', text: 'No weekly limit reported.' })) === undefined,
      five: (await pane.find({ type: 'Text', text: 'No active 5-hour window.' })) === undefined,
    }
    await pane.unmount()
    return out
  }
  // the record from before accounts is this account's; the other account's 5-hour window isn't
  expect(await shown()).toEqual({ week: true, five: false })

  // signed in to the other account, its figures bring its own record
  signedIn = 'other'
  await clock.set(T0 + 60_000)
  await $.session.measure({
    context: {} as never,
    rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: new Date(fiveReset).toISOString() }],
    changed: ['rateLimits'],
  })
  expect(await shown()).toEqual({ week: false, five: true })
})

test("another copy's store (a marketplace install beside a dev copy) is read too", async ($, on) => {
  const fiveHour: RangeReading[] = [[T0 - 40 * 60_000, 0, 10, fiveReset], [T0 - 60_000, 0, 40, fiveReset]]
  mock.store(on, {})
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on, { now: T0 })
  const stores = '/home/t/.claude/plugins/store'
  on('fs.list', ($, e, next) => (e.path === stores
    ? { value: [{ name: 'token-range-monitor_market-1.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }, { name: 'other-plugin_x.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }
    : next(e)) as never)
  on('fs.read', ($, e, next) =>
    e.path === '/home/t/.claude.json' ? { value: JSON.stringify({ oauthAccount: { accountUuid: 'me', organizationUuid: 'org' } }) }
    : e.path === `${stores}/token-range-monitor_market-1.json` ? { value: JSON.stringify({ 'r:abc': fiveHour, settings: {} }) }
    : next(e))
  on('session.usage', () => ({ value: { rateLimits: [] } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/home/t', surface: 'desktop', isInteractive: true })

  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
  })
  expect(await pane.find({ type: 'Text', text: 'No active 5-hour window.' })).toBeUndefined()
  await pane.unmount()
})
