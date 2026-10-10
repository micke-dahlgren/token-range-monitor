# Token Range Monitor sync server

Optional sync backend for the Token Range Monitor Claude Code mod: a Cloudflare
Worker with a D1 database, on the free tier. Users link each Claude Code install
once by signing in with Google or GitHub; their usage-limit lists then sync
between their devices.

**Phase 1 (this code):** schema, device-link flow, Google + GitHub sign-in,
account linking by verified email, device/account management.
**Phase 2 (later):** the `/v1/lists` sync API (its `lists` table already exists).

## Endpoints

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/link/start` `{ deviceName? }` | none | Starts linking. Returns `{ code, url, pollToken, expiresIn, interval }`. Codes are `XXXX-XXXX`, live 10 minutes. |
| `POST /v1/link/poll` `{ pollToken }` | none | `{status:"pending"}`, `{status:"expired"}`, or once (only once) `{status:"ok", deviceToken, email}`. |
| `GET /link?code=` | browser | Page with the code and "Continue with Google / GitHub". |
| `GET /auth/{google,github}/start?code=` | browser | Redirects to the provider with a signed state cookie. |
| `GET /auth/{google,github}/callback` | browser | Finishes sign-in, attaches the user to the code, shows the success page. |
| `GET /v1/me` | `Bearer <deviceToken>` | `{ email, providers, devices:[{id,name,lastSeenAt,current}] }` |
| `DELETE /v1/device` | Bearer | Unlinks the calling device. |
| `DELETE /v1/me` | Bearer | Deletes the user, identities, devices and lists. |
| `GET /privacy`, `GET /` | none | Privacy policy, landing page. |

Anything else is `404 {"error":"not_found"}`. All timestamps are milliseconds.

The mod's flow: call `start`, show the user `code` and open `url`, then call
`poll` every `interval` seconds until it returns `ok` (store `deviceToken`) or
`expired` (start over).

### Account linking

A sign-in resolves to a user like this: an identity seen before → its user;
otherwise a user already holding an identity with the **same verified email** →
the new identity is attached to it; otherwise a new user. Google sign-ins require
`email_verified`; GitHub uses the account's primary email and refuses it unless
verified. Emails are compared lower-cased.

### Security notes

- Only SHA-256 hashes of poll tokens and device tokens are stored.
- OAuth uses the authorization-code flow with PKCE (S256) and a state cookie
  (`HttpOnly; Secure; SameSite=Lax; Path=/auth/`, 10 min) HMAC-signed with
  `SESSION_KEY`, carrying the link code, provider, nonce (= `state` param), PKCE
  verifier and expiry.
- Request bodies are capped at 256 KB (413).
- `POST /v1/link/start` is rate-limited to 10 codes per IP per 10 minutes (429).
  It counts rows in `link_codes` by `ip_hash` (an HMAC of the client IP keyed
  with `SESSION_KEY`; raw IPs are never stored), so the limit holds across
  isolates. A daily cron deletes link codes an hour after they expire.
- HTML pages send a strict CSP (no scripts), `Referrer-Policy: no-referrer`.

## Secrets

| Name | What |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client (type "Web application"). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth App. |
| `ACCOUNT_HASH_KEY` | HMAC key for hashing Claude account ids (`<accountUuid>.<orgUuid>`); used by Phase 2. **Never rotate once lists are stored**: their keys derive from it. |
| `SESSION_KEY` | HMAC key for the state cookie and the rate-limit IP hash. Rotating it only invalidates sign-ins in progress. |

Generate the two keys with e.g. `openssl rand -base64 32`. A provider whose
client id/secret (or `SESSION_KEY`) is missing shows as "not configured" on the
link page, so you can develop with only one of them set up.

`PUBLIC_URL` (a plain var in `wrangler.toml`, overridden in `.dev.vars`) is the
public origin without a trailing slash; the link URL and OAuth redirect URIs are
built from it.

## Redirect URIs to register

| Provider | Local dev | Production |
| --- | --- | --- |
| Google (Authorized redirect URIs) | `http://localhost:8787/auth/google/callback` | `https://token-range-monitor.<your-subdomain>.workers.dev/auth/google/callback` |
| GitHub (Authorization callback URL) | `http://localhost:8787/auth/github/callback` | `https://token-range-monitor.<your-subdomain>.workers.dev/auth/github/callback` |

Google and GitHub both accept several redirect URIs per client/app, so one
Google client and one GitHub OAuth App can each serve local dev and production. Google also needs the
OAuth consent screen filled in, with `<PUBLIC_URL>/privacy` as the privacy
policy link; the scopes used (`openid email profile`) are non-sensitive.

## Local development

```sh
cd server
bun install
cp .dev.vars.example .dev.vars     # then fill in the values (dev OAuth clients, random keys)
bun run db:migrate:local           # creates the local D1 in .wrangler/
bun run dev                        # http://localhost:8787
```

Try it: `curl -X POST localhost:8787/v1/link/start -d '{"deviceName":"test"}'`,
open the returned `url`, sign in, then
`curl -X POST localhost:8787/v1/link/poll -d '{"pollToken":"..."}'`.

Checks:

```sh
bun run typecheck
bun run test         # vitest inside workerd with a fresh local D1, migrations applied; providers are faked
```

## Deploy

```sh
cd server
bunx wrangler login
bunx wrangler d1 create token-range-monitor
#   paste the printed database_id into wrangler.toml (replacing REPLACE_AFTER_wrangler_d1_create)
#   set PUBLIC_URL in wrangler.toml to https://token-range-monitor.<your-subdomain>.workers.dev
bun run db:migrate:remote
bunx wrangler secret put GOOGLE_CLIENT_ID
bunx wrangler secret put GOOGLE_CLIENT_SECRET
bunx wrangler secret put GITHUB_CLIENT_ID
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put ACCOUNT_HASH_KEY
bunx wrangler secret put SESSION_KEY
bun run deploy
```

Then register the production redirect URIs above and open
`<PUBLIC_URL>/link?code=...` from a real `POST /v1/link/start` to verify.
