/** Token Range Monitor sync backend: router and worker entry points. */
import type { Deps, Env } from './env'
import { HttpError, html, json, jsonError } from './http'
import { purgeIdleDevices } from './db'
import { linkPageHandler, pollLink, purgeExpiredCodes, startLink } from './link'
import { getLists, purgeOldLists, putLists } from './lists'
import { deleteDevice, deleteMe, getMe } from './me'
import { callback, startAuth } from './oauth'
import { landingPage, privacyPage } from './pages'

type Handler = (req: Request, env: Env, deps: Deps) => Promise<Response> | Response

/** path → method → handler */
const ROUTES: Record<string, Record<string, Handler>> = {
  '/': { GET: () => html(landingPage()) },
  '/privacy': { GET: () => html(privacyPage()) },
  '/link': { GET: linkPageHandler },
  '/v1/link/start': { POST: startLink },
  '/v1/link/poll': { POST: pollLink },
  '/v1/me': { GET: getMe, DELETE: deleteMe },
  '/v1/device': { DELETE: deleteDevice },
  '/v1/lists': { GET: getLists, PUT: putLists },
  '/auth/google/start': { GET: (r, e, d) => startAuth('google', r, e, d) },
  '/auth/google/callback': { GET: (r, e, d) => callback('google', r, e, d) },
  '/auth/github/start': { GET: (r, e, d) => startAuth('github', r, e, d) },
  '/auth/github/callback': { GET: (r, e, d) => callback('github', r, e, d) },
}

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const route = ROUTES[new URL(req.url).pathname]
  if (!route) return jsonError(404, 'not_found')
  const method = req.method === 'HEAD' ? 'GET' : req.method
  const handler = route[method]
  if (!handler) return json({ error: 'method_not_allowed' }, 405, { allow: Object.keys(route).join(', ') })
  try {
    return await handler(req, env, deps)
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.status, e.code, e.detail, e.headers)
    console.error('unhandled error', e)
    return jsonError(500, 'internal_error')
  }
}

/**
 * The daily cron: expired link codes, lists not updated for 15 days, devices
 * unused for 90 days. Each step is bounded and runs even if another fails.
 */
export async function housekeeping(env: Env, now: number): Promise<{ codes: number; lists: number; devices: number }> {
  const step = async (name: string, f: () => Promise<number>) => {
    try {
      return await f()
    } catch (e) {
      console.error(`housekeeping: ${name} failed`, e)
      return 0
    }
  }
  return {
    codes: await step('link codes', () => purgeExpiredCodes(env, now)),
    lists: await step('lists', () => purgeOldLists(env.DB, now)),
    devices: await step('devices', () => purgeIdleDevices(env.DB, now)),
  }
}

const liveDeps: Deps = { fetch: (input, init) => fetch(input, init), now: () => Date.now() }

export default {
  fetch: (req, env) => handle(req, env, liveDeps),
  async scheduled(_controller, env) {
    await housekeeping(env, Date.now())
  },
} satisfies ExportedHandler<Env>
