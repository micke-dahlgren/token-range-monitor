/** Response helpers and request parsing. */

export const MAX_BODY_BYTES = 256 * 1024

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Optional human-readable explanation, sent as `message`. */
    readonly detail?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code)
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

export const jsonError = (status: number, error: string, message?: string, headers: Record<string, string> = {}) =>
  json(message ? { error, message } : { error }, status, headers)

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  // callback URLs carry the OAuth code: never leak them
  'referrer-policy': 'no-referrer',
}

/**
 * An HTML page with the strict default headers. A `content-security-policy`
 * entry in `headers` replaces the default policy (a second CSP header would
 * only tighten it); everything else is appended (e.g. several set-cookie).
 */
export function html(body: string, status = 200, headers: Record<string, string> | [string, string][] = []): Response {
  const h = new Headers(PAGE_HEADERS)
  for (const [k, v] of Array.isArray(headers) ? headers : Object.entries(headers)) {
    if (k.toLowerCase() === 'content-security-policy') h.set(k, v)
    else h.append(k, v)
  }
  return new Response(body, { status, headers: h })
}

export function redirect(location: string, headers: [string, string][] = []): Response {
  const h = new Headers({ location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  for (const [k, v] of headers) h.append(k, v)
  return new Response(null, { status: 302, headers: h })
}

/** The raw body as text (empty body → ''), capped at `max` bytes (413 beyond). */
export async function readText(req: Request, max = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > max) throw new HttpError(413, 'body_too_large')
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw new HttpError(413, 'body_too_large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** The JSON body as an object (empty body → {}), capped at MAX_BODY_BYTES. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = (await readText(req)).trim()
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid_json')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'invalid_json')
  return parsed as Record<string, unknown>
}

/** An `application/x-www-form-urlencoded` body (the sign-in form), capped at `max` bytes. */
export async function readForm(req: Request, max = 4096): Promise<URLSearchParams> {
  return new URLSearchParams(await readText(req, max))
}

export function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')
  return m?.[1] ?? null
}

export function getCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}
