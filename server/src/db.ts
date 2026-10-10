/** D1 queries for users, identities and devices. */
import { randomToken, sha256Hex } from './crypto'

export type Provider = 'google' | 'github'

export interface ProviderProfile {
  provider: Provider
  providerUserId: string
  email: string
  emailVerified: boolean
}

export interface DeviceRow {
  id: string
  user_id: string
  name: string | null
  created_at: number
  last_seen_at: number | null
}

export const newId = () => crypto.randomUUID()
export const normalizeEmail = (email: string) => email.trim().toLowerCase()

/**
 * The user a provider sign-in belongs to:
 * 1. the identity was seen before: its user;
 * 2. else a user already holding an identity with the same *verified* email
 *    (and this sign-in's email is verified too): the new identity joins it;
 * 3. else a new user.
 */
export async function resolveUser(db: D1Database, p: ProviderProfile, now: number): Promise<{ userId: string; linked: boolean; created: boolean }> {
  const email = normalizeEmail(p.email)
  const verified = p.emailVerified ? 1 : 0

  const known = await db
    .prepare('SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?')
    .bind(p.provider, p.providerUserId)
    .first<{ user_id: string }>()
  if (known) {
    await db
      .prepare('UPDATE identities SET email = ?, email_verified = ? WHERE provider = ? AND provider_user_id = ?')
      .bind(email, verified, p.provider, p.providerUserId)
      .run()
    return { userId: known.user_id, linked: false, created: false }
  }

  if (verified) {
    const match = await db
      .prepare('SELECT user_id FROM identities WHERE email = ? AND email_verified = 1 ORDER BY created_at LIMIT 1')
      .bind(email)
      .first<{ user_id: string }>()
    if (match) {
      await insertIdentity(db, match.user_id, p.provider, p.providerUserId, email, verified, now)
      return { userId: match.user_id, linked: true, created: false }
    }
  }

  const userId = newId()
  await db.batch([
    db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(userId, email, now),
    identityInsert(db, userId, p.provider, p.providerUserId, email, verified, now),
  ])
  return { userId, linked: false, created: true }
}

const identityInsert = (db: D1Database, userId: string, provider: string, pid: string, email: string, verified: number, now: number) =>
  db
    .prepare('INSERT INTO identities (provider, provider_user_id, user_id, email, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(provider, pid, userId, email, verified, now)

async function insertIdentity(db: D1Database, userId: string, provider: string, pid: string, email: string, verified: number, now: number) {
  await identityInsert(db, userId, provider, pid, email, verified, now).run()
}

export async function userEmail(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string | null }>()
  return row?.email ?? null
}

/** Creates a device and returns its bearer token (only its hash is stored). */
export async function createDevice(db: D1Database, userId: string, name: string | null, now: number): Promise<{ id: string; token: string }> {
  const token = randomToken()
  const id = newId()
  await db
    .prepare('INSERT INTO devices (id, user_id, token_hash, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, await sha256Hex(token), name, now, now)
    .run()
  return { id, token }
}

/** The device a bearer token belongs to, marking it seen. */
export async function deviceByToken(db: D1Database, token: string, now: number): Promise<DeviceRow | null> {
  const row = await db
    .prepare('UPDATE devices SET last_seen_at = ? WHERE token_hash = ? RETURNING id, user_id, name, created_at, last_seen_at')
    .bind(now, await sha256Hex(token))
    .first<DeviceRow>()
  return row ?? null
}

export async function deleteUser(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM lists WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM devices WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM link_codes WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM identities WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ])
}
