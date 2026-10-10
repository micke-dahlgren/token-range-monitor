/** Phase 2: the /v1/lists sync API, its rate limit and list retention. */
import { authed } from './auth'
import { accountHash, base64url, fromBase64url } from './crypto'
import type { DeviceRow } from './db'
import type { Deps, Env } from './env'
import { HttpError, json, readJson } from './http'

const DAY_MS = 24 * 60 * 60 * 1000

/** Lists not updated for this long are deleted by the daily cron: the mod learns from the last 14 days, plus a day of slack. */
export const LIST_KEEP_MS = 15 * DAY_MS
export const MAX_ACCOUNT_CHARS = 200
/**
 * One list per device per day, `d:<device>-<day>`, its data the mod's
 * `[readings, watched spans, steps]` for that day: a day's list stops changing
 * once the day is over, and an active device writes one row per sync.
 */
export const KEY_RE = /^d:[A-Za-z0-9._-]{1,80}$/
/** Serialized size of one list's `data`. */
export const MAX_LIST_BYTES = 128 * 1024
export const MAX_LISTS_PER_REQUEST = 50
/** Stored lists per (user, Claude account): a day's list per device, so ~16 per device. */
export const MAX_STORED_LISTS = 500
/** A GET page holds at most this many lists... */
export const PAGE_MAX_LISTS = 500
/** ...and stops adding lists once their data reaches this many bytes (one list is always included). */
export const PAGE_MAX_BYTES = 512 * 1024
const PAGE_CHUNK = 100
/**
 * The final page's cursor reaches back this far before the sync sequence
 * started, so a write whose timestamp was taken before a read but committed
 * after it (or a worker with a slightly late clock) is still picked up next
 * time. Lists in that window are returned again: duplicates are harmless.
 */
export const CURSOR_OVERLAP_MS = 10_000

const enc = new TextEncoder()

/** Rate limit for the lists endpoints, keyed by device (Workers Rate Limiting binding; no D1 writes). */
async function rateLimit(env: Env, device: DeviceRow): Promise<void> {
  if (!env.LISTS_LIMITER) return
  const { success } = await env.LISTS_LIMITER.limit({ key: device.id })
  if (!success) throw new HttpError(429, 'rate_limited', 'Too many sync requests from this device; try again in a minute.', { 'retry-after': '60' })
}

function account(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'missing_account')
  if (value.length > MAX_ACCOUNT_CHARS) throw new HttpError(400, 'invalid_account', `account must be at most ${MAX_ACCOUNT_CHARS} characters`)
  return value
}

function hashKey(env: Env): string {
  if (!env.ACCOUNT_HASH_KEY) throw new HttpError(503, 'not_configured')
  return env.ACCOUNT_HASH_KEY
}

/** PUT /v1/lists `{ account, lists: [{ key, data }] }` → `{ ok: true, stored }` */
export async function putLists(req: Request, env: Env, deps: Deps): Promise<Response> {
  const device = await authed(req, env, deps)
  await rateLimit(env, device)
  const body = await readJson(req)
  const acct = account(body.account)
  if (!Array.isArray(body.lists)) throw new HttpError(400, 'invalid_lists', 'lists must be an array')
  if (body.lists.length > MAX_LISTS_PER_REQUEST) {
    throw new HttpError(413, 'too_many_lists', `at most ${MAX_LISTS_PER_REQUEST} lists per request`)
  }

  // validated, serialized, and de-duplicated by key (the last one wins)
  const incoming = new Map<string, { kind: string; data: string }>()
  for (const item of body.lists as unknown[]) {
    const { key, data } = (item ?? {}) as { key?: unknown; data?: unknown }
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new HttpError(400, 'invalid_key', 'key must match ^d:[A-Za-z0-9._-]{1,80}$')
    if (!Array.isArray(data)) throw new HttpError(400, 'invalid_data', `data for ${key} must be a JSON array`)
    const text = JSON.stringify(data)
    if (enc.encode(text).byteLength > MAX_LIST_BYTES) throw new HttpError(413, 'list_too_large', `${key} is larger than ${MAX_LIST_BYTES / 1024} KB`)
    incoming.set(key, { kind: key[0]!, data: text })
  }
  if (incoming.size === 0) return json({ ok: true, stored: 0 })

  const db = env.DB
  const userId = device.user_id
  const hash = await accountHash(hashKey(env), acct)
  const keys = [...incoming.keys()]

  // the quota is only checked when a PUT brings keys not stored yet (in practice: a session's first sync)
  const existing = await db
    .prepare(`SELECT key FROM lists WHERE user_id = ? AND account_hash = ? AND key IN (${keys.map(() => '?').join(',')})`)
    .bind(userId, hash, ...keys)
    .all<{ key: string }>()
  const added = keys.length - existing.results.length
  if (added > 0) {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM lists WHERE user_id = ? AND account_hash = ?').bind(userId, hash).first<{ n: number }>()
    if ((row?.n ?? 0) + added > MAX_STORED_LISTS) {
      throw new HttpError(
        413,
        'list_quota_exceeded',
        `This Claude account already has ${row?.n ?? 0} synced lists; at most ${MAX_STORED_LISTS} are kept. Lists not updated for 15 days are removed daily.`,
      )
    }
  }

  const now = deps.now()
  const upsert = db.prepare(
    `INSERT INTO lists (user_id, account_hash, key, kind, data, updated_at, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, account_hash, key) DO UPDATE SET kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at, device_id = excluded.device_id`,
  )
  await db.batch([...incoming].map(([key, l]) => upsert.bind(userId, hash, key, l.kind, l.data, now, device.id)))
  return json({ ok: true, stored: incoming.size })
}

/** Position in the (updated_at, key) order, plus when this sync sequence started. Opaque to clients. */
interface Cursor {
  t: number
  k: string
  s: number
}

const encodeCursor = (c: Cursor) => base64url(enc.encode(JSON.stringify([c.t, c.k, c.s])))

function decodeCursor(raw: string): Cursor {
  try {
    const v = JSON.parse(new TextDecoder().decode(fromBase64url(raw))) as unknown
    if (Array.isArray(v) && v.length === 3 && Number.isSafeInteger(v[0]) && typeof v[1] === 'string' && Number.isSafeInteger(v[2])) {
      return { t: v[0] as number, k: v[1] as string, s: v[2] as number }
    }
  } catch {
    /* fall through */
  }
  throw new HttpError(400, 'invalid_cursor')
}

/**
 * GET /v1/lists?account=...&since=<cursor> → `{ lists: [{ key, data, updatedAt }], cursor, more }`
 *
 * Lists come in (updatedAt, key) order. While `more` is true, call again
 * straight away with the returned cursor: those page boundaries are exact, so
 * a sequence of pages returns every list once. The cursor after the last page
 * (`more: false`) reaches back CURSOR_OVERLAP_MS before the sequence started,
 * so the next poll may repeat lists updated in that window.
 */
export async function getLists(req: Request, env: Env, deps: Deps): Promise<Response> {
  const device = await authed(req, env, deps)
  await rateLimit(env, device)
  const params = new URL(req.url).searchParams
  const acct = account(params.get('account'))
  const since = params.get('since')
  const now = deps.now()
  const from: Cursor = since ? decodeCursor(since) : { t: -1, k: '', s: 0 }
  // s = 0: this request starts a new sync sequence (no cursor, or the cursor of a final page)
  if (from.s === 0) from.s = now
  const hash = await accountHash(hashKey(env), acct)

  const stmt = env.DB.prepare(
    `SELECT key, data, updated_at FROM lists
     WHERE user_id = ?1 AND account_hash = ?2 AND (updated_at > ?3 OR (updated_at = ?3 AND key > ?4))
     ORDER BY updated_at, key LIMIT ?5`,
  )
  const parts: string[] = []
  let bytes = 0
  let at = { t: from.t, k: from.k }
  let more = false
  page: for (;;) {
    const { results } = await stmt.bind(device.user_id, hash, at.t, at.k, PAGE_CHUNK).all<{ key: string; data: string; updated_at: number }>()
    for (const row of results) {
      const size = enc.encode(row.data).byteLength
      if (parts.length >= PAGE_MAX_LISTS || (parts.length > 0 && bytes + size > PAGE_MAX_BYTES)) {
        more = true
        break page
      }
      // data is stored as JSON text written by JSON.stringify: embed it as is
      parts.push(`{"key":${JSON.stringify(row.key)},"data":${row.data},"updatedAt":${row.updated_at}}`)
      bytes += size
      at = { t: row.updated_at, k: row.key }
    }
    if (results.length < PAGE_CHUNK) break
  }

  // more: resume exactly after the last list returned, same sequence.
  // done: reach back CURSOR_OVERLAP_MS before the sequence started (it may move the cursor back: duplicates, never gaps)
  const next: Cursor = more ? { ...at, s: from.s } : { t: Math.max(-1, Math.min(from.s, now) - CURSOR_OVERLAP_MS), k: '', s: 0 }
  const body = `{"lists":[${parts.join(',')}],"cursor":${JSON.stringify(encodeCursor(next))},"more":${more}}`
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/**
 * Deletes lists not updated for LIST_KEEP_MS, in bounded batches so the cron
 * stays within its CPU and D1 limits. It walks the table in rowid order
 * (there is deliberately no updated_at index: see migration 0002), so a run
 * reads each row about once. Whatever exceeds `batch * maxBatches` is left
 * for the next day. Returns how many were deleted.
 */
export async function purgeOldLists(db: D1Database, now: number, batch = 1000, maxBatches = 50): Promise<number> {
  const stmt = db.prepare(
    'DELETE FROM lists WHERE rowid IN (SELECT rowid FROM lists WHERE rowid > ? AND updated_at < ? ORDER BY rowid LIMIT ?) RETURNING rowid AS id',
  )
  let total = 0
  let after = 0
  for (let i = 0; i < maxBatches; i++) {
    const { results } = await stmt.bind(after, now - LIST_KEEP_MS, batch).all<{ id: number }>()
    total += results.length
    if (results.length < batch) break
    for (const r of results) after = Math.max(after, r.id)
  }
  return total
}
