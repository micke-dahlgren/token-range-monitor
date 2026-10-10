/** Endpoints for a linked device: who am I, unlink this device, delete my account. */
import { authed } from './auth'
import { deleteUser } from './db'
import type { Deps, Env } from './env'
import { json } from './http'

export async function getMe(req: Request, env: Env, deps: Deps): Promise<Response> {
  const device = await authed(req, env, deps)
  const [user, providers, devices] = await env.DB.batch([
    env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(device.user_id),
    env.DB.prepare('SELECT DISTINCT provider FROM identities WHERE user_id = ? ORDER BY provider').bind(device.user_id),
    env.DB.prepare('SELECT id, name, last_seen_at FROM devices WHERE user_id = ? ORDER BY created_at').bind(device.user_id),
  ])
  return json({
    email: (user?.results[0] as { email: string | null } | undefined)?.email ?? null,
    providers: (providers?.results as Array<{ provider: string }>).map((p) => p.provider),
    devices: (devices?.results as Array<{ id: string; name: string | null; last_seen_at: number | null }>).map((d) => ({
      id: d.id,
      name: d.name,
      lastSeenAt: d.last_seen_at,
      current: d.id === device.id,
    })),
  })
}

export async function deleteDevice(req: Request, env: Env, deps: Deps): Promise<Response> {
  const device = await authed(req, env, deps)
  await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run()
  return json({ ok: true })
}

export async function deleteMe(req: Request, env: Env, deps: Deps): Promise<Response> {
  const device = await authed(req, env, deps)
  await deleteUser(env.DB, device.user_id)
  return json({ ok: true })
}
