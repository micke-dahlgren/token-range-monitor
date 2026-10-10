/** Bearer-token authentication for the device API. */
import { deviceByToken, type DeviceRow } from './db'
import type { Deps, Env } from './env'
import { bearer, HttpError } from './http'

/**
 * The calling device. 401 `{"error":"unauthorized"}` for a missing or unknown
 * token; 401 `{"error":"device_expired"}` for a device unused for 90 days
 * (it is deleted on the spot). Either way the mod must link again.
 */
export async function authed(req: Request, env: Env, deps: Deps): Promise<DeviceRow> {
  const token = bearer(req)
  const found = token ? await deviceByToken(env.DB, token, deps.now()) : null
  if (!found) throw new HttpError(401, 'unauthorized')
  if ('expired' in found) throw new HttpError(401, 'device_expired', 'This device was unused for 90 days and has been signed out. Link it again.')
  return found.device
}
