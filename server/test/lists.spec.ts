import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { accountHash, sha256Hex } from '../src/crypto'
import { DEVICE_IDLE_MS } from '../src/db'
import { housekeeping } from '../src/index'
import { CURSOR_OVERLAP_MS, LIST_KEEP_MS, MAX_STORED_LISTS, PAGE_MAX_LISTS } from '../src/lists'
import { authed, call, fakeWorld, linkDevice, uniq, type World } from './helpers'

const DAY = 24 * 60 * 60 * 1000

interface Got {
  lists: Array<{ key: string; data: unknown[]; updatedAt: number }>
  cursor: string
  more: boolean
}

const put = (w: World, token: string, body: unknown) =>
  call(w, '/v1/lists', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })

const get = (w: World, token: string, account: string | null, since?: string) => {
  const q = new URLSearchParams()
  if (account !== null) q.set('account', account)
  if (since) q.set('since', since)
  return authed(w, `/v1/lists?${q}`, token)
}

async function getOk(w: World, token: string, account: string, since?: string): Promise<Got> {
  const res = await get(w, token, account, since)
  expect(res.status).toBe(200)
  return res.json()
}

/** A fresh user with one linked device; returns its token and user id. */
async function newUser(w: World, deviceName = 'dev') {
  const email = `l-${uniq()}@example.com`
  const code = `c-${uniq()}`
  w.google.set(code, { sub: `g-${uniq()}`, email, email_verified: true })
  const token = await linkDevice(w, 'google', code, deviceName)
  const userId = (await env.DB.prepare('SELECT user_id FROM identities WHERE email = ?').bind(email).first<{ user_id: string }>())!.user_id
  return { token, userId, email }
}

/** A second device for the same user. */
async function secondDevice(w: World, email: string) {
  const code = `c-${uniq()}`
  w.google.set(code, { sub: `g2-${uniq()}`, email, email_verified: true })
  return linkDevice(w, 'google', code, 'second')
}

const acct = () => `${crypto.randomUUID()}.${crypto.randomUUID()}`

/** Bulk-inserts lists straight into D1 (faster than PUTs for volume tests). */
async function seed(userId: string, account: string, n: number, updatedAt: (i: number) => number, prefix = 'd:r') {
  const hash = await accountHash(env.ACCOUNT_HASH_KEY!, account)
  const stmt = env.DB.prepare('INSERT INTO lists (user_id, account_hash, key, kind, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  const all = Array.from({ length: n }, (_, i) => stmt.bind(userId, hash, `${prefix}${String(i).padStart(5, '0')}`, prefix[0], `[[${i}]]`, updatedAt(i)))
  for (let i = 0; i < all.length; i += 200) await env.DB.batch(all.slice(i, i + 200))
}

/** Pages through GET until more is false, returning every list seen and the number of requests. */
async function drain(w: World, token: string, account: string, since?: string) {
  const seen: Got['lists'] = []
  let cursor = since
  for (let i = 0; i < 100; i++) {
    const page = await getOk(w, token, account, cursor)
    seen.push(...page.lists)
    cursor = page.cursor
    if (!page.more) return { seen, cursor, requests: i + 1 }
  }
  throw new Error('pagination did not terminate')
}

describe('PUT/GET /v1/lists', () => {
  it('round trip: what one device PUTs another device of the same user GETs', async () => {
    const w = fakeWorld()
    const { token, email, userId } = await newUser(w)
    const other = await secondDevice(w, email)
    const account = acct()
    const lists = [
      // a device's day: [readings, watched spans, steps]
      {
        key: 'd:abc1-20231114',
        data: [[[1700000000000, 0, 42, 1700003600000]], [[1700000000000, 1700000060000]], [[1700000000000, 'opus', 'high', 123, 0]]],
      },
      { key: 'd:abc1-20231115', data: [[], [], []] },
    ]
    const res = await put(w, token, { account, lists })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stored: 2 })

    const got = await getOk(w, other, account)
    expect(got.more).toBe(false)
    expect(typeof got.cursor).toBe('string')
    expect(got.lists.map(({ key, data }) => ({ key, data })).sort((a, b) => a.key.localeCompare(b.key))).toEqual(
      [...lists].sort((a, b) => a.key.localeCompare(b.key)),
    )
    for (const l of got.lists) expect(l.updatedAt).toBe(w.deps.now())

    // stored under the account hash, with kind and writing device
    const row = await env.DB.prepare('SELECT account_hash, kind, device_id FROM lists WHERE user_id = ? AND key = ?')
      .bind(userId, 'd:abc1-20231114')
      .first<{ account_hash: string; kind: string; device_id: string }>()
    expect(row!.account_hash).toBe(await accountHash(env.ACCOUNT_HASH_KEY!, account))
    expect(row!.account_hash).not.toContain(account)
    expect(row!.kind).toBe('d')
    const dev = await env.DB.prepare('SELECT id FROM devices WHERE token_hash = ?').bind(await sha256Hex(token)).first<{ id: string }>()
    expect(row!.device_id).toBe(dev!.id)
  })

  it('upsert: a second PUT of the same key replaces it (last write wins); duplicates in one request keep the last', async () => {
    const w = fakeWorld()
    const { token } = await newUser(w)
    const account = acct()
    await put(w, token, { account, lists: [{ key: 'd:rs1', data: [[1]] }] })
    w.advance(1000)
    const res = await put(w, token, { account, lists: [{ key: 'd:rs1', data: [[2]] }, { key: 'd:rs1', data: [[3]] }] })
    expect(await res.json()).toEqual({ ok: true, stored: 1 })
    const got = await getOk(w, token, account)
    expect(got.lists).toEqual([{ key: 'd:rs1', data: [[3]], updatedAt: w.deps.now() }])
  })

  it('a GET with the cursor returns only lists changed since (plus the documented overlap window)', async () => {
    const w = fakeWorld()
    const { token } = await newUser(w)
    const account = acct()
    const keysOf = (g: Got) => g.lists.map((l) => l.key).sort()
    await put(w, token, { account, lists: [{ key: 'd:ra', data: [[1]] }, { key: 'd:rb', data: [[1]] }] })
    const first = await getOk(w, token, account)
    expect(keysOf(first)).toEqual(['d:ra', 'd:rb'])

    // written within CURSOR_OVERLAP_MS before that poll: the next poll repeats them (allowed duplicates)
    w.advance(5 * 60 * 1000)
    const second = await getOk(w, token, account, first.cursor)
    expect(keysOf(second)).toEqual(['d:ra', 'd:rb'])

    // after that, nothing new → nothing returned
    w.advance(5 * 60 * 1000)
    const quiet = await getOk(w, token, account, second.cursor)
    expect(quiet).toMatchObject({ lists: [], more: false })

    // a change is returned, and only it
    w.advance(5 * 60 * 1000)
    await put(w, token, { account, lists: [{ key: 'd:rb', data: [[2]] }, { key: 'd:wc', data: [] }] })
    w.advance(CURSOR_OVERLAP_MS + 1)
    const newer = await getOk(w, token, account, quiet.cursor)
    expect(newer.lists.map(({ key, data }) => ({ key, data })).sort((x, y) => x.key.localeCompare(y.key))).toEqual([
      { key: 'd:rb', data: [[2]] },
      { key: 'd:wc', data: [] },
    ])
    // written more than CURSOR_OVERLAP_MS before that poll: not repeated
    w.advance(5 * 60 * 1000)
    expect((await getOk(w, token, account, newer.cursor)).lists).toEqual([])
  })

  it('pagination over many lists with identical timestamps terminates and returns each list exactly once', async () => {
    const w = fakeWorld()
    const { token, userId } = await newUser(w)
    const account = acct()
    const t = w.deps.now() - 60_000
    // 1234 lists: 1000 sharing one timestamp, the rest spread out
    const n = 1234
    await seed(userId, account, n, (i) => (i < 1000 ? t : t + i))
    const { seen, requests } = await drain(w, token, account)
    expect(requests).toBeGreaterThanOrEqual(Math.ceil(n / PAGE_MAX_LISTS))
    expect(seen).toHaveLength(n)
    expect(new Set(seen.map((l) => l.key)).size).toBe(n)
    // in (updatedAt, key) order
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1]!
      const b = seen[i]!
      expect(a.updatedAt < b.updatedAt || (a.updatedAt === b.updatedAt && a.key < b.key)).toBe(true)
    }
  })

  it('pages are cut by size too, staying well under 1 MB', async () => {
    const w = fakeWorld()
    const { token } = await newUser(w)
    const account = acct()
    // 12 lists of ~100 KB each = ~1.2 MB in total
    const big = Array.from({ length: 8000 }, (_, i) => [i, 'xxxx'])
    expect(JSON.stringify(big).length).toBeGreaterThan(90 * 1024)
    for (let i = 0; i < 12; i++) {
      const res = await put(w, token, { account, lists: [{ key: `d:ubig${i}`, data: big }] })
      expect(res.status).toBe(200)
    }
    let cursor: string | undefined
    const keys: string[] = []
    let pages = 0
    for (;;) {
      const res = await get(w, token, account, cursor)
      const text = await res.text()
      expect(text.length).toBeLessThan(800 * 1024)
      const page = JSON.parse(text) as Got
      keys.push(...page.lists.map((l) => l.key))
      cursor = page.cursor
      pages++
      if (!page.more) break
    }
    expect(pages).toBeGreaterThanOrEqual(3)
    expect(keys.sort()).toEqual(Array.from({ length: 12 }, (_, i) => `d:ubig${i}`).sort())
  })

  it('a list written with an earlier timestamp that commits after the read is still picked up by the next poll', async () => {
    const w = fakeWorld()
    const { token, userId } = await newUser(w)
    const account = acct()
    await put(w, token, { account, lists: [{ key: 'd:ra', data: [[1]] }] })
    const first = await getOk(w, token, account)
    // simulate a concurrent PUT: its timestamp was taken 3 s before the read, its commit landed after it
    await env.DB.prepare('INSERT INTO lists (user_id, account_hash, key, kind, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userId, await accountHash(env.ACCOUNT_HASH_KEY!, account), 'd:rlate', 'r', '[[2]]', w.deps.now() - 3000)
      .run()
    w.advance(5 * 60 * 1000)
    const next = await getOk(w, token, account, first.cursor)
    expect(next.lists.map((l) => l.key)).toContain('d:rlate')
  })

  it('isolation: another user, or another Claude account of the same user, sees nothing', async () => {
    const w = fakeWorld()
    const a = await newUser(w)
    const b = await newUser(w)
    const account = acct()
    await put(w, a.token, { account, lists: [{ key: 'd:rx', data: [[1]] }] })
    expect((await getOk(w, b.token, account)).lists).toEqual([])
    expect((await getOk(w, a.token, acct())).lists).toEqual([])
    expect((await getOk(w, a.token, account)).lists).toHaveLength(1)
    // b writing the same account + key does not touch a's list
    await put(w, b.token, { account, lists: [{ key: 'd:rx', data: [[99]] }] })
    expect((await getOk(w, a.token, account)).lists[0]!.data).toEqual([[1]])
  })

  it('validation errors', async () => {
    const w = fakeWorld()
    const { token } = await newUser(w)
    const account = acct()
    const cases: Array<[unknown, number, string]> = [
      [{ lists: [] }, 400, 'missing_account'],
      [{ account: '', lists: [] }, 400, 'missing_account'],
      [{ account: '   ', lists: [] }, 400, 'missing_account'],
      [{ account: 'x'.repeat(201), lists: [] }, 400, 'invalid_account'],
      [{ account }, 400, 'invalid_lists'],
      [{ account, lists: {} }, 400, 'invalid_lists'],
      [{ account, lists: [{ key: 'x:1', data: [] }] }, 400, 'invalid_key'],
      [{ account, lists: [{ key: 'r:1', data: [] }] }, 400, 'invalid_key'],
      [{ account, lists: [{ key: 'd:', data: [] }] }, 400, 'invalid_key'],
      [{ account, lists: [{ key: 'd:ra/b', data: [] }] }, 400, 'invalid_key'],
      [{ account, lists: [{ key: `d:r${'a'.repeat(81)}`, data: [] }] }, 400, 'invalid_key'],
      [{ account, lists: [{ key: `${account}/r:1`, data: [] }] }, 400, 'invalid_key'],
      [{ account, lists: [null] }, 400, 'invalid_key'],
      [{ account, lists: [{ key: 'd:r1', data: { a: 1 } }] }, 400, 'invalid_data'],
      [{ account, lists: [{ key: 'd:r1', data: '[]' }] }, 400, 'invalid_data'],
      [{ account, lists: [{ key: 'd:r1' }] }, 400, 'invalid_data'],
      [{ account, lists: [{ key: 'd:r1', data: ['x'.repeat(130 * 1024)] }] }, 413, 'list_too_large'],
      [{ account, lists: Array.from({ length: 51 }, (_, i) => ({ key: `d:r${i}`, data: [] })) }, 413, 'too_many_lists'],
    ]
    for (const [body, status, error] of cases) {
      const res = await put(w, token, body)
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(status)
      expect((await res.json<{ error: string }>()).error).toBe(error)
    }
    // nothing was stored by any of them
    expect((await getOk(w, token, account)).lists).toEqual([])

    // body over 256 KB
    const huge = await put(w, token, { account, lists: [{ key: 'd:r1', data: ['x'.repeat(300 * 1024)] }] })
    expect(huge.status).toBe(413)

    // GET: account required, cursor must be one we issued
    expect((await get(w, token, null)).status).toBe(400)
    expect((await get(w, token, '')).status).toBe(400)
    const bad = await get(w, token, account, 'not-a-cursor')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid_cursor' })

    // exactly 50 lists, and a list just under 128 KB, are fine
    const ok = await put(w, token, { account, lists: Array.from({ length: 50 }, (_, i) => ({ key: `d:w${i}`, data: [[i]] })) })
    expect(await ok.json()).toEqual({ ok: true, stored: 50 })
    const edge = await put(w, token, { account, lists: [{ key: 'd:uedge', data: ['x'.repeat(127 * 1024)] }] })
    expect(edge.status).toBe(200)
  })

  it('caps stored lists per user + Claude account, but updating existing lists still works', async () => {
    const w = fakeWorld()
    const { token, userId } = await newUser(w)
    const account = acct()
    await seed(userId, account, MAX_STORED_LISTS - 1, () => w.deps.now())
    expect((await put(w, token, { account, lists: [{ key: 'd:rnew1', data: [] }] })).status).toBe(200)
    const full = await put(w, token, { account, lists: [{ key: 'd:rnew2', data: [] }] })
    expect(full.status).toBe(413)
    const body = await full.json<{ error: string; message: string }>()
    expect(body.error).toBe('list_quota_exceeded')
    expect(body.message).toContain(String(MAX_STORED_LISTS))
    // existing keys can still be updated
    expect((await put(w, token, { account, lists: [{ key: 'd:rnew1', data: [[1]] }, { key: 'd:r00001', data: [[1]] }] })).status).toBe(200)
    // another Claude account has its own quota
    expect((await put(w, token, { account: acct(), lists: [{ key: 'd:rnew2', data: [] }] })).status).toBe(200)
  })

  it('requires a valid device token', async () => {
    const w = fakeWorld()
    const account = acct()
    for (const res of [
      await call(w, `/v1/lists?account=${account}`),
      await get(w, 'garbage', account),
      await call(w, '/v1/lists', { method: 'PUT', body: JSON.stringify({ account, lists: [] }) }),
      await put(w, 'garbage', { account, lists: [] }),
    ]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    }
    expect((await call(w, '/v1/lists', { method: 'POST' })).status).toBe(405)
  })
})

describe('device expiry', () => {
  it('a device unused for 90 days is rejected with device_expired and deleted; a used one stays', async () => {
    const w = fakeWorld()
    const { token, email } = await newUser(w)
    const other = await secondDevice(w, email)
    const account = acct()
    w.advance(DEVICE_IDLE_MS - DAY)
    // `other` is used shortly before the deadline, which refreshes it
    expect((await get(w, other, account)).status).toBe(200)
    w.advance(2 * DAY)
    const res = await put(w, token, { account, lists: [] })
    expect(res.status).toBe(401)
    expect((await res.json<{ error: string }>()).error).toBe('device_expired')
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE token_hash = ?').bind(await sha256Hex(token)).first('n')).toBe(0)
    // afterwards it is simply unknown
    expect((await get(w, token, account)).status).toBe(401)
    expect((await get(w, other, account)).status).toBe(200)
  })

  it('throttles last_seen_at writes to once an hour', async () => {
    const w = fakeWorld()
    const { token } = await newUser(w)
    const hash = await sha256Hex(token)
    const seen = () => env.DB.prepare('SELECT last_seen_at AS t FROM devices WHERE token_hash = ?').bind(hash).first<number>('t')
    const linked = await seen()
    w.advance(30 * 60 * 1000)
    await get(w, token, acct())
    expect(await seen()).toBe(linked)
    w.advance(31 * 60 * 1000)
    await get(w, token, acct())
    expect(await seen()).toBe(w.deps.now())
  })
})

describe('daily housekeeping', () => {
  it('deletes lists older than 15 days and devices unused for 90 days, keeping fresh ones', async () => {
    const w = fakeWorld()
    const { token, userId, email } = await newUser(w)
    const stale = await secondDevice(w, email)
    const now = w.deps.now()
    const account = acct()
    await seed(userId, account, 3, () => now - LIST_KEEP_MS - 1000, 'd:rold')
    await seed(userId, account, 2, () => now - LIST_KEEP_MS + 60_000, 'd:wnew')
    await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE token_hash = ?').bind(now - DEVICE_IDLE_MS - 1000, await sha256Hex(stale)).run()

    const done = await housekeeping(env, now)
    expect(done.lists).toBeGreaterThanOrEqual(3)
    expect(done.devices).toBeGreaterThanOrEqual(1)

    const keys = (await getOk(w, token, account)).lists.map((l) => l.key).sort()
    expect(keys).toEqual(['d:wnew00000', 'd:wnew00001'])
    expect((await get(w, stale, account)).status).toBe(401)
    expect((await authed(w, '/v1/me', token)).status).toBe(200)
  })

  it('purges in bounded batches', async () => {
    const { purgeOldLists } = await import('../src/lists')
    const w = fakeWorld()
    const { userId } = await newUser(w)
    const now = w.deps.now()
    await seed(userId, acct(), 25, () => now - LIST_KEEP_MS - 1)
    // 2 batches of 10 → 20 deleted this run, the rest on the next
    expect(await purgeOldLists(env.DB, now, 10, 2)).toBe(20)
    expect(await purgeOldLists(env.DB, now, 10, 2)).toBeGreaterThanOrEqual(5)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM lists WHERE user_id = ?').bind(userId).first('n')).toBe(0)
  })
})

describe('account deletion and rate limiting', () => {
  it('DELETE /v1/me removes the user’s synced lists', async () => {
    const w = fakeWorld()
    const { token, userId } = await newUser(w)
    await put(w, token, { account: acct(), lists: [{ key: 'd:r1', data: [[1]] }, { key: 'd:u1', data: [] }] })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM lists WHERE user_id = ?').bind(userId).first('n')).toBe(2)
    expect((await authed(w, '/v1/me', token, 'DELETE')).status).toBe(200)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM lists WHERE user_id = ?').bind(userId).first('n')).toBe(0)
  })

  it('rate-limits the lists endpoints per device (60 per minute)', async () => {
    const w = fakeWorld()
    const a = await newUser(w)
    const b = await newUser(w)
    const account = acct()
    let ok = 0
    let limited: Response | null = null
    // the limiter uses fixed real-time windows: if a window boundary passes mid-loop, up to ~120 may pass
    for (let i = 0; i < 130 && !limited; i++) {
      const res = i % 2 ? await get(w, a.token, account) : await put(w, a.token, { account, lists: [] })
      if (res.status === 429) limited = res
      else {
        expect(res.status).toBe(200)
        ok++
      }
    }
    expect(limited).not.toBeNull()
    expect(ok).toBeGreaterThanOrEqual(60)
    expect(await limited!.json()).toMatchObject({ error: 'rate_limited' })
    expect(limited!.headers.get('retry-after')).toBe('60')
    // another device is unaffected
    expect((await get(w, b.token, account)).status).toBe(200)
  })
})
