/** Small Web Crypto helpers. */

const enc = new TextEncoder()

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** A random opaque token: 32 bytes, base64url. */
export const randomToken = () => base64url(randomBytes(32))

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))
}

export async function sha256B64url(s: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))))
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)))
}

/** `<base64url(json)>.<base64url(hmac)>` */
export async function signValue(secret: string, value: unknown): Promise<string> {
  const body = base64url(enc.encode(JSON.stringify(value)))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)))
  return `${body}.${base64url(sig)}`
}

/** The value signed by `signValue`, or null when the signature does not match (constant-time check). */
export async function verifyValue<T>(secret: string, signed: string): Promise<T | null> {
  const [body, sig, extra] = signed.split('.')
  if (!body || !sig || extra !== undefined) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64url(sig), enc.encode(body))
    return ok ? (JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T) : null
  } catch {
    return null
  }
}

/** 32 symbols without 0/O, 1/I: easy to read aloud and type. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** 8 random symbols (40 bits), stored without the dash. */
export function randomCode(): string {
  return [...randomBytes(8)].map((b) => CODE_ALPHABET[b & 31]).join('')
}

/** `ABCD-EFGH` for display. */
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

/** Accepts `abcd-efgh`, `ABCDEFGH`, with spaces; null when it cannot be a code. */
export function normalizeCode(input: string | null | undefined): string | null {
  const c = (input ?? '').toUpperCase().replace(/[\s-]/g, '')
  return c.length === 8 && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null
}

/** Phase 2: the Claude account id (`<accountUuid>.<orgUuid>`) as stored server-side. */
export const accountHash = (key: string, claudeAccount: string) => hmacHex(key, `account:${claudeAccount}`)
