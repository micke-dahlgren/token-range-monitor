import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/crypto'
import { BAD_CODE_TEXT, CODE_ATTEMPT_LIMIT, purgeExpiredCodes, START_LIMIT } from '../src/link'
import { handle } from '../src/index'
import { authed, beginSignIn, call, fakeWorld, freshIp, openLinkPage, poll, postJson, signIn, start, submitCode, uniq } from './helpers'

describe('device link flow', () => {
  it('start → pending → Google sign-in → ok → second poll expired', async () => {
    const w = fakeWorld()
    const email = `ada-${uniq()}@example.com`
    w.google.set('auth-1', { sub: `g-${uniq()}`, email, email_verified: true })

    const s = await start(w, 'Ada’s laptop')
    expect(s.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
    // the code is never in the URL: the user types it
    expect(s.url).toBe('http://localhost:8787/link')
    expect(s.pollToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(s.expiresIn).toBe(600)
    expect(s.interval).toBeGreaterThan(0)

    // only hashes are stored
    const row = await env.DB.prepare('SELECT * FROM link_codes WHERE code = ?').bind(s.code.replace('-', '')).first<Record<string, unknown>>()
    expect(row!.poll_token_hash).toBe(await sha256Hex(s.pollToken))
    expect(JSON.stringify(row)).not.toContain(s.pollToken)

    expect(await poll(w, s.pollToken)).toEqual({ status: 'pending' })

    const page = await call(w, '/link')
    expect(page.status).toBe(200)
    const body = await page.text()
    expect(body).not.toContain(s.code)
    expect(body).toContain('Enter the code shown in Claude Code')
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

    // the code cannot be signed in for again either (claimed)
    const again = await openLinkPage(w)
    const res = await submitCode(w, { code: s.code, provider: 'google', csrf: again.csrf }, again.cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('isn&#39;t valid or has expired')
  })

  it('sends the provider a PKCE challenge, the scopes and a redirect URI built from PUBLIC_URL', async () => {
    const w = fakeWorld()
    const s = await start(w)
    for (const [provider, host, scope] of [
      ['google', 'accounts.google.com', 'openid email profile'],
      ['github', 'github.com', 'read:user user:email'],
    ] as const) {
      const { res } = await beginSignIn(w, provider, s.code)
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

  it('expired codes: poll, code entry and a late callback all refuse', async () => {
    const w = fakeWorld()
    w.google.set('late', { sub: `g-${uniq()}`, email: `late-${uniq()}@example.com`, email_verified: true })
    const s = await start(w)
    // sign-in begins in time, but the provider round trip ends after expiry
    const { state, cookie } = await beginSignIn(w, 'google', s.code)
    w.advance(11 * 60 * 1000)

    expect(await poll(w, s.pollToken)).toEqual({ status: 'expired' })
    const page = await openLinkPage(w)
    const res = await submitCode(w, { code: s.code, provider: 'google', csrf: page.csrf }, page.cookie)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toContain('isn&#39;t valid or has expired')
    const cb = await call(w, `/auth/google/callback?code=late&state=${state}`, { headers: { cookie: `trm_oauth=${cookie}` } })
    expect(cb.status).toBe(400)
    expect(await poll(w, s.pollToken)).toEqual({ status: 'expired' })
  })

  it('GET /link always shows the empty form and ignores ?code=', async () => {
    const w = fakeWorld()
    const s = await start(w)
    for (const q of ['', '?code=', `?code=${s.code}`, `?code=${s.code.replace('-', '').toLowerCase()}`, '?code=<script>']) {
      const res = await call(w, `/link${q}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const body = await res.text()
      expect(body).not.toContain(s.code)
      expect(body).not.toContain(s.code.replace('-', ''))
      expect(body).not.toContain(s.code.replace('-', '').toLowerCase())
      expect(body).not.toContain('<script')
      expect(body).toMatch(/<input class="code"[^>]* value="">/)
      for (const attr of ['autocomplete="one-time-code"', 'autocapitalize="characters"', 'inputmode="text"', 'autofocus', 'method="post"', 'action="/link"']) {
        expect(body).toContain(attr)
      }
      expect(body).toContain('Only continue if you started this from your own Claude Code')
      expect(body).toContain('href="/privacy"')
    }
  })

  it('the link page CSP lets the form post to self and redirect to the providers; other pages forbid forms', async () => {
    const w = fakeWorld()
    const csp = (await call(w, '/link')).headers.get('content-security-policy')!
    expect(csp).toContain("form-action 'self' https://accounts.google.com https://github.com")
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('script-src')
    expect((await call(w, '/privacy')).headers.get('content-security-policy')).toContain("form-action 'none'")
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

describe('sign-in form (typed code + CSRF)', () => {
  const noStateCookie = (res: Response) => expect(res.headers.get('set-cookie') ?? '').not.toContain('trm_oauth=')

  it('a plain link can no longer start OAuth: /auth/{google,github}/start are 404', async () => {
    const w = fakeWorld()
    const s = await start(w)
    for (const p of ['google', 'github']) {
      const res = await call(w, `/auth/${p}/start?code=${s.code}`)
      expect(res.status).toBe(404)
      noStateCookie(res)
    }
    expect(await poll(w, s.pollToken)).toEqual({ status: 'pending' })
  })

  it('POST /link without the CSRF cookie, with a mismatched or missing field, or a foreign cookie → 403, no state cookie', async () => {
    const w = fakeWorld()
    const s = await start(w)
    const a = await openLinkPage(w)
    const b = await openLinkPage(w)
    expect(a.cookie).not.toBe(b.cookie)
    const fields = { code: s.code, provider: 'google' }
    for (const res of [
      await submitCode(w, { ...fields, csrf: a.csrf }, null), // cross-site POST: SameSite=Strict cookie not sent
      await submitCode(w, { ...fields, csrf: 'forged' }, a.cookie),
      await submitCode(w, { ...fields, csrf: '' }, a.cookie),
      await submitCode(w, { ...fields, csrf: b.csrf }, a.cookie), // another session's field
      await submitCode(w, { ...fields, csrf: a.cookie.split('=')[1]! }, a.cookie), // the raw cookie value is not the field
      await submitCode(w, { ...fields, csrf: a.csrf }, 'trm_csrf=short'),
    ]) {
      expect(res.status).toBe(403)
      expect(res.headers.get('location')).toBeNull()
      noStateCookie(res)
      expect(await res.text()).toContain('This sign-in page expired, please reload')
    }
    expect(await poll(w, s.pollToken)).toEqual({ status: 'pending' })
    // the matching pair works
    expect((await submitCode(w, { ...fields, csrf: a.csrf }, a.cookie)).status).toBe(302)
  })

  it('wrong, malformed, expired, claimed and already signed-in codes re-render the form with one error and no redirect', async () => {
    const w = fakeWorld()
    w.google.set('si', { sub: `g-${uniq()}`, email: `si-${uniq()}@example.com`, email_verified: true })
    const claimed = await start(w)
    await signIn(w, 'google', claimed.code, 'si')
    expect((await poll(w, claimed.pollToken)).status).toBe('ok')
    const signedIn = await start(w)
    w.google.set('si2', { sub: `g-${uniq()}`, email: `si2-${uniq()}@example.com`, email_verified: true })
    await signIn(w, 'google', signedIn.code, 'si2') // signed in, not yet polled
    const expired = await start(w)
    await env.DB.prepare('UPDATE link_codes SET expires_at = ? WHERE code = ?').bind(w.deps.now() - 1, expired.code.replace('-', '')).run()

    const page = await openLinkPage(w)
    for (const code of ['ABCD-EFGH', '', 'nope', '<b>x</b>', expired.code, claimed.code, signedIn.code]) {
      for (const provider of ['google', 'github']) {
        const res = await submitCode(w, { code, provider, csrf: page.csrf }, page.cookie)
        expect(res.status).toBe(400)
        expect(res.headers.get('location')).toBeNull()
        noStateCookie(res)
        const body = await res.text()
        expect(body).toContain(BAD_CODE_TEXT.replace("'", '&#39;'))
        expect(body).not.toContain('<b>x</b>')
        // the form is still usable: same CSRF field
        expect(body).toContain(`name="csrf" value="${page.csrf}"`)
      }
    }
  })

  it('an unknown provider re-renders the form', async () => {
    const w = fakeWorld()
    const s = await start(w)
    const page = await openLinkPage(w)
    const res = await submitCode(w, { code: s.code, provider: 'facebook', csrf: page.csrf }, page.cookie)
    expect(res.status).toBe(400)
    noStateCookie(res)
  })

  it('accepts the code lower-case, without the dash, or with spaces', async () => {
    const w = fakeWorld()
    for (const variant of [(c: string) => c.toLowerCase(), (c: string) => c.replace('-', ''), (c: string) => ` ${c.slice(0, 2)} ${c.slice(2, 4)} ${c.slice(5).toLowerCase()} `]) {
      for (const provider of ['google', 'github'] as const) {
        const s = await start(w)
        const { location, cookie } = await beginSignIn(w, provider, variant(s.code))
        expect(location.host).toBe(provider === 'google' ? 'accounts.google.com' : 'github.com')
        expect(cookie).toBeTruthy()
      }
    }
  })

  it('valid code + GitHub: redirect with state cookie, then callback → poll ok', async () => {
    const w = fakeWorld()
    const email = `gh-${uniq()}@example.com`
    w.github.set('gh-e2e', { id: Math.floor(Math.random() * 1e9), emails: [{ email, primary: true, verified: true }] })
    const s = await start(w)
    const res = await signIn(w, 'github', s.code, 'gh-e2e')
    expect(res.status).toBe(200)
    expect(await poll(w, s.pollToken)).toMatchObject({ status: 'ok', email })
  })

  it('rate-limits code entry per IP (CODE_LIMITER) with 429, before looking the code up', async () => {
    const w = fakeWorld()
    const s = await start(w)
    const page = await openLinkPage(w)
    const ip = freshIp()
    let limited: Response | null = null
    let attempts = 0
    // the limiter uses fixed real-time windows: if a boundary passes mid-loop, up to 2× the limit may pass
    for (let i = 0; i < 3 * CODE_ATTEMPT_LIMIT + 2 && !limited; i++) {
      const res = await submitCode(w, { code: 'ZZZZ-ZZZZ', provider: 'google', csrf: page.csrf }, page.cookie, ip)
      attempts++
      if (res.status === 429) limited = res
      else expect(res.status).toBe(400)
    }
    expect(limited).not.toBeNull()
    expect(attempts).toBeGreaterThan(CODE_ATTEMPT_LIMIT)
    expect(limited!.headers.get('retry-after')).toBe('60')
    expect(await limited!.text()).toContain('Too many attempts, wait a minute.')
    // even the right code is refused from that IP now; another IP is unaffected
    const blocked = await submitCode(w, { code: s.code, provider: 'google', csrf: page.csrf }, page.cookie, ip)
    expect(blocked.status).toBe(429)
    noStateCookie(blocked)
    expect((await submitCode(w, { code: s.code, provider: 'google', csrf: page.csrf }, page.cookie, freshIp())).status).toBe(302)
  })

  it('CSRF cookie: dev (http) is trm_csrf without Secure; https is __Host- with Secure; both HttpOnly, SameSite=Strict, Path=/, 15 min', async () => {
    const w = fakeWorld()
    const dev = await openLinkPage(w)
    expect(dev.setCookie).toMatch(/^trm_csrf=[A-Za-z0-9_-]{43}; /)
    for (const attr of ['Path=/;', 'HttpOnly', 'SameSite=Strict', 'Max-Age=900']) expect(dev.setCookie).toContain(attr)
    expect(dev.setCookie).not.toContain('Secure')
    expect(dev.setCookie).not.toContain('Domain')

    const prodEnv = { ...env, PUBLIC_URL: 'https://trm.example.workers.dev' }
    const res = await handle(new Request('https://trm.example.workers.dev/link'), prodEnv, w.deps)
    const sc = res.headers.get('set-cookie')!
    expect(sc).toMatch(/^__Host-trm_csrf=[A-Za-z0-9_-]{43}; /)
    for (const attr of ['Path=/;', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=900']) expect(sc).toContain(attr)
    expect(sc).not.toContain('Domain')
    // the prod flow works with the prefixed cookie, and ignores an unprefixed one
    const s = await start(w)
    const csrf = /name="csrf" value="([^"]+)"/.exec(await res.text())![1]!
    const token = /^__Host-trm_csrf=([^;]+)/.exec(sc)![1]!
    const post = (cookie: string) =>
      handle(
        new Request('https://trm.example.workers.dev/link', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, 'cf-connecting-ip': freshIp() },
          body: new URLSearchParams({ code: s.code, provider: 'google', csrf }).toString(),
        }),
        prodEnv,
        w.deps,
      )
    expect((await post(`trm_csrf=${token}`)).status).toBe(403)
    expect((await post(`__Host-trm_csrf=${token}`)).status).toBe(302)
  })

  it('reloading the page keeps an existing CSRF token, so several tabs stay valid', async () => {
    const w = fakeWorld()
    const first = await openLinkPage(w)
    const again = await call(w, '/link', { headers: { cookie: first.cookie } })
    expect(again.headers.get('set-cookie')!.startsWith(`${first.cookie};`)).toBe(true)
    expect(await again.text()).toContain(`name="csrf" value="${first.csrf}"`)
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
