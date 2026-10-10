import type { HttpInit, HttpResponse } from 'claude-code'

import type { RangeReading, RangeStep, RangeSync, RangeWatch } from '../types'
import { DAY, HOUR, KEEP, MIN } from './range'

/**
 * Sync across devices: each device uploads what this computer recorded for the
 * signed-in Claude account, one list per UTC day (`d:<device>-<YYYYMMDD>`,
 * `[readings, watched spans, steps]`), and downloads the other devices' lists,
 * which are read beside the local ones. Off until the person signs in.
 *
 * Every session on this computer uploads the union of all the lists recorded
 * here (its own, the other sessions', the other copies' stores), never what it
 * downloaded: sessions share the device's day keys, so each upload is the whole
 * day and none overwrites another's part of it.
 */

export const DEFAULT_SERVER = 'https://token-range-monitor.micke-dahlgren.workers.dev'
/** How often a signed-in session syncs. */
export const SYNC_EVERY = 10 * MIN
/** The first retry after a failure; each further failure doubles it, up to BACKOFF_MAX. */
export const BACKOFF_BASE = 2 * MIN
export const BACKOFF_MAX = HOUR
/** How long a sign-in code is waited for at most. */
export const LINK_TTL = 10 * MIN
/** How long "Delete synced data" waits for its confirming press. */
export const CONFIRM_FOR = 10_000

/** The server's limits, with some room left. */
export const MAX_LIST_BYTES = 128 * 1024 - 1024
export const MAX_LISTS_PER_PUT = 50
export const MAX_BODY_BYTES = 256 * 1024 - 8 * 1024

/** Store keys: none matches the record's `[<account>/](r|w|u):` keys, so the record's cleanup never touches them. */
export const DEVICE_KEY = 'sync:device'
export const AUTH_KEY = 'sync:auth'
export const LINK_KEY = 'sync:link'
/** Per Claude account: the download cursor, the fingerprint of each day list last uploaded, when it last synced. */
export const acctKey = (account: string) => `sync:acct:${account}`
/** A downloaded list, kept so a restart shows it offline. */
export const cacheKey = (account: string, key: string) => `sync:dl:${account}:${key}`
const CACHE_PREFIX = 'sync:dl:'

/** One day's list: `[readings, watched spans, steps]`. */
export type DayData = [RangeReading[], RangeWatch[], RangeStep[]]
/** Lists as the record holds them: reading lists, watched spans, step lists. */
export type Lists = { readings: Array<readonly RangeReading[]>; spans: RangeWatch[]; steps: Array<readonly RangeStep[]> }
export type Outgoing = { key: string; data: DayData; fp: string }

// ---------------------------------------------------------------- pure parts

const pad = (n: number) => String(n).padStart(2, '0')
/** The UTC day `t` falls in, as `YYYYMMDD`. */
export function dayOf(t: number): string {
  const d = new Date(t)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
}
/** When a `YYYYMMDD` UTC day starts, in ms. */
export const dayStart = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)))

/** A day list's key; a day too big for one list goes on in parts `.1`, `.2`, ... */
export const listKey = (device: string, day: string, part = 0) => `d:${device}-${day}${part ? `.${part}` : ''}`
export function parseListKey(key: string): { device: string; day: string; part: number } | null {
  const m = /^d:([A-Za-z0-9._-]+)-(\d{8})(?:\.(\d+))?$/.exec(key)
  return m ? { device: m[1]!, day: m[2]!, part: Number(m[3] ?? 0) } : null
}

/** A short random id for this device: letters and digits, safe in a key and a URL. */
export function newDeviceId(now: number, random: () => number = Math.random): string {
  let s = now.toString(36)
  while (s.length < 16) s += Math.floor(random() * 36).toString(36)
  return s
}
export const isDeviceId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9]{6,40}$/.test(v)

/**
 * A watched span split at each UTC midnight it crosses, so every day's list
 * holds only that day and stops changing once the day is over:
 * `[23:50, 00:10]` becomes `[23:50, 23:59:59.999]` and `[00:00, 00:10]`.
 */
export function splitSpan([a, b]: readonly [number, number]): RangeWatch[] {
  if (!(b >= a)) return []
  const out: RangeWatch[] = []
  let s = a
  for (let end = dayStart(dayOf(s)) + DAY; end <= b; end += DAY) {
    out.push([s, end - 1])
    s = end
  }
  out.push([s, b])
  return out
}

/** Overlapping spans joined: several sessions watching at once is one stretch watched. */
export function joinSpans(spans: readonly RangeWatch[]): RangeWatch[] {
  const out: RangeWatch[] = []
  for (const [a, b] of [...spans].filter(w => w[1] >= w[0]).sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/**
 * The record's lists packed into one list per UTC day, repeats dropped:
 * readings and steps by their time, watched spans split at midnight. Only the
 * days wholly inside KEEP, so a day's list never shrinks as its start ages out.
 */
export function packDays(lists: Lists, now: number): Map<string, DayData> {
  const days = new Map<string, DayData>()
  const from = now - KEEP
  const dayFor = (t: number): DayData | null => {
    const day = dayOf(t)
    if (dayStart(day) < from || t > now + HOUR) return null
    let d = days.get(day)
    if (!d) days.set(day, (d = [[], [], []]))
    return d
  }
  const seenR = new Set<string>()
  for (const list of lists.readings) {
    for (const r of list) {
      const id = `${r[0]}:${r[1]}:${r[2]}`
      if (seenR.has(id)) continue
      seenR.add(id)
      dayFor(r[0])?.[0].push(r)
    }
  }
  for (const span of joinSpans(lists.spans)) for (const piece of splitSpan(span)) dayFor(piece[0])?.[1].push(piece)
  const seenS = new Set<string>()
  for (const list of lists.steps) {
    for (const s of list) {
      const id = `${s[0]}:${s[1]}:${s[3]}`
      if (seenS.has(id)) continue
      seenS.add(id)
      dayFor(s[0])?.[2].push(s)
    }
  }
  for (const [, d] of days) {
    d[0].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    d[1].sort((a, b) => a[0] - b[0])
    d[2].sort((a, b) => a[0] - b[0])
  }
  return new Map([...days].sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** The UTF-8 length of a string, as the server counts it. */
export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++ }
    else n += 3
  }
  return n
}
const sizeOf = (v: unknown) => utf8Bytes(JSON.stringify(v))

/**
 * The days as the lists this device uploads. A day bigger than one list allows
 * (a very busy day of responses) carries its steps on in parts `.1`, `.2`, ...
 */
export function packLists(device: string, days: ReadonlyMap<string, DayData>, max = MAX_LIST_BYTES): Array<{ key: string; data: DayData }> {
  const out: Array<{ key: string; data: DayData }> = []
  for (const [day, data] of days) {
    if (sizeOf(data) <= max) { out.push({ key: listKey(device, day), data }); continue }
    let part: DayData = [data[0], data[1], []]
    let size = sizeOf(part)
    let n = 0
    for (const s of data[2]) {
      const add = sizeOf(s) + 1
      if (size + add > max && part[2].length > 0) {
        out.push({ key: listKey(device, day, n++), data: part })
        part = [[], [], []]
        size = sizeOf(part)
      }
      part[2].push(s)
      size += add
    }
    out.push({ key: listKey(device, day, n), data: part })
  }
  return out
}

/** A short fingerprint of a list's content: FNV-1a over its JSON, and its length. */
export function fingerprint(data: unknown): string {
  const s = JSON.stringify(data)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return `${(h >>> 0).toString(36)}.${s.length.toString(36)}`
}

/** The lists whose content changed since they were last uploaded. */
export function changedLists(lists: ReadonlyArray<{ key: string; data: DayData }>, sent: Readonly<Record<string, string>>): Outgoing[] {
  return lists.map(l => ({ ...l, fp: fingerprint(l.data) })).filter(l => sent[l.key] !== l.fp)
}

/** Lists grouped into requests the server takes: at most 50 lists and 256 KB each. */
export function batches<L extends { key: string; data: unknown }>(lists: readonly L[], maxLists = MAX_LISTS_PER_PUT, maxBytes = MAX_BODY_BYTES): L[][] {
  const out: L[][] = []
  let cur: L[] = []
  let size = 0
  for (const l of lists) {
    const add = sizeOf({ key: l.key, data: l.data }) + 1
    if (cur.length && (cur.length >= maxLists || size + add > maxBytes)) { out.push(cur); cur = []; size = 0 }
    cur.push(l)
    size += add
  }
  if (cur.length) out.push(cur)
  return out
}

/** When to try again after `failures` failures in a row: doubling from BACKOFF_BASE up to BACKOFF_MAX, never sooner than the server asked. */
export function backoffMs(failures: number, retryAfterMs = 0): number {
  return Math.max(retryAfterMs, Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** Math.max(0, failures - 1)))
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** A downloaded list's data, its items checked one by one (another device may run another version); null when it is no day list. */
export function unpack(data: unknown): DayData | null {
  if (!Array.isArray(data) || data.length < 3 || !data.slice(0, 3).every(Array.isArray)) return null
  const [r, w, s] = data as unknown[][]
  return [
    r!.filter((x): x is RangeReading => Array.isArray(x) && isNum(x[0]) && (x[1] === 0 || x[1] === 1) && isNum(x[2]) && isNum(x[3])),
    w!.filter((x): x is RangeWatch => Array.isArray(x) && isNum(x[0]) && isNum(x[1])),
    s!.filter((x): x is RangeStep => Array.isArray(x) && isNum(x[0]) && typeof x[1] === 'string' && typeof x[2] === 'string' && isNum(x[3]) && (x[4] === 0 || x[4] === 1)),
  ]
}

/** Downloaded day lists as the record's lists. */
export function unpacked(lists: Iterable<DayData>): Lists {
  const out: Lists = { readings: [], spans: [], steps: [] }
  for (const [r, w, s] of lists) {
    out.readings.push(r)
    out.spans.push(...w)
    out.steps.push(s)
  }
  return out
}

/** "just now", "3 min ago", "2 h ago", "4 days ago". */
export function agoText(t: number | undefined, now: number): string {
  if (t === undefined) return 'not synced yet'
  const d = Math.max(0, now - t)
  if (d < MIN) return 'just now'
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`
  const n = Math.floor(d / DAY)
  return `${n} day${n === 1 ? '' : 's'} ago`
}

/** The server's base URL from the plugin's option: an http(s) URL, no trailing slash; the default otherwise. */
export function serverFrom(option: unknown): string {
  const s = typeof option === 'string' ? option.trim().replace(/\/+$/, '') : ''
  return /^https?:\/\/[^\s/]+/.test(s) ? s : DEFAULT_SERVER
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / MIN))} min`

// ---------------------------------------------------------------- the network

export class SyncError extends Error {
  constructor(
    /** `auth`: drop the token; `retry`: back off and try again; `cursor`: start over; `rejected`: the server refused what was sent. */
    readonly kind: 'auth' | 'retry' | 'cursor' | 'rejected',
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly retryAfterMs = 0,
  ) {
    super(code)
  }
}

type Json = Record<string, unknown>
async function call(io: SyncIO, method: string, path: string, body?: unknown, token?: string): Promise<Json> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  let res
  try {
    res = await io.fetch(`${state.server}${path}`, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) })
  } catch {
    throw new SyncError('retry', 0, 'network')
  }
  let json: Json = {}
  try {
    const v = JSON.parse(res.text) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) json = v as Json
  } catch { /* not JSON */ }
  if (res.ok) return json
  const code = typeof json.error === 'string' ? json.error : `http_${res.status}`
  const detail = typeof json.message === 'string' ? json.message : undefined
  const retryAfter = Number(res.headers['retry-after'] ?? 0) * 1000 || 0
  const kind = res.status === 401 ? 'auth'
    : res.status === 400 && code === 'invalid_cursor' ? 'cursor'
    : res.status === 429 || res.status >= 500 ? 'retry'
    : 'rejected'
  throw new SyncError(kind, res.status, code, detail, retryAfter)
}

// ---------------------------------------------------------------- state

type Auth = { token: string; email: string; server: string }
type Link = { pollToken: string; code: string; url: string; interval: number; expiresAt: number; server: string }
type AcctState = { cursor?: string; sent: Record<string, string>; last?: number }

/**
 * What sync reaches outside itself, handed in by the hooks module (which alone
 * calls the engine): the clock, the network, the store, the environment, the
 * pane's view, and the record itself.
 */
export type SyncIO = {
  now: () => Promise<number>
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  del: (key: string) => Promise<void>
  keys: () => Promise<string[]>
  /** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, as set. */
  trafficOff: () => Promise<string | undefined>
  /** The computer's name, for the server's list of devices. */
  hostName: () => Promise<string | undefined>
  every: (ms: number, fn: () => void) => { cancel: () => void }
  after: (ms: number, fn: () => void) => { cancel: () => void }
  log: (text: string, options?: { to: 'debug' }) => void
  view: () => Promise<RangeSync>
  setView: (change: (v: RangeSync) => RangeSync) => Promise<void>
  /** The Claude account the record is under now (`<accountUuid>.<orgUuid>`, `none`, or '' before it's known). */
  account: () => string
  /** Every list recorded on this computer for the current account (never the downloaded ones). */
  collect: () => Promise<Lists>
  /** Re-reads the record (downloaded lists included) and redraws. */
  reload: () => Promise<void>
  /** A device id another copy of the plugin on this computer already chose, if any. */
  peekDevice: () => Promise<string | undefined>
}

const state = {
  server: DEFAULT_SERVER,
  /** The session's own reach, from its start: timers begun from a press run on it, not on the press's. */
  home: null as SyncIO | null,
  started: false,
  disabled: false,
  device: '',
  auth: null as Auth | null,
  failures: 0,
  nextAt: 0,
  uploadPausedUntil: 0,
  uploadNote: undefined as string | undefined,
  rejectLogged: false,
  running: false,
  poll: null as { cancel: () => void } | null,
  polling: false,
  confirm: null as { cancel: () => void } | null,
  /** Downloaded lists per account, by list key. */
  far: new Map<string, Map<string, DayData>>(),
}

/** Called as the module loads: a fresh load starts from nothing (its timers went with the old one). */
export function configureSync(server: unknown) {
  Object.assign(state, {
    home: null, started: false, disabled: false, device: '', auth: null, failures: 0, nextAt: 0, uploadPausedUntil: 0,
    uploadNote: undefined, rejectLogged: false, running: false, poll: null, polling: false, confirm: null, far: new Map(),
  })
  state.server = serverFrom(server)
}

const usable = (account: string) => !!account && account !== 'none'
const isAuth = (v: unknown): v is Auth => !!v && typeof (v as Auth).token === 'string' && !!(v as Auth).token && typeof (v as Auth).server === 'string'
const isLink = (v: unknown): v is Link => !!v && typeof (v as Link).pollToken === 'string' && typeof (v as Link).code === 'string' && typeof (v as Link).url === 'string' && isNum((v as Link).expiresAt)

async function setView(io: SyncIO, next: RangeSync | ((v: RangeSync) => RangeSync)) {
  await io.setView(v => (typeof next === 'function' ? next(v ?? { status: 'signedOut' }) : next))
}

/** The view for a signed-in device, with its account's last sync. */
async function signedInView(io: SyncIO, note?: string): Promise<RangeSync> {
  const account = io.account()
  const last = usable(account) ? (await readAcct(io, account)).last : undefined
  const n = note ?? state.uploadNote ?? (usable(account) ? undefined : 'Syncs once Claude Code is signed in to a Pro or Max subscription.')
  return { status: 'signedIn', email: state.auth?.email ?? '', ...(last !== undefined ? { last } : {}), ...(n ? { note: n } : {}) }
}

async function readAcct(io: SyncIO, account: string): Promise<AcctState> {
  const v = (await io.get(acctKey(account))) as Partial<AcctState> | undefined
  return { sent: v?.sent && typeof v.sent === 'object' ? v.sent : {}, ...(typeof v?.cursor === 'string' ? { cursor: v.cursor } : {}), ...(isNum(v?.last) ? { last: v.last } : {}) }
}
/** Read, changed and written back at once, so sessions sharing the store lose as little of each other's as can be. */
async function patchAcct(io: SyncIO, account: string, change: (s: AcctState) => void) {
  const s = await readAcct(io, account)
  change(s)
  await io.set(acctKey(account), s)
}

const isSet = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false'

/**
 * Starts sync for this session: off when nonessential traffic is; the device id
 * found or made; the sign-in kept from before; a sign-in waiting in the browser
 * picked up again.
 */
export async function startSync(io: SyncIO) {
  state.started = true
  state.home = io
  state.disabled = isSet(await io.trafficOff().catch(() => undefined))
  if (state.disabled) {
    state.auth = null
    await setView(io, { status: 'off', note: 'Off: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set.' })
    return
  }
  const now = await io.now()
  const saved = await io.get(DEVICE_KEY)
  if (isDeviceId(saved)) state.device = saved
  else {
    const peeked = await io.peekDevice().catch(() => undefined)
    state.device = isDeviceId(peeked) ? peeked : newDeviceId(now)
    await io.set(DEVICE_KEY, state.device)
  }
  await refresh(io)
  // a view left from before a reload says what's so now
  if (!state.auth && !state.poll && (await io.view()).status !== 'signedOut') await setView(io, { status: 'signedOut' })
}

/** Picks up a sign-in, sign-out or sign-in in progress another session on this computer made. */
async function refresh(io: SyncIO) {
  if (state.disabled) return
  const stored = await io.get(AUTH_KEY)
  const auth = isAuth(stored) && stored.server === state.server ? stored : null
  if (auth?.token !== state.auth?.token) {
    state.auth = auth
    state.far.clear()
    state.failures = 0
    state.nextAt = 0
    if (auth) {
      stopPolling()
      await setView(io, await signedInView(io))
    } else if ((await io.view()).status === 'signedIn') {
      await setView(io, { status: 'signedOut' })
    }
  }
  if (state.auth) return
  const link = await io.get(LINK_KEY)
  const now = await io.now()
  if (isLink(link) && link.server === state.server && now < link.expiresAt) {
    if (!state.poll) {
      await setView(io, { status: 'waiting', code: link.code, url: link.url })
      startPolling(io, link)
    }
  } else if (state.poll) {
    // cancelled in another session
    stopPolling()
    await setView(io, { status: 'signedOut' })
  }
}

/** The lists downloaded for this account, while signed in: read from the store once, then kept as they come. */
export async function downloadedFor(io: SyncIO, account: string): Promise<Lists> {
  if (state.disabled || !state.auth || !usable(account)) return { readings: [], spans: [], steps: [] }
  let lists = state.far.get(account)
  if (!lists) {
    lists = new Map()
    state.far.set(account, lists)
    const prefix = cacheKey(account, '')
    for (const key of await io.keys()) {
      if (!key.startsWith(prefix)) continue
      const data = unpack(await io.get(key))
      if (data) lists.set(key.slice(prefix.length), data)
    }
  }
  return unpacked(lists.values())
}

/**
 * Once a minute: picks up what other sessions changed, and syncs when it's due
 * (every 10 minutes, later after failures). `force` syncs now.
 */
export async function syncTick(io: SyncIO, force = false) {
  if (!state.started || state.disabled) return
  await refresh(io)
  const now = await io.now()
  // ticks come a minute apart: one due within the next half minute is due now
  if (!state.auth || (!force && now + 30_000 < state.nextAt)) return
  await syncNow(io)
}

/** Uploads what changed, then downloads what's new; a failure backs off and the record carries on locally. */
export async function syncNow(io: SyncIO) {
  const account = io.account()
  const auth = state.auth
  if (state.running || state.disabled || !auth) return
  if (!usable(account)) {
    await setView(io, await signedInView(io))
    return
  }
  state.running = true
  try {
    const now = await io.now()
    try {
      await upload(io, account, auth.token, now)
    } catch (err) {
      if (!(err instanceof SyncError) || err.kind !== 'rejected') throw err
      // too big or over the quota: said once, and not tried again for an hour; downloads go on
      state.uploadPausedUntil = now + HOUR
      state.uploadNote = `Couldn't upload: ${err.detail ?? err.code}.`
      if (!state.rejectLogged) {
        state.rejectLogged = true
        io.log(`Token Range Monitor sync: the server refused an upload (${err.status} ${err.code}${err.detail ? `: ${err.detail}` : ''}). Retrying in an hour.`, { to: 'debug' })
      }
    }
    // signed out meanwhile: nothing more is kept
    if (state.auth !== auth) return
    const got = await download(io, account, auth.token, now)
    if (state.auth !== auth) return
    state.failures = 0
    state.nextAt = now + SYNC_EVERY
    if (now >= state.uploadPausedUntil) state.uploadNote = undefined
    await patchAcct(io, account, s => { s.last = now })
    await setView(io, await signedInView(io))
    if (got) await io.reload()
  } catch (err) {
    if (state.auth === auth) await failed(io, err)
  } finally {
    state.running = false
  }
}

async function failed(io: SyncIO, err: unknown) {
  const now = await io.now()
  const e = err instanceof SyncError ? err : new SyncError('retry', 0, 'error')
  if (e.kind === 'auth') {
    await forget(io)
    await setView(io, {
      status: 'signedOut',
      note: e.code === 'device_expired'
        ? 'This device was signed out after 90 days unused. Sign in again to sync.'
        : 'This device is no longer signed in to sync. Sign in again to sync.',
    })
    await io.reload()
    return
  }
  state.failures++
  const wait = backoffMs(state.failures, e.retryAfterMs)
  state.nextAt = now + wait
  const why = e.status === 0 ? "Couldn't reach the sync server"
    : e.status === 429 ? 'The sync server asked to slow down'
    : e.code === 'not_configured' ? "The sync server isn't set up"
    : e.status === 503 ? 'The sync server is over its free daily limit'
    : `The sync server answered ${e.status}`
  await setView(io, await signedInView(io, `${why}; trying again in ${minutes(wait)}.`))
}

async function upload(io: SyncIO, account: string, token: string, now: number) {
  if (now < state.uploadPausedUntil) return
  const lists = packLists(state.device, packDays(await io.collect(), now))
  const todo = changedLists(lists, (await readAcct(io, account)).sent)
  for (const batch of batches(todo)) {
    await call(io, 'PUT', '/v1/lists', { account, lists: batch.map(l => ({ key: l.key, data: l.data })) }, token)
    await patchAcct(io, account, s => { for (const l of batch) s.sent[l.key] = l.fp })
  }
  // fingerprints of days gone from the record are dropped
  await patchAcct(io, account, s => {
    for (const key of Object.keys(s.sent)) {
      const k = parseListKey(key)
      if (!k || dayStart(k.day) < now - KEEP) delete s.sent[key]
    }
  })
}

/** Follows the cursor through every page; returns how many lists came. Repeats are harmless: the record merges them. */
async function download(io: SyncIO, account: string, token: string, now: number): Promise<number> {
  let cursor = (await readAcct(io, account)).cursor
  let lists = state.far.get(account)
  if (!lists) await downloadedFor(io, account)
  lists = state.far.get(account) ?? new Map<string, DayData>()
  state.far.set(account, lists)
  let got = 0
  let restarted = false
  for (let page = 0; page < 50; page++) {
    let r: Json
    try {
      r = await call(io, 'GET', `/v1/lists?account=${encodeURIComponent(account)}${cursor ? `&since=${encodeURIComponent(cursor)}` : ''}`, undefined, token)
    } catch (err) {
      // a cursor the server can't read: everything again, once
      if (err instanceof SyncError && err.kind === 'cursor' && !restarted) { restarted = true; cursor = undefined; continue }
      throw err
    }
    for (const l of Array.isArray(r.lists) ? r.lists as Array<{ key?: unknown; data?: unknown }> : []) {
      const k = typeof l?.key === 'string' ? parseListKey(l.key) : null
      // this device's own lists are already here
      if (!k || k.device === state.device || dayStart(k.day) + DAY < now - KEEP) continue
      const data = unpack(l.data)
      if (!data) continue
      lists.set(l.key as string, data)
      got++
      // kept for a restart; a store that is full keeps it for this session only
      try { await io.set(cacheKey(account, l.key as string), data) } catch { /* in memory */ }
    }
    if (typeof r.cursor === 'string') cursor = r.cursor
    if (r.more !== true) break
  }
  await patchAcct(io, account, s => { if (cursor) s.cursor = cursor; else delete s.cursor })
  // days aged out of the record leave the cache
  const prefix = cacheKey(account, '')
  for (const key of await io.keys()) {
    if (!key.startsWith(prefix)) continue
    const k = parseListKey(key.slice(prefix.length))
    if (!k || dayStart(k.day) + DAY < now - KEEP) await io.del(key)
  }
  for (const key of [...lists.keys()]) {
    const k = parseListKey(key)
    if (!k || dayStart(k.day) + DAY < now - KEEP) lists.delete(key)
  }
  return got
}

/** At the session's end: one last upload, so what this session saw since the last sync isn't left behind. */
export async function endSync(io: SyncIO) {
  const account = io.account()
  if (state.disabled || !state.auth || !usable(account) || state.running) return
  try {
    await upload(io, account, state.auth.token, await io.now())
  } catch { /* next session */ }
}

/** Drops the sign-in and everything downloaded with it: the record goes back to this computer's own lists. */
async function forget(io: SyncIO) {
  state.auth = null
  state.far.clear()
  state.failures = 0
  state.nextAt = 0
  state.uploadPausedUntil = 0
  state.uploadNote = undefined
  stopPolling()
  state.confirm?.cancel()
  state.confirm = null
  await io.del(AUTH_KEY)
  for (const key of await io.keys()) {
    if (key.startsWith(CACHE_PREFIX) || key.startsWith('sync:acct:')) await io.del(key)
  }
}

// ---------------------------------------------------------------- signing in and out

/** Starts the device link: the server hands out a code and a page to sign in on, then is asked until it says yes. */
export async function signIn(io: SyncIO) {
  if (state.disabled || state.auth || state.poll || (await io.view()).busy) return
  await setView(io, v => ({ ...v, status: 'signedOut', busy: true }))
  try {
    const name = (await io.hostName().catch(() => undefined))?.slice(0, 64)
    const r = await call(io, 'POST', '/v1/link/start', name ? { deviceName: name } : {})
    const now = await io.now()
    if (typeof r.code !== 'string' || typeof r.url !== 'string' || !/^https?:\/\//.test(r.url) || typeof r.pollToken !== 'string') {
      throw new SyncError('rejected', 200, 'bad_answer')
    }
    const ttl = isNum(r.expiresIn) ? Math.min(r.expiresIn * 1000, LINK_TTL) : LINK_TTL
    const link: Link = {
      pollToken: r.pollToken, code: r.code, url: r.url,
      interval: isNum(r.interval) ? Math.min(60, Math.max(1, r.interval)) : 3,
      expiresAt: now + ttl, server: state.server,
    }
    await io.set(LINK_KEY, link)
    await setView(io, { status: 'waiting', code: link.code, url: link.url })
    startPolling(io, link)
  } catch (err) {
    const e = err instanceof SyncError ? err : null
    await setView(io, {
      status: 'signedOut',
      note: e?.status === 429 ? 'Too many sign-in attempts; try again in a few minutes.'
        : e?.status === 0 || !e ? "Couldn't reach the sync server."
        : `The sync server answered ${e.status}${e.detail ? `: ${e.detail}` : ''}.`,
    })
  }
}

function startPolling(io: SyncIO, link: Link) {
  stopPolling()
  const home = state.home ?? io
  state.poll = home.every(link.interval * 1000, () => void pollOnce(home, link))
}
function stopPolling() {
  state.poll?.cancel()
  state.poll = null
}

async function pollOnce(io: SyncIO, link: Link) {
  if (state.polling || state.poll === null) return
  state.polling = true
  try {
    // another session may have finished it
    await refresh(io)
    if (state.auth || !state.poll) return
    const now = await io.now()
    if (now >= link.expiresAt) return await expired(io)
    let r: Json
    try {
      r = await call(io, 'POST', '/v1/link/poll', { pollToken: link.pollToken })
    } catch (err) {
      // the network or a busy server: asked again next time; anything else ends it
      if (err instanceof SyncError && err.kind === 'retry') return
      return await expired(io)
    }
    if (r.status === 'ok' && typeof r.deviceToken === 'string' && r.deviceToken) {
      const auth: Auth = { token: r.deviceToken, email: typeof r.email === 'string' ? r.email : '', server: state.server }
      stopPolling()
      await io.set(AUTH_KEY, auth)
      await io.del(LINK_KEY)
      state.auth = auth
      state.far.clear()
      state.failures = 0
      state.nextAt = 0
      await setView(io, await signedInView(io))
      await syncNow(io)
      await io.reload()
    } else if (r.status === 'expired') {
      await expired(io)
    }
  } finally {
    state.polling = false
  }
}

async function expired(io: SyncIO) {
  stopPolling()
  await io.del(LINK_KEY)
  // the one-time answer may have gone to another session on this computer
  await refresh(io)
  if (!state.auth) await setView(io, { status: 'signedOut', note: 'The sign-in code expired. Press Sign in to try again.' })
}

export async function cancelSignIn(io: SyncIO) {
  stopPolling()
  await io.del(LINK_KEY)
  await setView(io, { status: 'signedOut' })
}

/** Unlinks this device on the server, then forgets the sign-in and the downloaded lists here. */
export async function signOut(io: SyncIO) {
  const auth = state.auth
  if (!auth) return
  await setView(io, v => ({ ...v, busy: true }))
  let note: string | undefined
  try {
    await call(io, 'DELETE', '/v1/device', undefined, auth.token)
  } catch (err) {
    if (!(err instanceof SyncError && err.kind === 'auth')) note = "Signed out here; the server couldn't be reached, so it lists this device until it goes unused for 90 days."
  }
  await forget(io)
  await setView(io, note ? { status: 'signedOut', note } : { status: 'signedOut' })
  await io.reload()
}

/** The first press asks for a second; the second deletes the account and every synced list on the server. */
export async function deleteSynced(io: SyncIO) {
  const auth = state.auth
  if (!auth) return
  const v = await io.view()
  if (v.busy) return
  if (!v.confirmDelete) {
    await setView(io, { ...v, confirmDelete: true })
    state.confirm?.cancel()
    const home = state.home ?? io
    state.confirm = home.after(CONFIRM_FOR, () => void setView(home, x => {
      const { confirmDelete: _, ...rest } = x
      return rest
    }))
    return
  }
  state.confirm?.cancel()
  state.confirm = null
  await setView(io, { ...v, confirmDelete: false, busy: true })
  try {
    await call(io, 'DELETE', '/v1/me', undefined, auth.token)
  } catch (err) {
    if (!(err instanceof SyncError && err.kind === 'auth')) {
      await setView(io, await signedInView(io, `Couldn't delete the synced data: ${err instanceof SyncError && err.status ? `the server answered ${err.status}` : "the server couldn't be reached"}.`))
      return
    }
  }
  await forget(io)
  await setView(io, { status: 'signedOut', note: 'Deleted all synced data and signed out.' })
  await io.reload()
}
