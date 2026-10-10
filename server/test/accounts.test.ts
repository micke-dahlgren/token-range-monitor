import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { accountHash, signValue, verifyValue } from '../src/crypto'
import { resolveUser } from '../src/db'
import type { OAuthState } from '../src/oauth'
import { authed, beginSignIn, call, fakeWorld, linkDevice, poll, signIn, start, uniq } from './helpers'

const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n

describe('account linking by verified email', () => {
  it('Google then GitHub with the same verified email is one user', async () => {
    const w = fakeWorld()
    const email = `link-${uniq()}@example.com`
    w.google.set('g', { sub: `g-${uniq()}`, email, email_verified: true })
    w.github.set('h', { id: Math.floor(Math.random() * 1e9), emails: [{ email: email.toUpperCase(), primary: true, verified: true }] })

    const t1 = await linkDevice(w, 'google', 'g', 'desktop')
    const t2 = await linkDevice(w, 'github', 'h', 'laptop')

    const me = await (await authed(w, '/v1/me', t2)).json<{ email: string; providers: string[]; devices: unknown[] }>()
    expect(me.email).toBe(email)
    expect(me.providers).toEqual(['github', 'google'])
    expect(me.devices).toHaveLength(2)
    const me1 = await (await authed(w, '/v1/me', t1)).json<{ providers: string[] }>()
    expect(me1.providers).toEqual(['github', 'google'])
  })

  it('an unverified Google email is refused: no user, code stays pending', async () => {
    const w = fakeWorld()
    const email = `unv-${uniq()}@example.com`
    w.google.set('g', { sub: `g-${uniq()}`, email, email_verified: false })
    const s = await start(w)
    const cb = await signIn(w, 'google', s.code, 'g')
    expect(cb.status).toBe(400)
    expect(await cb.text()).toContain('not verified')
    expect(await count('SELECT COUNT(*) AS n FROM identities WHERE email = ?', email)).toBe(0)
    expect(await poll(w, s.pollToken)).toEqual({ status: 'pending' })
  })

  it('a GitHub account whose primary email is unverified does not take over the matching user', async () => {
    const w = fakeWorld()
    const email = `victim-${uniq()}@example.com`
    w.google.set('g', { sub: `g-${uniq()}`, email, email_verified: true })
    const ghId = Math.floor(Math.random() * 1e9)
    w.github.set('h', { id: ghId, emails: [{ email, primary: true, verified: false }] })
    const t = await linkDevice(w, 'google', 'g')

    const s = await start(w)
    const cb = await signIn(w, 'github', s.code, 'h')
    expect(cb.status).toBe(400)
    expect(await poll(w, s.pollToken)).toEqual({ status: 'pending' })
    expect(await count("SELECT COUNT(*) AS n FROM identities WHERE provider = 'github' AND provider_user_id = ?", String(ghId))).toBe(0)
    expect((await (await authed(w, '/v1/me', t)).json<{ providers: string[] }>()).providers).toEqual(['google'])
  })

  it('resolveUser never links on an unverified email (either side)', async () => {
    const email = `rs-${uniq()}@example.com`
    const now = Date.now()
    const a = await resolveUser(env.DB, { provider: 'google', providerUserId: `g-${uniq()}`, email, emailVerified: true }, now)
    const b = await resolveUser(env.DB, { provider: 'github', providerUserId: uniq(), email, emailVerified: false }, now)
    expect(b.userId).not.toBe(a.userId)
    expect(b.created).toBe(true)
    // an unverified identity is not a link target for a later verified one either
    const email2 = `rs2-${uniq()}@example.com`
    const c = await resolveUser(env.DB, { provider: 'github', providerUserId: uniq(), email: email2, emailVerified: false }, now)
    const d = await resolveUser(env.DB, { provider: 'google', providerUserId: `g-${uniq()}`, email: email2, emailVerified: true }, now)
    expect(d.userId).not.toBe(c.userId)
    // a verified one links
    const e = await resolveUser(env.DB, { provider: 'github', providerUserId: uniq(), email: email.toUpperCase(), emailVerified: true }, now)
    expect(e).toEqual({ userId: a.userId, linked: true, created: false })
  })
})

describe('state cookie', () => {
  async function setup() {
    const w = fakeWorld()
    w.google.set('g', { sub: `g-${uniq()}`, email: `st-${uniq()}@example.com`, email_verified: true })
    const s = await start(w)
    const b = await beginSignIn(w, 'google', s.code)
    const cb = (cookie: string | null, state = b.state, provider = 'google') =>
      call(w, `/auth/${provider}/callback?code=g&state=${encodeURIComponent(state)}`, cookie ? { headers: { cookie: `trm_oauth=${cookie}` } } : {})
    return { w, s, b, cb }
  }

  it('the untouched cookie verifies (control)', async () => {
    const { w, s, cb, b } = await setup()
    expect(await verifyValue<OAuthState>(env.SESSION_KEY!, b.cookie)).toMatchObject({ c: s.code.replace('-', ''), p: 'google' })
    expect((await cb(b.cookie)).status).toBe(200)
    expect((await poll(w, s.pollToken)).status).toBe('ok')
  })

  it('rejects a tampered payload, a forged signature, a missing cookie, a wrong state and a wrong provider', async () => {
    const { w, s, b, cb } = await setup()
    const [body, sig] = b.cookie.split('.')
    const decoded = JSON.parse(atob(body!.replace(/-/g, '+').replace(/_/g, '/'))) as OAuthState
    const other = await start(w)
    const swapped = btoa(JSON.stringify({ ...decoded, c: other.code.replace('-', '') })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const forged = await signValue('not-the-session-key', decoded)

    for (const res of [
      await cb(`${swapped}.${sig}`),
      await cb(forged),
      await cb(`${body}.`),
      await cb(b.cookie + 'x'),
      await cb(null),
      await cb(b.cookie, 'wrong-state'),
      await cb(b.cookie, b.state, 'github'),
    ]) {
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('invalid or has expired')
    }
    expect(await poll(w, s.pollToken)).toEqual({ status: 'pending' })
    expect(await poll(w, other.pollToken)).toEqual({ status: 'pending' })
  })

  it('rejects an expired state cookie', async () => {
    const { w, s, b, cb } = await setup()
    void s
    w.advance(10 * 60 * 1000 + 1)
    expect((await cb(b.cookie)).status).toBe(400)
  })

  it('shows a cancelled page when the user declines at the provider', async () => {
    const { w, b } = await setup()
    const res = await call(w, `/auth/google/callback?error=access_denied&state=${b.state}`, { headers: { cookie: `trm_oauth=${b.cookie}` } })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('cancelled')
  })

  it('a provider token-exchange failure is a friendly 502', async () => {
    const { b, w } = await setup()
    const res = await call(w, `/auth/google/callback?code=unknown-code&state=${b.state}`, { headers: { cookie: `trm_oauth=${b.cookie}` } })
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('try again')
  })
})

describe('device API', () => {
  it('/v1/me requires a valid bearer token and updates last_seen_at', async () => {
    const w = fakeWorld()
    w.google.set('g', { sub: `g-${uniq()}`, email: `me-${uniq()}@example.com`, email_verified: true })
    const t = await linkDevice(w, 'google', 'g', 'box')
    expect((await call(w, '/v1/me')).status).toBe(401)
    expect((await authed(w, '/v1/me', 'garbage')).status).toBe(401)
    w.advance(5000)
    const res = await authed(w, '/v1/me', t)
    expect(res.status).toBe(200)
    const me = await res.json<{ devices: Array<{ id: string; name: string; lastSeenAt: number; current: boolean }> }>()
    expect(me.devices).toEqual([{ id: expect.any(String), name: 'box', lastSeenAt: w.deps.now(), current: true }])
  })

  it('DELETE /v1/device revokes only the calling device', async () => {
    const w = fakeWorld()
    const sub = `g-${uniq()}`
    const email = `dd-${uniq()}@example.com`
    w.google.set('a', { sub, email, email_verified: true })
    w.google.set('b', { sub, email, email_verified: true })
    const t1 = await linkDevice(w, 'google', 'a', 'one')
    const t2 = await linkDevice(w, 'google', 'b', 'two')
    const del = await authed(w, '/v1/device', t1, 'DELETE')
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })
    expect((await authed(w, '/v1/me', t1)).status).toBe(401)
    const me = await (await authed(w, '/v1/me', t2)).json<{ devices: Array<{ name: string }> }>()
    expect(me.devices.map((d) => d.name)).toEqual(['two'])
  })

  it('DELETE /v1/me removes the user, identities, devices and lists', async () => {
    const w = fakeWorld()
    const email = `del-${uniq()}@example.com`
    w.google.set('g', { sub: `g-${uniq()}`, email, email_verified: true })
    w.github.set('h', { id: Math.floor(Math.random() * 1e9), emails: [{ email, primary: true, verified: true }] })
    const t1 = await linkDevice(w, 'google', 'g')
    const t2 = await linkDevice(w, 'github', 'h')
    const userId = (await env.DB.prepare('SELECT user_id FROM identities WHERE email = ? LIMIT 1').bind(email).first<{ user_id: string }>())!.user_id
    await env.DB.prepare("INSERT INTO lists (user_id, account_hash, key, kind, data, updated_at) VALUES (?, 'acct', 'r:1', 'r', '[]', 1)").bind(userId).run()

    expect((await authed(w, '/v1/me', t1, 'DELETE')).status).toBe(200)
    for (const table of ['identities', 'devices', 'lists', 'link_codes']) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, userId)).toBe(0)
    }
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE id = ?', userId)).toBe(0)
    expect((await authed(w, '/v1/me', t2)).status).toBe(401)

    // signing in again starts a fresh user
    w.google.set('g2', { sub: `g-${uniq()}`, email, email_verified: true })
    const t3 = await linkDevice(w, 'google', 'g2')
    expect((await (await authed(w, '/v1/me', t3)).json<{ devices: unknown[] }>()).devices).toHaveLength(1)
  })
})

describe('routing and pages', () => {
  it('unknown routes are 404 JSON (through the real worker entry too)', async () => {
    const w = fakeWorld()
    for (const res of [await call(w, '/nope'), await call(w, '/v1/lists'), await SELF.fetch('http://localhost:8787/nope')]) {
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(await res.json()).toEqual({ error: 'not_found' })
    }
  })

  it('wrong methods are 405', async () => {
    const w = fakeWorld()
    const res = await call(w, '/v1/link/start')
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('serves the landing and privacy pages', async () => {
    const landing = await SELF.fetch('http://localhost:8787/')
    expect(landing.status).toBe(200)
    expect(await landing.text()).toContain('https://github.com/micke-dahlgren/token-range-monitor')
    const privacy = await SELF.fetch('http://localhost:8787/privacy')
    expect(privacy.status).toBe(200)
    const text = await privacy.text()
    for (const word of ['email', 'Retention', 'delete']) expect(text).toContain(word)
  })

  it('hashes Claude account ids with ACCOUNT_HASH_KEY (Phase 2 helper)', async () => {
    const a = await accountHash(env.ACCOUNT_HASH_KEY!, 'acct-uuid.org-uuid')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await accountHash('other-key', 'acct-uuid.org-uuid')).not.toBe(a)
  })
})
