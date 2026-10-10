/**
 * Device-link flow: the mod starts a code, the user opens /link in a browser,
 * TYPES the code shown in Claude Code and signs in, the mod polls for its token.
 *
 * The code is never put in a URL: anything in a URL (or in a form another site
 * submits) is attacker-controlled, and would let someone link their own device
 * to a victim's account by sending them a link. OAuth only starts from POST
 * /link, which needs a SameSite=Strict CSRF cookie plus the matching hidden
 * field, passes a per-IP rate limit, and needs a typed code that is still open.
 */
import { constantTimeEqual, formatCode, hmacHex, normalizeCode, randomCode, randomToken, sha256Hex } from './crypto'
import { createDevice, userEmail } from './db'
import type { Deps, Env } from './env'
import { publicUrl } from './env'
import { getCookie, HttpError, html, json, readForm, readJson } from './http'
import { AUTHORIZE_ORIGINS, beginAuth, isProvider, notConfigured, providerEnabled } from './oauth'
import { linkPage, messagePage } from './pages'

export const CODE_TTL_MS = 10 * 60 * 1000
export const POLL_INTERVAL_S = 3
/** Link codes a single IP may start per window. */
export const START_LIMIT = 10
export const START_WINDOW_MS = 10 * 60 * 1000
/** Expired codes are kept this long (so a late poll still says "expired"), then the cron deletes them. */
export const CODE_KEEP_MS = 60 * 60 * 1000

export interface LinkCodeRow {
  code: string
  user_id: string | null
  device_name: string | null
  created_at: number
  expires_at: number
  claimed: number
}

/** Lifetime of the sign-in page's CSRF cookie. */
export const CSRF_TTL_S = 15 * 60
/** Code-entry attempts per IP per minute (keep in sync with CODE_LIMITER in wrangler.toml). */
export const CODE_ATTEMPT_LIMIT = 10

export const BAD_CODE_TEXT = "That code isn't valid or has expired. Check Claude Code for the current code."
export const TOO_MANY_TEXT = 'Too many attempts, wait a minute.'
export const PAGE_EXPIRED_TEXT = 'This sign-in page expired, please reload it and enter the code again.'

/** Keyed hash of the client IP (raw IPs are never stored); a plain hash when SESSION_KEY is unset (dev). */
function ipHashOf(req: Request, env: Env): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
  return env.SESSION_KEY ? hmacHex(env.SESSION_KEY, `ip:${ip}`) : sha256Hex(`ip:${ip}`)
}

const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || null : null)

export async function startLink(req: Request, env: Env, deps: Deps): Promise<Response> {
  const body = await readJson(req)
  const now = deps.now()
  const ipHash = await ipHashOf(req, env)
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM link_codes WHERE ip_hash = ? AND created_at > ?')
    .bind(ipHash, now - START_WINDOW_MS)
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= START_LIMIT) throw new HttpError(429, 'rate_limited')

  const pollToken = randomToken()
  const pollHash = await sha256Hex(pollToken)
  const name = cleanName(body.deviceName)
  // 40-bit codes: a collision is practically impossible, but retry rather than fail
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode()
    const res = await env.DB.prepare(
      'INSERT OR IGNORE INTO link_codes (code, poll_token_hash, device_name, created_at, expires_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(code, pollHash, name, now, now + CODE_TTL_MS, ipHash)
      .run()
    if (res.meta.changes === 1) {
      const display = formatCode(code)
      return json({
        code: display,
        // never the code in the URL: the user types it on the page
        url: `${publicUrl(env)}/link`,
        pollToken,
        expiresIn: CODE_TTL_MS / 1000,
        interval: POLL_INTERVAL_S,
      })
    }
  }
  throw new HttpError(503, 'try_again')
}

export async function pollLink(req: Request, env: Env, deps: Deps): Promise<Response> {
  const body = await readJson(req)
  if (typeof body.pollToken !== 'string' || !body.pollToken) throw new HttpError(400, 'missing_poll_token')
  const now = deps.now()
  const row = await env.DB.prepare('SELECT code, user_id, device_name, created_at, expires_at, claimed FROM link_codes WHERE poll_token_hash = ?')
    .bind(await sha256Hex(body.pollToken))
    .first<LinkCodeRow>()
  if (!row || row.claimed || now >= row.expires_at + CODE_KEEP_MS) return json({ status: 'expired' })
  if (!row.user_id) return json({ status: now >= row.expires_at ? 'expired' : 'pending' })

  // signed in (before expiry, which the callback enforces): hand out a device token, once
  const claim = await env.DB.prepare('UPDATE link_codes SET claimed = 1 WHERE code = ? AND claimed = 0').bind(row.code).run()
  if (claim.meta.changes !== 1) return json({ status: 'expired' })
  const device = await createDevice(env.DB, row.user_id, row.device_name, now)
  return json({ status: 'ok', deviceToken: device.token, email: await userEmail(env.DB, row.user_id) })
}

/** A link code a browser may still sign in for: exists, unexpired, unclaimed, not yet signed in. */
export async function openCode(env: Env, code: string, now: number): Promise<LinkCodeRow | null> {
  const row = await env.DB.prepare('SELECT code, user_id, device_name, created_at, expires_at, claimed FROM link_codes WHERE code = ?')
    .bind(code)
    .first<LinkCodeRow>()
  return row && !row.claimed && !row.user_id && now < row.expires_at ? row : null
}

/** Attaches the signed-in user to the code; false when it expired or was used meanwhile. */
export async function completeCode(env: Env, code: string, userId: string, now: number): Promise<boolean> {
  const res = await env.DB.prepare('UPDATE link_codes SET user_id = ? WHERE code = ? AND claimed = 0 AND user_id IS NULL AND expires_at > ?')
    .bind(userId, code, now)
    .run()
  return res.meta.changes === 1
}

export const INVALID_CODE_TEXT = 'This link code is invalid, expired or already used. Start linking again from Claude Code to get a new one.'

// ---- sign-in page ---------------------------------------------------------

/**
 * The CSRF cookie. Over https it is `__Host-trm_csrf` (Secure, Path=/, no
 * Domain: only this exact origin can set or read it). Over plain http (local
 * dev on http://localhost) browsers may refuse Secure / `__Host-` cookies, so
 * there it is `trm_csrf` without Secure.
 */
export function csrfCookie(env: Env): { name: string; attrs: string } {
  return publicUrl(env).startsWith('https://')
    ? { name: '__Host-trm_csrf', attrs: `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CSRF_TTL_S}` }
    : { name: 'trm_csrf', attrs: `Path=/; HttpOnly; SameSite=Strict; Max-Age=${CSRF_TTL_S}` }
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/** The hidden form field for a CSRF cookie value: an HMAC of it with SESSION_KEY. */
const csrfField = (env: Env, token: string) => (env.SESSION_KEY ? hmacHex(env.SESSION_KEY, `csrf:${token}`) : sha256Hex(`csrf:${token}`))

/** The CSRF cookie value, if the request carries a well-formed one. */
function csrfFromCookie(req: Request, env: Env): string | null {
  const v = getCookie(req, csrfCookie(env).name)
  return v && TOKEN_RE.test(v) ? v : null
}

/**
 * The link page's CSP: like every page, but the form may post to self. Browsers
 * also apply `form-action` to the redirect that follows the POST, so the
 * providers' authorize origins must be allowed too.
 */
export const linkPageCsp = () => `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self' ${AUTHORIZE_ORIGINS.join(' ')}; frame-ancestors 'none'`

/** The code-entry form for CSRF cookie value `token`; (re)sets the cookie, refreshing its lifetime. */
async function formPage(env: Env, token: string, status = 200, opts: { error?: string; code?: string; headers?: [string, string][] } = {}): Promise<Response> {
  const { name, attrs } = csrfCookie(env)
  const body = linkPage({
    csrf: await csrfField(env, token),
    enabled: { google: providerEnabled(env, 'google'), github: providerEnabled(env, 'github') },
    error: opts.error,
    code: opts.code,
  })
  return html(body, status, [['content-security-policy', linkPageCsp()], ['set-cookie', `${name}=${token}; ${attrs}`], ...(opts.headers ?? [])])
}

/** GET /link: the code-entry form. A `?code=` query is ignored, never prefilled. */
export async function linkPageHandler(req: Request, env: Env): Promise<Response> {
  // reuse a valid existing token so several open tabs all keep working
  return formPage(env, csrfFromCookie(req, env) ?? randomToken())
}

/** POST /link (code, provider, csrf): CSRF check, rate limit, code lookup, then OAuth for that code. */
export async function linkSubmitHandler(req: Request, env: Env, deps: Deps): Promise<Response> {
  const form = await readForm(req)
  const token = csrfFromCookie(req, env)
  if (!token || !constantTimeEqual(form.get('csrf') ?? '', await csrfField(env, token))) {
    return html(messagePage('Page expired', PAGE_EXPIRED_TEXT), 403)
  }
  // shown again in the form on errors: it was typed into this same-site form, never taken from a URL
  const typed = (form.get('code') ?? '').slice(0, 32)

  if (env.CODE_LIMITER) {
    const { success } = await env.CODE_LIMITER.limit({ key: `code:${await ipHashOf(req, env)}` })
    if (!success) return formPage(env, token, 429, { error: TOO_MANY_TEXT, code: typed, headers: [['retry-after', '60']] })
  }

  const provider = form.get('provider')
  if (!isProvider(provider)) return formPage(env, token, 400, { error: 'Choose Google or GitHub to continue.', code: typed })
  if (!providerEnabled(env, provider)) return notConfigured(provider === 'google' ? 'Google' : 'GitHub')

  const code = normalizeCode(typed)
  // one answer for malformed, unknown, expired, claimed and already signed-in codes
  if (!code || !(await openCode(env, code, deps.now()))) return formPage(env, token, 400, { error: BAD_CODE_TEXT, code: typed })
  return beginAuth(provider, code, env, deps)
}

export async function purgeExpiredCodes(env: Env, now: number): Promise<number> {
  const res = await env.DB.prepare('DELETE FROM link_codes WHERE expires_at < ?').bind(now - CODE_KEEP_MS).run()
  return res.meta.changes
}
