import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/crypto'
import { purgeExpiredCodes, START_LIMIT } from '../src/link'
import { authed, call, fakeWorld, freshIp, poll, postJson, signIn, start, uniq } from './helpers'

describe('device link flow', () => {
  it('start → pending → Google sign-in → ok → second poll expired', async () => {
    const w = fakeWorld()
    const email = `ada-${uniq()}@example.com`
    w.google.set('auth-1', { sub: `g-${uniq()}`, email, email_verified: true })

    const s = await start(w, 'Ada’s laptop')
    expect(s.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
    expect(s.url).toBe(`http://localhost:8787/link?code=${s.code}`)
    expect(s.pollToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(s.expiresIn).toBe(600)
    expect(s.interval).toBeGreaterThan(0)

    // only hashes are stored
    const row = await env.DB.prepare('SELECT * FROM link_codes WHERE code = ?').bind(s.code.replace('-', '')).first<Record<string, unknown>>()
    expect(row!.poll_token_hash).toBe(await sha256Hex(s.pollToken))
    expect(JSON.stringify(row)).not.toContain(s.pollToken)

    expect(await poll(w, s.pollToken)).toEqual({ status: 'pending' })

    const page = await call(w, `/link?code=${s.code.toLowerCase()}`)
    expect(page.status).toBe(200)
    const body = await page.text()
    expect(body).toContain(s.code)
    expect(body).toContain('Continue with Google')
    expect(body).toContain('Continue with GitHub')
    expect(body).not.toMatch(/<script/i)

    const cb = await signIn(w, 'google', s.code, 'auth-1')
    expect(cb.status).toBe(200)
    expect(await cb.text()).toContain(`Device linked as <strong>${email}</strong>`)
    expect(cb.headers.get('set-cookie')).toMatch(/trm_oauth=;.*Max-Age=0/)

    const ok = await poll(w, s.pollToken)
    expect(ok.status).toBe('ok')
    expect(ok.email).toBe(email)
    expect(ok.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const dev = await env.DB.prepare('SELECT * FROM devices WHERE token_hash = ?').bind(await sha256Hex(ok.deviceToken!)).first<{ name: string }>()
    expect(dev!.name).toBe('Ada’s laptop')

    expect(await poll(w, s.pollToken)).toEqual({ status: 'expired' })

    // the code cannot be signed in for again either
    expect((await call(w, `/link?code=${s.code}`)).status).toBe(400)
    expect((await call(w, `/auth/google/start?code=${s.code}`)).status).toBe(400)
  })

  it('sends the provider a PKCE challenge, the scopes and a redirect URI built from PUBLIC_URL', async () => {
    const w = fakeWorld()
    const s = await start(w)
    for (const [provider, host, scope] of [
      ['google', 'accounts.google.com', 'openid email profile'],
      ['github', 'github.com', 'read:user user:email'],
    ] as const) {
      const res = await call(w, `/auth/${provider}/start?code=${s.code}`)
      expect(res.status).toBe(302)
      const loc = new URL(res.headers.get('location')!)
      expect(loc.host).toBe(host)
      expect(loc.searchParams.get('redirect_uri')).toBe(`http://localhost:8787/auth/${provider}/callback`)
      expect(loc.searchParams.get('scope')).toBe(scope)
      expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
      expect(loc.searchParams.get('state')).toBeTruthy()
      const cookie = res.headers.get('set-cookie')!
      for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/auth/']) expect(cookie).toContain(attr)
    }
  })

  it('GitHub sign-in uses the primary verified email and sends a User-Agent', async () => {
    const w = fakeWorld()
    const email = `octo-${uniq()}@example.com`
    w.github.set('gh-1', {
      id: Math.floor(Math.random() * 1e9),
      emails: [
        { email: `other-${uniq()}@example.com`, primary: false, verified: true },
        { email: email.toUpperCase(), primary: true, verified: true },
      ],
    })
    const s = await start(w)
    const cb = await signIn(w, 'github', s.code, 'gh-1')
    expect(cb.status).toBe(200)
    const ok = await poll(w, s.pollToken)
    expect(ok).toMatchObject({ status: 'ok', email })
    for (const c of w.calls.filter((c) => c.url.startsWith('https://api.github.com/'))) {
      expect(new Headers(c.init?.headers).get('user-agent')).toBeTruthy()
    }
  })

  it('expired codes: poll, link page, sign-in start and a late callback all refuse', async () => {
    const w = fakeWorld()
    w.google.set('late', { sub: `g-${uniq()}`, email: `late-${uniq()}@example.com`, email_verified: true })
    const s = await start(w)
    // sign-in begins in time, but the provider round trip ends after expiry
    const res = await call(w, `/auth/google/start?code=${s.code}`)
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!
    const cookie = /^trm_oauth=([^;]+)/.exec(res.headers.get('set-cookie')!)![1]!
    w.advance(11 * 60 * 1000)

    expect(await poll(w, s.pollToken)).toEqual({ status: 'expired' })
    expect((await call(w, `/link?code=${s.code}`)).status).toBe(400)
    expect(await (await call(w, `/link?code=${s.code}`)).text()).toContain('expired')
    expect((await call(w, `/auth/google/start?code=${s.code}`)).status).toBe(400)
    const cb = await call(w, `/auth/google/callback?code=late&state=${state}`, { headers: { cookie: `trm_oauth=${cookie}` } })
    expect(cb.status).toBe(400)
    expect(await poll(w, s.pollToken)).toEqual({ status: 'expired' })
  })

  it('unknown and malformed codes get the friendly page', async () => {
    const w = fakeWorld()
    for (const q of ['', '?code=', '?code=ABCD-EFGH', '?code=<script>']) {
      const res = await call(w, `/link${q}`)
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('Start linking again')
    }
  })

  it('unknown poll tokens are expired; a missing one is a 400', async () => {
    const w = fakeWorld()
    expect(await poll(w, 'nope')).toEqual({ status: 'expired' })
    expect((await postJson(w, '/v1/link/poll', {})).status).toBe(400)
    expect((await call(w, '/v1/link/poll', { method: 'POST', body: '{nope' })).status).toBe(400)
  })

  it('rate-limits /v1/link/start per IP', async () => {
    const w = fakeWorld()
    const ip = freshIp()
    for (let i = 0; i < START_LIMIT; i++) await start(w, 'x', ip)
    const res = await postJson(w, '/v1/link/start', {}, { 'cf-connecting-ip': ip })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate_limited' })
    // another IP is unaffected, and the window passes
    await start(w, 'x', freshIp())
    w.advance(11 * 60 * 1000)
    await start(w, 'x', ip)
  })

  it('caps request bodies at 256 KB', async () => {
    const w = fakeWorld()
    const big = JSON.stringify({ deviceName: 'x'.repeat(300 * 1024) })
    const res = await call(w, '/v1/link/start', { method: 'POST', body: big, headers: { 'cf-connecting-ip': freshIp() } })
    expect(res.status).toBe(413)
  })

  it('the cron purge drops long-expired codes only', async () => {
    const w = fakeWorld()
    const fresh = await start(w)
    const old = await start(w)
    await env.DB.prepare('UPDATE link_codes SET expires_at = ? WHERE code = ?').bind(Date.now() - 2 * 3600_000, old.code.replace('-', '')).run()
    expect(await purgeExpiredCodes(env, Date.now())).toBeGreaterThanOrEqual(1)
    expect(await poll(w, old.pollToken)).toEqual({ status: 'expired' })
    expect(await poll(w, fresh.pollToken)).toEqual({ status: 'pending' })
  })
})

describe('re-linking', () => {
  it('signing in again with the same identity reuses the user and adds a device', async () => {
    const w = fakeWorld()
    const sub = `g-${uniq()}`
    const email = `re-${uniq()}@example.com`
    w.google.set('a', { sub, email, email_verified: true })
    w.google.set('b', { sub, email, email_verified: true })
    const s1 = await start(w, 'one')
    await signIn(w, 'google', s1.code, 'a')
    const t1 = (await poll(w, s1.pollToken)).deviceToken!
    const s2 = await start(w, 'two')
    await signIn(w, 'google', s2.code, 'b')
    const t2 = (await poll(w, s2.pollToken)).deviceToken!
    const me = await (await authed(w, '/v1/me', t2)).json<{ devices: Array<{ name: string; current: boolean }> }>()
    expect(me.devices.map((d) => [d.name, d.current])).toEqual([
      ['one', false],
      ['two', true],
    ])
    expect(t1).not.toBe(t2)
  })
})
