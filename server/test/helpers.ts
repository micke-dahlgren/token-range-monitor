/** Test helpers: a fake clock, fake Google/GitHub endpoints, and a browser-like sign-in. */
import { env } from 'cloudflare:test'
import { expect } from 'vitest'
import type { Deps } from '../src/env'
import { handle } from '../src/index'

export interface GoogleUser {
  sub: string
  email: string
  email_verified: boolean
}
export interface GithubUser {
  id: number
  emails: Array<{ email: string; primary: boolean; verified: boolean }>
}

/** Fake providers: an authorization code maps to the account that "signed in" with it. */
export function fakeWorld() {
  let clock = Date.now()
  const google = new Map<string, GoogleUser>()
  const github = new Map<string, GithubUser>()
  const calls: Array<{ url: string; init?: RequestInit }> = []

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({ url, init })
    const form = () => new URLSearchParams(String(init?.body ?? ''))
    const tokenOf = () => new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
    const ok = (data: unknown) => Response.json(data)
    switch (url) {
      case 'https://oauth2.googleapis.com/token': {
        const code = form().get('code')!
        return google.has(code) ? ok({ access_token: `g-${code}`, token_type: 'Bearer' }) : Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      case 'https://openidconnect.googleapis.com/v1/userinfo': {
        const u = google.get(tokenOf().replace(/^g-/, ''))
        return u ? ok(u) : new Response('unauthorized', { status: 401 })
      }
      case 'https://github.com/login/oauth/access_token': {
        const code = form().get('code')!
        return ok(github.has(code) ? { access_token: `h-${code}`, token_type: 'bearer' } : { error: 'bad_verification_code' })
      }
      case 'https://api.github.com/user': {
        const u = github.get(tokenOf().replace(/^h-/, ''))
        return u ? ok({ id: u.id, login: `user${u.id}` }) : new Response('unauthorized', { status: 401 })
      }
      case 'https://api.github.com/user/emails': {
        const u = github.get(tokenOf().replace(/^h-/, ''))
        return u ? ok(u.emails) : new Response('unauthorized', { status: 401 })
      }
    }
    throw new Error(`unexpected fetch ${url}`)
  }

  const deps: Deps = { fetch: fakeFetch as typeof fetch, now: () => clock }
  return {
    deps,
    google,
    github,
    calls,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

export type World = ReturnType<typeof fakeWorld>

let ipCounter = 0
/** A fresh client IP, so tests don't share the /v1/link/start rate limit. */
export const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`

export function call(world: World, path: string, init: RequestInit = {}): Promise<Response> {
  return handle(new Request(`http://localhost:8787${path}`, init), env, world.deps)
}

export const postJson = (world: World, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(world, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

export interface Started {
  code: string
  url: string
  pollToken: string
  expiresIn: number
  interval: number
}

export async function start(world: World, deviceName = 'test laptop', ip = freshIp()): Promise<Started> {
  const res = await postJson(world, '/v1/link/start', { deviceName }, { 'cf-connecting-ip': ip })
  expect(res.status).toBe(200)
  return res.json()
}

export async function poll(world: World, pollToken: string): Promise<{ status: string; deviceToken?: string; email?: string }> {
  const res = await postJson(world, '/v1/link/poll', { pollToken })
  expect(res.status).toBe(200)
  return res.json()
}

/** The browser's start redirect: the state cookie and the state param sent to the provider. */
export async function beginSignIn(world: World, provider: 'google' | 'github', displayCode: string) {
  const res = await call(world, `/auth/${provider}/start?code=${displayCode}`)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  const setCookie = res.headers.get('set-cookie')!
  const cookie = /^trm_oauth=([^;]+)/.exec(setCookie)![1]!
  return { location, setCookie, cookie, state: location.searchParams.get('state')! }
}

/** Starts sign-in and comes back from the provider with `authCode`; returns the callback response. */
export async function signIn(world: World, provider: 'google' | 'github', displayCode: string, authCode: string): Promise<Response> {
  const { cookie, state } = await beginSignIn(world, provider, displayCode)
  return call(world, `/auth/${provider}/callback?code=${authCode}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `other=1; trm_oauth=${cookie}` },
  })
}

/** start → sign in → poll: a linked device token. */
export async function linkDevice(world: World, provider: 'google' | 'github', authCode: string, deviceName?: string) {
  const s = await start(world, deviceName)
  const res = await signIn(world, provider, s.code, authCode)
  expect(res.status).toBe(200)
  const p = await poll(world, s.pollToken)
  expect(p.status).toBe('ok')
  return p.deviceToken!
}

export const authed = (world: World, path: string, token: string, method = 'GET') =>
  call(world, path, { method, headers: { authorization: `Bearer ${token}` } })

export const uniq = () => crypto.randomUUID().slice(0, 8)
