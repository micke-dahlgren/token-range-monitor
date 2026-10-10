/** Device-link flow: the mod starts a code, the user signs in in a browser, the mod polls for its token. */
import { formatCode, hmacHex, normalizeCode, randomCode, randomToken, sha256Hex } from './crypto'
import { createDevice, userEmail } from './db'
import type { Deps, Env } from './env'
import { publicUrl } from './env'
import { HttpError, html, json, readJson } from './http'
import { linkPage, messagePage } from './pages'
import { providerEnabled } from './oauth'

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

const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || null : null)

export async function startLink(req: Request, env: Env, deps: Deps): Promise<Response> {
  const body = await readJson(req)
  const now = deps.now()
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
  // keyed so raw IPs are never stored; falls back to a plain hash if SESSION_KEY is unset (dev)
  const ipHash = env.SESSION_KEY ? await hmacHex(env.SESSION_KEY, `ip:${ip}`) : await sha256Hex(`ip:${ip}`)
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
        url: `${publicUrl(env)}/link?code=${display}`,
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

export async function linkPageHandler(req: Request, env: Env, deps: Deps): Promise<Response> {
  const code = normalizeCode(new URL(req.url).searchParams.get('code'))
  if (!code || !(await openCode(env, code, deps.now()))) return html(messagePage('Link expired', INVALID_CODE_TEXT), 400)
  return html(linkPage(formatCode(code), { google: providerEnabled(env, 'google'), github: providerEnabled(env, 'github') }))
}

export async function purgeExpiredCodes(env: Env, now: number): Promise<number> {
  const res = await env.DB.prepare('DELETE FROM link_codes WHERE expires_at < ?').bind(now - CODE_KEEP_MS).run()
  return res.meta.changes
}
