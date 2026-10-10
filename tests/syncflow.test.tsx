import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { RangeReading, RangeStep } from '../types'
import { DAY, HOUR, MIN } from '../hooks/range'
import { DEFAULT_SERVER } from '../hooks/sync'

const T0 = Date.UTC(2026, 9, 10, 12, 0)
const weekReset = T0 + 3 * DAY
const fiveReset = T0 + 2 * HOUR
const ME = 'me.org'
const AUTH = { token: 'tok', email: 'me@example.com', server: DEFAULT_SERVER }

// this computer saw the 5-hour window; another device saw the week
const LOCAL: RangeReading[] = [[T0 - 40 * MIN, 0, 10, fiveReset], [T0 - MIN, 0, 30, fiveReset]]
const FAR: RangeReading[] = [[T0 - 30 * HOUR, 1, 20, weekReset], [T0 - 2 * HOUR, 1, 30, weekReset]]
const FAR_STEP: RangeStep = [T0 - 2 * HOUR, 'claude-opus-5-5', 'high', 100, 0]

type Req = { method: string; path: string; query: Record<string, string>; body: any; auth: string | undefined }
type Dev = { id: string; name: string | null; lastSeenAt: number | null; token: string; lists: string[] }
type Answer = [status: number, body: unknown, headers?: Record<string, string>]

/** The sync server, faked: device links, lists per key with a change counter as the cursor, a page size. */
class FakeServer {
  reqs: Req[] = []
  lists = new Map<string, { data: unknown; at: number }>()
  clock = 1
  page = 10
  polls: string[] = ['pending', 'ok']
  fail: ((r: Req) => Answer | undefined) | undefined
  /** The account's devices: this one (token `tok`) and the others. */
  devices: Dev[] = [{ id: 'srv-this', name: 'testbox', lastSeenAt: T0, token: 'tok', lists: [] }]
  constructor(far: Record<string, unknown> = {}) {
    for (const [key, data] of Object.entries(far)) this.lists.set(key, { data, at: this.clock++ })
  }
  count(method: string, path: string) { return this.reqs.filter(r => r.method === method && r.path === path).length }
  handle(r: Req): Answer {
    this.reqs.push(r)
    const f = this.fail?.(r)
    if (f) return f
    if (r.path === '/v1/link/start') return [200, { code: 'ABCD-EFGH', url: `${DEFAULT_SERVER}/link`, pollToken: 'pt', expiresIn: 600, interval: 3 }]
    if (r.path === '/v1/link/poll') {
      const s = this.polls.shift() ?? 'pending'
      return [200, s === 'ok' ? { status: 'ok', deviceToken: 'tok', email: 'me@example.com' } : { status: s }]
    }
    if (r.auth !== 'Bearer tok' || !this.devices.some(d => d.token === 'tok')) return [401, { error: 'unauthorized' }]
    if (r.method === 'GET' && r.path === '/v1/me') {
      return [200, { email: 'me@example.com', providers: ['google'], devices: this.devices.map(d => ({ id: d.id, name: d.name, createdAt: 1, lastSeenAt: d.lastSeenAt, current: d.token === 'tok' })) }]
    }
    if (r.method === 'PUT' && r.path === '/v1/device') {
      this.devices.find(d => d.token === 'tok')!.name = r.body.name
      return [200, { ok: true, name: r.body.name }]
    }
    const rm = /^\/v1\/devices\/(.+)$/.exec(r.path)
    if (r.method === 'DELETE' && rm) {
      const d = this.devices.find(x => x.id === decodeURIComponent(rm[1]!))
      if (!d) return [404, { error: 'not_found' }]
      this.devices = this.devices.filter(x => x !== d)
      for (const key of d.lists) this.lists.delete(key)
      return [200, { ok: true, listsDeleted: d.lists.length }]
    }
    if (r.method === 'PUT' && r.path === '/v1/lists') {
      for (const l of r.body.lists) this.lists.set(l.key, { data: l.data, at: this.clock++ })
      return [200, { ok: true, stored: r.body.lists.length }]
    }
    if (r.method === 'GET' && r.path === '/v1/lists') {
      expect(r.query.account).toBe(ME)
      const since = r.query.since ? Number(r.query.since) : 0
      if (Number.isNaN(since)) return [400, { error: 'invalid_cursor' }]
      const all = [...this.lists].filter(([, l]) => l.at > since).sort((a, b) => a[1].at - b[1].at)
      const page = all.slice(0, this.page)
      const more = all.length > page.length
      return [200, { lists: page.map(([key, l]) => ({ key, data: l.data, updatedAt: l.at })), cursor: String(more ? page[page.length - 1]![1].at : this.clock - 1), more }]
    }
    if (r.method === 'DELETE' && r.path === '/v1/device') return [200, { ok: true }]
    if (r.method === 'DELETE' && r.path === '/v1/me') { this.lists.clear(); return [200, { ok: true }] }
    return [404, { error: 'not_found' }]
  }
}

/** A session on this computer, signed in to Claude as `me.org`; the store and the environment as given; `hostname` prints `testbox`. */
function world(on: On, server: FakeServer, store: Record<string, unknown> = {}, env: Record<string, string> = {}, host: string | null = 'testbox') {
  mock.store(on, { [`${ME}/r:local`]: LOCAL, 'sync:device': 'dev1abc', ...store })
  mock.env(on, { HOME: '/home/t', ...env })
  const clock = mock.clock(on, { now: T0 })
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('fs.read', ($, e, next) =>
    norm(e.path) === '/home/t/.claude.json' ? { value: JSON.stringify({ oauthAccount: { accountUuid: 'me', organizationUuid: 'org' } }) } : next(e))
  on('fs.stat', ($, e, next) => (norm(e.path) === '/home/t/.claude.json' ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : next(e)) as never)
  on('session.usage', () => ({ value: { rateLimits: [] } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  // the host command for the computer's name (CLI only): `null` stands for a surface that can't run one
  on('process.run', (_$, e) => {
    if (host === null) throw new Error('no process here')
    expect(e.argv).toEqual(['hostname'])
    return { value: { exitCode: 0, stdout: `${host}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('http.fetch', (_$, e) => {
    expect(e.url.startsWith(DEFAULT_SERVER)).toBe(true)
    const [path = '', qs = ''] = e.url.slice(DEFAULT_SERVER.length).split('?')
    const query = Object.fromEntries(qs.split('&').filter(Boolean).map(kv => kv.split('=').map(decodeURIComponent) as [string, string]))
    const [status, body, headers = {}] = server.handle({
      method: e.init?.method ?? 'GET', path, query, body: e.init?.body ? JSON.parse(e.init.body) : undefined, auth: e.init?.headers?.authorization,
    })
    return { value: { status, ok: status >= 200 && status < 300, headers, text: JSON.stringify(body) } } as never
  })
  return clock
}

const start = (s: { session: { start: (e: never) => Promise<unknown> } }) =>
  s.session.start({ cwd: '/home/t', surface: 'desktop', isInteractive: true } as never)

const surfaces = ['terminal', 'desktop'] as const

test("signed in: this computer's lists go up as one list per day, another device's come down into the record", async ($, on) => {
  const server = new FakeServer({ 'd:other1-20261010': [FAR, [[T0 - 3 * HOUR, T0 - HOUR]], [FAR_STEP]] })
  server.page = 1
  const clock = world(on, server, { 'sync:auth': AUTH })
  await start($)
  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'terminal', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
  })
  // nothing synced yet: only the 5-hour window seen here
  expect(await pane.find({ type: 'Text', text: 'No weekly limit reported.' })).toBeDefined()

  // the first sync runs a moment after the start
  await clock.advance(1_000)
  const put = server.reqs.find(r => r.method === 'PUT')!
  expect(put.body.account).toBe(ME)
  expect(put.body.lists.map((l: { key: string }) => l.key)).toEqual(['d:dev1abc-20261010'])
  expect(put.body.lists[0].data[0]).toEqual(LOCAL)
  // the other device's week now shows here
  expect(await pane.find({ type: 'Text', text: 'No weekly limit reported.' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'This week' })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /^Synced as me@example\.com · / }))).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /last sync just now/ })).toBeDefined()

  // two lists on the server (the other device's, and this one's just sent), one per page: the second asked for at once with the cursor
  const gets = server.reqs.filter(r => r.method === 'GET' && r.path === '/v1/lists')
  expect(gets.map(r => r.query.since)).toEqual([undefined, '1'])
  // and after the sync, the device list
  expect(server.reqs.at(-1)).toMatchObject({ method: 'GET', path: '/v1/me' })

  // ten minutes on, nothing changed here: no upload, one download from the last cursor
  await clock.advance(10 * MIN)
  expect(server.count('PUT', '/v1/lists')).toBe(1)
  expect(server.reqs.filter(r => r.method === 'GET' && r.path === '/v1/lists').at(-1)!.query.since).toBe('2')
  expect(await pane.find({ type: 'Text', text: /last sync just now/ })).toBeDefined()

  // a new reading here: the next sync sends today's list again, now holding it; the other device's never
  await $.session.measure({ context: {} as never, rateLimits: [{ kind: 'five_hour', percentUsed: 35, resetsAt: new Date(fiveReset).toISOString() }], changed: ['rateLimits'] })
  await clock.advance(10 * MIN)
  expect(server.count('PUT', '/v1/lists')).toBe(2)
  const sent = server.lists.get('d:dev1abc-20261010')!.data as [RangeReading[]]
  expect(sent[0].map(r => r[2])).toEqual([10, 30, 35])
  expect(sent[0].some(r => r[1] === 1)).toBe(false)

  // the session's end sends what changed since
  await $.session.measure({ context: {} as never, rateLimits: [{ kind: 'five_hour', percentUsed: 36, resetsAt: new Date(fiveReset).toISOString() }], changed: ['rateLimits'] })
  await $.session.end({ reason: 'other', sessionId: 's', resume: {} } as never)
  expect(server.count('PUT', '/v1/lists')).toBe(3)
  await pane.unmount()
})

test('a list another session on this computer holds is uploaded with this one: every session sends the whole day', async ($, on) => {
  const server = new FakeServer()
  const other: RangeReading[] = [[T0 - 20 * MIN, 0, 20, fiveReset]]
  const clock = world(on, server, { 'sync:auth': AUTH, [`${ME}/r:othersession`]: other, 'sync:dl:me.org:d:other1-20261010': [FAR, [], []] })
  await start($)
  await clock.advance(1_000)
  const data = server.lists.get('d:dev1abc-20261010')!.data as [RangeReading[]]
  // both sessions' readings, and not the list downloaded before (kept under sync:dl)
  expect(data[0].map(r => r[2])).toEqual([10, 20, 30])
})

test('a token the server no longer knows signs this device out, and the downloaded lists go with it', async ($, on) => {
  const server = new FakeServer({ 'd:other1-20261010': [FAR, [], []] })
  const clock = world(on, server, { 'sync:auth': AUTH })
  await start($)
  await clock.advance(1_000)
  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'terminal', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
  })
  expect(await pane.find({ type: 'Text', text: 'This week' })).toBeDefined()

  server.fail = r => (r.auth ? [401, { error: 'device_expired', message: 'unused' }] : undefined)
  await clock.advance(10 * MIN)
  expect(await pane.find({ key: 'sync-signin' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /signed out after 90 days unused/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'No weekly limit reported.' })).toBeDefined()
  // and nothing more is asked of the server
  const n = server.reqs.length
  await clock.advance(30 * MIN)
  expect(server.reqs.length).toBe(n)
  await pane.unmount()
})

test('a busy or unreachable server is asked again later and later; the record goes on here', async ($, on) => {
  const server = new FakeServer()
  const clock = world(on, server, { 'sync:auth': AUTH })
  server.fail = () => [503, { error: 'over_capacity' }]
  await start($)
  await clock.advance(1_000)
  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
  })
  expect(await pane.find({ type: 'Text', text: /over its free daily limit; trying again in 2 min/ })).toBeDefined()
  expect(server.reqs).toHaveLength(1)
  await clock.advance(MIN)
  expect(server.reqs).toHaveLength(1)
  await clock.advance(MIN)
  expect(server.reqs).toHaveLength(2)
  // 429 says when: never sooner than that
  server.fail = () => [429, { error: 'rate_limited' }, { 'retry-after': '600' }]
  await clock.advance(4 * MIN)
  expect(server.reqs).toHaveLength(3)
  expect(await pane.find({ type: 'Text', text: /asked to slow down; trying again in 10 min/ })).toBeDefined()
  server.fail = undefined
  await clock.advance(9 * MIN)
  expect(server.reqs).toHaveLength(3)
  await clock.advance(MIN)
  // each failed try was an upload; this one went through, then the download, then the device list
  expect(server.reqs.map(r => `${r.method} ${r.path}`)).toEqual(['PUT /v1/lists', 'PUT /v1/lists', 'PUT /v1/lists', 'PUT /v1/lists', 'GET /v1/lists', 'GET /v1/me'])
  expect(await pane.find({ type: 'Text', text: /trying again/ })).toBeUndefined()
  await pane.unmount()
})

test('a cursor the server cannot read starts the download over', async ($, on) => {
  const server = new FakeServer({ 'd:other1-20261010': [FAR, [], []] })
  const clock = world(on, server, { 'sync:auth': AUTH, [`sync:acct:${ME}`]: { cursor: 'garbage', sent: {} } })
  await start($)
  await clock.advance(1_000)
  expect(server.reqs.filter(r => r.method === 'GET' && r.path === '/v1/lists').map(r => r.query.since)).toEqual(['garbage', undefined])
  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'terminal', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
  })
  expect(await pane.find({ type: 'Text', text: 'This week' })).toBeDefined()
  await pane.unmount()
})

test('signing in: a code and a page, asked at the interval until it says yes, then sync starts', async ($, on) => {
  const server = new FakeServer({ 'd:other1-20261010': [FAR, [], []] })
  const clock = world(on, server)
  await start($)
  await clock.advance(1_000)
  expect(server.reqs).toHaveLength(0)
  for (const surface of surfaces) {
    const pane = await $.ui.mount({
      plugin: 'token-range-monitor', surface, component: 'Pane', requestId: 'token-range-monitor',
      props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
    })
    expect(await pane.find({ type: 'Text', text: 'Sync across devices' })).toBeDefined()
    expect((await pane.find({ key: 'sync-signin' }))?.props.label).toBe('Sign in')
    await pane.unmount()
  }

  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'terminal', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
  })
  await pane.press({ key: 'sync-signin' })
  expect(server.reqs[0]).toMatchObject({ method: 'POST', path: '/v1/link/start', body: { deviceName: 'testbox' } })
  for (const surface of surfaces) {
    const p = surface === 'terminal' ? pane : await $.ui.mount({
      plugin: 'token-range-monitor', surface, component: 'Pane', requestId: 'token-range-monitor',
      props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
    })
    expect(await p.find({ type: 'Text', text: 'Waiting for sign-in… code ABCD-EFGH' })).toBeDefined()
    expect(await p.find({ key: 'sync-cancel' })).toBeDefined()
    // the page's address carries no code: it is typed there
    expect((await p.find({ type: 'Link' }))?.props.href).toBe(`${DEFAULT_SERVER}/link`)
    expect((await p.find({ type: 'Link' }))?.props.label).toBe('the sign-in page')
    expect(await p.find({ type: 'Text', text: /and enter the code ABCD-EFGH\./ })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /check it shows/ })).toBeUndefined()
    expect(await p.find({ type: 'Text', text: `${DEFAULT_SERVER}/link` })).toBeDefined()
    if (p !== pane) await p.unmount()
  }

  // asked every 3 seconds: first still waiting, then signed in
  await clock.advance(3_000)
  expect(server.count('POST', '/v1/link/poll')).toBe(1)
  expect(await pane.find({ type: 'Text', text: /^Waiting for sign-in/ })).toBeDefined()
  await clock.advance(3_000)
  expect(server.count('POST', '/v1/link/poll')).toBe(2)
  expect(server.reqs.find(r => r.method === 'GET')?.auth).toBe('Bearer tok')
  for (const surface of surfaces) {
    const p = surface === 'terminal' ? pane : await $.ui.mount({
      plugin: 'token-range-monitor', surface, component: 'Pane', requestId: 'token-range-monitor',
      props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
    })
    expect(await p.find({ type: 'Text', text: /^Synced as me@example\.com · / })).toBeDefined()
    expect(await p.find({ type: 'Text', text: /last sync just now/ })).toBeDefined()
    expect((await p.find({ key: 'sync-signout' }))?.props.label).toBe('Sign out')
    expect((await p.find({ key: 'sync-delete' }))?.props.label).toBe('Delete synced data')
    // the other device's week is in the record now
    expect(await p.find({ type: 'Text', text: 'No weekly limit reported.' })).toBeUndefined()
    if (p !== pane) await p.unmount()
  }
  // the polling stopped
  await clock.advance(30_000)
  expect(server.count('POST', '/v1/link/poll')).toBe(2)
  // the pane redraws each minute: synced at 0:07, drawn at 4:00
  await clock.advance(3 * MIN + 30_000)
  expect(await pane.find({ type: 'Text', text: /last sync 3 min ago/ })).toBeDefined()

  // signing out unlinks the device and takes the other device's lists away
  await pane.press({ key: 'sync-signout' })
  expect(server.count('DELETE', '/v1/device')).toBe(1)
  expect(await pane.find({ key: 'sync-signin' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'No weekly limit reported.' })).toBeDefined()
  await pane.unmount()
})

test('a code nobody signs in with expires, and Cancel stops asking', async ($, on) => {
  const server = new FakeServer()
  server.polls = ['pending', 'expired']
  const clock = world(on, server)
  await start($)
  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'desktop', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
  })
  await pane.press({ key: 'sync-signin' })
  await clock.advance(6_000)
  expect(await pane.find({ type: 'Text', text: /code expired/ })).toBeDefined()
  expect(await pane.find({ key: 'sync-signin' })).toBeDefined()

  server.polls = []
  await pane.press({ key: 'sync-signin' })
  await clock.advance(3_000)
  const asked = server.count('POST', '/v1/link/poll')
  await pane.press({ key: 'sync-cancel' })
  expect(await pane.find({ key: 'sync-signin' })).toBeDefined()
  await clock.advance(30_000)
  expect(server.count('POST', '/v1/link/poll')).toBe(asked)
  await pane.unmount()
})

test('deleting the synced data takes a second press', async ($, on) => {
  const server = new FakeServer()
  const clock = world(on, server, { 'sync:auth': AUTH })
  await start($)
  await clock.advance(1_000)
  const pane = await $.ui.mount({
    plugin: 'token-range-monitor', surface: 'terminal', component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
  })
  await pane.press({ key: 'sync-delete' })
  expect(server.count('DELETE', '/v1/me')).toBe(0)
  expect((await pane.find({ key: 'sync-delete' }))?.props.label).toBe('Press again to delete all synced data')
  // left alone, it asks again from the start
  await clock.advance(10_000)
  expect((await pane.find({ key: 'sync-delete' }))?.props.label).toBe('Delete synced data')
  await pane.press({ key: 'sync-delete' })
  await pane.press({ key: 'sync-delete' })
  expect(server.count('DELETE', '/v1/me')).toBe(1)
  expect(await pane.find({ type: 'Text', text: 'Deleted all synced data and signed out.' })).toBeDefined()
  expect(await pane.find({ key: 'sync-signin' })).toBeDefined()
  await pane.unmount()
})

test('with nonessential traffic turned off, sync is off and says so', async ($, on) => {
  const server = new FakeServer()
  const clock = world(on, server, { 'sync:auth': AUTH }, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  await start($)
  await clock.advance(30 * MIN)
  expect(server.reqs).toHaveLength(0)
  for (const surface of surfaces) {
    const pane = await $.ui.mount({
      plugin: 'token-range-monitor', surface, component: 'Pane', requestId: 'token-range-monitor',
      props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
    })
    expect(await pane.find({ type: 'Text', text: 'Sync across devices' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'off' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC/ })).toBeDefined()
    expect(await pane.find({ key: 'sync-signin' })).toBeUndefined()
    await pane.unmount()
  }
})

const mountPane = ($: { ui: { mount: (o: never) => Promise<any> } }, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'token-range-monitor', surface, component: 'Pane', requestId: 'token-range-monitor',
    props: { title: 'Token Range Monitor', isFocused: false, bodyColumns: 100, placement: 'dock' },
  } as never)

test('signed in, the pane lists the devices: this one first with no Remove, the others with when they were last seen', async ($, on) => {
  const server = new FakeServer()
  server.devices.push(
    { id: 'srv-laptop', name: 'Work laptop', lastSeenAt: T0 - 3 * MIN, token: 'tok-laptop', lists: [] },
    { id: 'srv-null', name: null, lastSeenAt: T0 - 2 * DAY, token: 'tok-null', lists: [] },
  )
  const clock = world(on, server, { 'sync:auth': AUTH })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await start($)
  await clock.advance(1_000)
  // asked once after the sync, not on every redraw
  expect(server.count('GET', '/v1/me')).toBe(1)
  for (const surface of surfaces) {
    const p = await mountPane($, surface)
    expect(await p.find({ type: 'Text', text: 'Linked devices' })).toBeDefined()
    expect(await p.find({ type: 'Text', text: 'testbox · this device' })).toBeDefined()
    expect(await p.find({ type: 'Text', text: 'Work laptop · last seen 3 min ago ·' })).toBeDefined()
    expect(await p.find({ type: 'Text', text: 'Unnamed device · last seen 2 days ago ·' })).toBeDefined()
    expect((await p.find({ key: 'sync-remove-srv-laptop' }))?.props.label).toBe('Remove')
    expect(await p.find({ key: 'sync-remove-srv-null' })).toBeDefined()
    expect(await p.find({ key: 'sync-remove-srv-this' })).toBeUndefined()
    expect((await p.find({ key: 'sync-signout' }))?.props.label).toBe('Sign out')
    await p.unmount()
  }
  expect(server.count('GET', '/v1/me')).toBe(1)
  // this device's name already matched: nothing renamed
  expect(server.count('PUT', '/v1/device')).toBe(0)
  // opening the pane (Details above the prompt) asks again, but not twice within half a minute
  const band = await $.ui.mount({ plugin: 'token-range-monitor', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  await band.press({ key: 'details' })
  expect(server.count('GET', '/v1/me')).toBe(1)
  await clock.advance(MIN)
  await band.press({ key: 'details' })
  expect(server.count('GET', '/v1/me')).toBe(2)
  await band.unmount()
})

test('Remove takes a second press, then removes the device on the server, its lists leave the record, and the list refreshes', async ($, on) => {
  const server = new FakeServer({ 'd:bad1-20261010': [FAR, [], [FAR_STEP]] })
  server.devices.push({ id: 'srv-bad', name: 'Stranger', lastSeenAt: T0 - MIN, token: 'tok-bad', lists: ['d:bad1-20261010'] })
  const clock = world(on, server, { 'sync:auth': AUTH })
  await start($)
  await clock.advance(1_000)
  const pane = await mountPane($, 'terminal')
  // the unwanted device's week shows here
  expect(await pane.find({ type: 'Text', text: 'This week' })).toBeDefined()

  await pane.press({ key: 'sync-remove-srv-bad' })
  expect(server.reqs.some(r => r.method === 'DELETE')).toBe(false)
  expect((await pane.find({ key: 'sync-remove-srv-bad' }))?.props.label).toBe('Press again to remove Stranger and its synced data')
  // left alone, it asks again from the start
  await clock.advance(10_000)
  expect((await pane.find({ key: 'sync-remove-srv-bad' }))?.props.label).toBe('Remove')

  await pane.press({ key: 'sync-remove-srv-bad' })
  await pane.press({ key: 'sync-remove-srv-bad' })
  expect(server.reqs.filter(r => r.method === 'DELETE').map(r => r.path)).toEqual(['/v1/devices/srv-bad'])
  expect(server.devices.map(d => d.id)).toEqual(['srv-this'])
  // gone from the list (asked again), and its lists gone from the record: downloaded again from the start
  expect(server.reqs.at(-1)).toMatchObject({ method: 'GET', path: '/v1/me' })
  expect(server.reqs.filter(r => r.method === 'GET' && r.path === '/v1/lists').at(-1)!.query.since).toBeUndefined()
  expect(await pane.find({ key: 'sync-remove-srv-bad' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /Stranger/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'No weekly limit reported.' })).toBeDefined()
  // still signed in here
  expect(await pane.find({ type: 'Text', text: /^Synced as me@example\.com · / })).toBeDefined()
  await pane.unmount()
})

test('a device the server has no name for gets this computer\'s, once a session', async ($, on) => {
  const server = new FakeServer()
  server.devices[0]!.name = null
  const clock = world(on, server, { 'sync:auth': AUTH })
  await start($)
  await clock.advance(1_000)
  expect(server.reqs.filter(r => r.method === 'PUT' && r.path === '/v1/device').map(r => r.body)).toEqual([{ name: 'testbox' }])
  const pane = await mountPane($, 'desktop')
  expect(await pane.find({ type: 'Text', text: 'testbox · this device' })).toBeDefined()
  await pane.unmount()
  // renamed elsewhere since: this session doesn't ask again
  server.devices[0]!.name = null
  await clock.advance(10 * MIN)
  expect(server.count('PUT', '/v1/device')).toBe(1)
})

test('where no host command runs, the environment says the platform and a generic name fills a missing one only', async ($, on) => {
  const server = new FakeServer()
  server.devices[0]!.name = null
  const clock = world(on, server, { 'sync:auth': AUTH }, { __CF_USER_TEXT_ENCODING: '0x1F5:0:0' }, null)
  await start($)
  await clock.advance(1_000)
  expect(server.reqs.filter(r => r.method === 'PUT' && r.path === '/v1/device').map(r => r.body)).toEqual([{ name: 'Mac' }])
})

test('a generic name never replaces a real one', async ($, on) => {
  const server = new FakeServer()
  server.devices[0]!.name = "Micke's MacBook"
  const clock = world(on, server, { 'sync:auth': AUTH }, { __CF_USER_TEXT_ENCODING: '0x1F5:0:0' }, null)
  await start($)
  await clock.advance(1_000)
  expect(server.count('PUT', '/v1/device')).toBe(0)
})

test('COMPUTERNAME is sent at sign-in and replaces another name', async ($, on) => {
  const server = new FakeServer()
  server.devices[0]!.name = 'old-name'
  const clock = world(on, server, {}, { COMPUTERNAME: 'GAMER-PC', OS: 'Windows_NT' }, null)
  await start($)
  const pane = await mountPane($, 'terminal')
  await pane.press({ key: 'sync-signin' })
  expect(server.reqs[0]).toMatchObject({ path: '/v1/link/start', body: { deviceName: 'GAMER-PC' } })
  await clock.advance(6_000)
  expect(server.reqs.filter(r => r.method === 'PUT' && r.path === '/v1/device').map(r => r.body)).toEqual([{ name: 'GAMER-PC' }])
  await pane.unmount()
})
