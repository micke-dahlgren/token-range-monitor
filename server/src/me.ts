/** Endpoints for a linked device: who am I, rename / unlink this device, remove another device, delete my account. */
import { authed } from './auth'
import { deleteUser } from './db'
import type { Deps, Env } from './env'
import { HttpError, json, readJson } from './http'

/** Longest device name, in characters (code points). */
export const MAX_DEVICE_NAME = 64

export async function getMe(req: Request, env: Env, deps: Deps): Promise<Response> {
  const device = await authed(req, env, deps)
  const [user, providers, devices] = await env.DB.batch([
    env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(device.user_id),
    env.DB.prepare('SELECT DISTINCT provider FROM identities WHERE user_id = ? ORDER BY provider').bind(device.user_id),
    env.DB.prepare('SELECT id, name, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY created_at').bind(device.user_id),
  ])
  return json({
    email: (user?.results[0] as { email: string | null } | undefined)?.email ?? null,
    providers: (providers?.results as Array<{ provider: string }>).map((p) => p.provider),
    devices: (devices?.results as Array<{ id: string; name: string | null; created_at: number; last_seen_at: number | null }>).map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      current: d.id === device.id,
    })),
  })
}

/** DELETE /v1/device: unlinks the calling device (sign out). Its lists stay. */
export async function deleteDevice(req: Request, env: Env, deps: Deps, authedId?: string): Promise<Response> {
  const id = authedId ?? (await authed(req, env, deps)).id
  await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(id).run()
  return json({ ok: true })
}

/** PUT /v1/device `{ name }`: sets the calling device's display name (1–64 chars after trimming; control chars stripped). */
export async function renameDevice(req: Request, env: Env, deps: Deps): Promise<Response> {
  const device = await authed(req, env, deps)
  const body = await readJson(req)
  const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() : ''
  if (!name || [...name].length > MAX_DEVICE_NAME) {
    throw new HttpError(400, 'invalid_name', `name must be 1–${MAX_DEVICE_NAME} characters`)
  }
  await env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(name, device.id).run()
  return json({ ok: true, name })
}

/**
 * DELETE /v1/devices/:id: removes one of the caller's devices. Its token stops
 * working at once and the lists it uploaded are deleted (data from an unwanted
 * device should not stay in the user's charts). An unknown id and another
 * user's device get the same 404. The caller's own id equals DELETE /v1/device
 * (sign out; its lists stay).
 */
export async function deleteOtherDevice(id: string, req: Request, env: Env, deps: Deps): Promise<Response> {
  const device = await authed(req, env, deps)
  if (id === device.id) return deleteDevice(req, env, deps, device.id)
  const [lists, removed] = await env.DB.batch([
    // only if the device is the caller's: the subquery is empty otherwise
    env.DB.prepare('DELETE FROM lists WHERE user_id = ? AND device_id = (SELECT id FROM devices WHERE id = ? AND user_id = ?)').bind(
      device.user_id,
      id,
      device.user_id,
    ),
    env.DB.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').bind(id, device.user_id),
  ])
  if (removed?.meta.changes !== 1) throw new HttpError(404, 'not_found')
  return json({ ok: true, listsDeleted: lists?.meta.changes ?? 0 })
}

export async function deleteMe(req: Request, env: Env, deps: Deps): Promise<Response> {
  const device = await authed(req, env, deps)
  await deleteUser(env.DB, device.user_id)
  return json({ ok: true })
}
