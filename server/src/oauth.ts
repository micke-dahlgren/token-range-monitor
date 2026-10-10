/** Google and GitHub sign-in (authorization code flow with PKCE) for the device-link page. */
import { normalizeCode, randomToken, sha256B64url, signValue, verifyValue } from './crypto'
import { resolveUser, userEmail, type Provider, type ProviderProfile } from './db'
import type { Deps, Env } from './env'
import { publicUrl } from './env'
import { getCookie, html, redirect } from './http'
import { completeCode, INVALID_CODE_TEXT, openCode } from './link'
import { messagePage, successPage } from './pages'

export const STATE_COOKIE = 'trm_oauth'
const STATE_TTL_MS = 10 * 60 * 1000
const COOKIE_ATTRS = 'Path=/auth/; HttpOnly; Secure; SameSite=Lax'
const clearCookie: [string, string] = ['set-cookie', `${STATE_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`]

/** What the signed state cookie carries. */
export interface OAuthState {
  /** link code */
  c: string
  /** provider */
  p: Provider
  /** nonce, echoed back as the `state` parameter */
  n: string
  /** PKCE code verifier */
  v: string
  /** expiry, ms */
  e: number
}

const PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
    clientId: (env: Env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env: Env) => env.GOOGLE_CLIENT_SECRET,
    profile: googleProfile,
  },
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    scope: 'read:user user:email',
    clientId: (env: Env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env: Env) => env.GITHUB_CLIENT_SECRET,
    profile: githubProfile,
  },
} as const

export const providerEnabled = (env: Env, p: Provider) => Boolean(PROVIDERS[p].clientId(env) && PROVIDERS[p].clientSecret(env) && env.SESSION_KEY)
export const redirectUri = (env: Env, p: Provider) => `${publicUrl(env)}/auth/${p}/callback`

/** A sign-in failure worth showing to the user as is. */
class AuthError extends Error {}

const notConfigured = (label: string) => html(messagePage('Not available', `${label} sign-in is not configured on this server.`), 503)

export async function startAuth(provider: Provider, req: Request, env: Env, deps: Deps): Promise<Response> {
  const cfg = PROVIDERS[provider]
  if (!providerEnabled(env, provider)) return notConfigured(cfg.label)
  const code = normalizeCode(new URL(req.url).searchParams.get('code'))
  if (!code || !(await openCode(env, code, deps.now()))) return html(messagePage('Link expired', INVALID_CODE_TEXT), 400)

  const state: OAuthState = { c: code, p: provider, n: randomToken(), v: randomToken(), e: deps.now() + STATE_TTL_MS }
  const cookie = await signValue(env.SESSION_KEY!, state)
  const url = new URL(cfg.authorize)
  url.search = new URLSearchParams({
    client_id: cfg.clientId(env)!,
    redirect_uri: redirectUri(env, provider),
    response_type: 'code',
    scope: cfg.scope,
    state: state.n,
    code_challenge: await sha256B64url(state.v),
    code_challenge_method: 'S256',
    ...(provider === 'google' ? { prompt: 'select_account' } : {}),
  }).toString()
  return redirect(url.toString(), [['set-cookie', `${STATE_COOKIE}=${cookie}; ${COOKIE_ATTRS}; Max-Age=${STATE_TTL_MS / 1000}`]])
}

export async function callback(provider: Provider, req: Request, env: Env, deps: Deps): Promise<Response> {
  const cfg = PROVIDERS[provider]
  if (!providerEnabled(env, provider)) return notConfigured(cfg.label)
  // every outcome ends this attempt, so the state cookie is always cleared
  const page = (title: string, text: string, status: number) => html(messagePage(title, text), status, [clearCookie])

  const params = new URL(req.url).searchParams
  if (params.get('error')) return page('Sign-in cancelled', `${cfg.label} sign-in was cancelled. Open the link from Claude Code again to retry.`, 400)

  const raw = getCookie(req, STATE_COOKIE)
  const state = raw ? await verifyValue<OAuthState>(env.SESSION_KEY!, raw) : null
  const now = deps.now()
  const stateParam = params.get('state')
  if (!state || state.p !== provider || !(state.e > now) || !stateParam || stateParam !== state.n || !params.get('code')) {
    return page('Sign-in failed', 'This sign-in attempt is invalid or has expired. Open the link from Claude Code again.', 400)
  }
  if (!(await openCode(env, state.c, now))) return page('Link expired', INVALID_CODE_TEXT, 400)

  let profile: ProviderProfile
  try {
    profile = await cfg.profile(env, deps, params.get('code')!, state.v)
  } catch (e) {
    if (e instanceof AuthError) return page('Sign-in failed', e.message, 400)
    console.error(`${provider} sign-in failed`, e)
    return page('Sign-in failed', `Could not complete ${cfg.label} sign-in. Please try again.`, 502)
  }
  if (!profile.emailVerified) {
    return page('Email not verified', `Your ${cfg.label} email address is not verified. Verify it with ${cfg.label}, then try again.`, 400)
  }

  const { userId } = await resolveUser(env.DB, profile, now)
  if (!(await completeCode(env, state.c, userId, now))) return page('Link expired', INVALID_CODE_TEXT, 400)
  return html(successPage((await userEmail(env.DB, userId)) ?? profile.email), 200, [clearCookie])
}

async function getJson<T>(deps: Deps, url: string, init: RequestInit): Promise<T> {
  const res = await deps.fetch(url, init)
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status}`)
  return (await res.json()) as T
}

async function googleProfile(env: Env, deps: Deps, code: string, verifier: string): Promise<ProviderProfile> {
  const token = await getJson<{ access_token?: string }>(deps, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(env, 'google'),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })
  if (!token.access_token) throw new Error('google: no access_token')
  const info = await getJson<{ sub?: string; email?: string; email_verified?: boolean | string }>(
    deps,
    'https://openidconnect.googleapis.com/v1/userinfo',
    { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' } },
  )
  if (!info.sub || !info.email) throw new AuthError('Your Google account did not share an email address.')
  return {
    provider: 'google',
    providerUserId: info.sub,
    email: info.email,
    emailVerified: info.email_verified === true || info.email_verified === 'true',
  }
}

const GITHUB_UA = 'token-range-monitor-sync'
const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': GITHUB_UA, 'x-github-api-version': '2022-11-28' }

async function githubProfile(env: Env, deps: Deps, code: string, verifier: string): Promise<ProviderProfile> {
  const token = await getJson<{ access_token?: string; error?: string }>(deps, 'https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': GITHUB_UA },
    body: new URLSearchParams({
      code,
      client_id: env.GITHUB_CLIENT_ID!,
      client_secret: env.GITHUB_CLIENT_SECRET!,
      redirect_uri: redirectUri(env, 'github'),
      code_verifier: verifier,
    }),
  })
  // GitHub reports exchange errors as 200 with an `error` field
  if (!token.access_token) throw new Error(`github: ${token.error ?? 'no access_token'}`)
  const headers = { ...GITHUB_HEADERS, authorization: `Bearer ${token.access_token}` }
  const user = await getJson<{ id?: number }>(deps, 'https://api.github.com/user', { headers })
  const emails = await getJson<Array<{ email: string; primary: boolean; verified: boolean }>>(deps, 'https://api.github.com/user/emails', { headers })
  if (typeof user.id !== 'number') throw new Error('github: no user id')
  const primary = Array.isArray(emails) ? emails.find((e) => e.primary) : undefined
  if (!primary) throw new AuthError('Your GitHub account has no primary email address.')
  // only the primary email counts, and only once verified: an unverified one is refused, never linked
  return { provider: 'github', providerUserId: String(user.id), email: primary.email, emailVerified: primary.verified === true }
}
