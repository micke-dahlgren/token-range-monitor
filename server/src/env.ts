/** Bindings and secrets the worker reads. See wrangler.toml and .dev.vars.example. */
export interface Env {
  DB: D1Database
  /** Public origin, no trailing slash, e.g. http://localhost:8787. */
  PUBLIC_URL: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** HMAC key for Claude account ids (Phase 2 lists API). */
  ACCOUNT_HASH_KEY?: string
  /** HMAC key signing the OAuth state cookie and the rate-limit IP hash. */
  SESSION_KEY?: string
}

/** Side effects the handlers use, injectable so tests can fake providers and time. */
export interface Deps {
  fetch: typeof fetch
  now: () => number
}

export const publicUrl = (env: Env) => env.PUBLIC_URL.replace(/\/+$/, '')
