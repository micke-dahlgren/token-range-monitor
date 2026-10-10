# Token Range Monitor sync server

Optional sync backend for the Token Range Monitor Claude Code mod: a Cloudflare
Worker with a D1 database, on the free tier. Users link each Claude Code install
once by signing in with Google or GitHub; their usage-limit lists then sync
between their devices.

**Phase 1:** schema, device-link flow, Google + GitHub sign-in, account
linking by verified email, device/account management.
**Phase 2:** the `/v1/lists` sync API, device expiry (90 days unused), list
retention (15 days), per-device rate limiting.

> **Deploying this version:** run `bun run db:migrate:remote` (applies
> `migrations/0002_lists_sync.sql`) **before** `bun run deploy`. The new code
> writes `lists.device_id`, which only exists after the migration.

## Endpoints

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/link/start` `{ deviceName? }` | none | Starts linking. Returns `{ code, url, pollToken, expiresIn, interval }`. Codes are `XXXX-XXXX`, live 10 minutes. |
| `POST /v1/link/poll` `{ pollToken }` | none | `{status:"pending"}`, `{status:"expired"}`, or once (only once) `{status:"ok", deviceToken, email}`. |
| `GET /link` | browser | The sign-in page: a code field and "Continue with Google / GitHub" (one form). Sets the CSRF cookie. Any `?code=` is ignored. |
| `POST /link` (form: `code`, `provider`, `csrf`) | browser | Checks CSRF, the per-IP attempt limit and the typed code, then redirects to the provider with a signed state cookie. |
| `GET /auth/{google,github}/callback` | browser | Finishes sign-in, attaches the user to the code, shows the success page. |
| `GET /v1/me` | `Bearer <deviceToken>` | `{ email, providers, devices:[{id,name,createdAt,lastSeenAt,current}] }` (devices oldest link first) |
| `PUT /v1/device` `{ name }` | Bearer | Sets the calling device's display name: control characters stripped, trimmed, 1–64 characters, else `400 invalid_name`. → `{ ok: true, name }` |
| `DELETE /v1/device` | Bearer | Unlinks the calling device (sign out). Its lists stay. |
| `DELETE /v1/devices/:id` | Bearer | Removes one of the caller's devices: its token stops working at once and the lists it uploaded (`lists.device_id`) are deleted. → `{ ok: true, listsDeleted }`. An unknown id and another user's device both answer `404 {"error":"not_found"}`. The caller's own id behaves exactly like `DELETE /v1/device` (its lists stay). |
| `DELETE /v1/me` | Bearer | Deletes the user, identities, devices and lists. |
| `PUT /v1/lists` | Bearer | Uploads lists for one Claude account. See [Lists sync](#lists-sync). |
| `GET /v1/lists?account=&since=` | Bearer | Lists of one Claude account changed since a cursor. |
| `GET /privacy`, `GET /` | none | Privacy policy, landing page. |

Anything else is `404 {"error":"not_found"}`. All timestamps are milliseconds.

The mod's flow: call `start`, show the user `code` and `url` (`<PUBLIC_URL>/link`,
never with the code in it), then call `poll` every `interval` seconds until it
returns `ok` (store `deviceToken`) or `expired` (start over). In the browser the
user opens `/link`, **types** the code and picks Google or GitHub; see
[Device sign-in](#device-sign-in-typed-code).

## Device sign-in (typed code)

1. The mod calls `POST /v1/link/start` and shows `code` (`XXXX-XXXX`) and `url`
   (`<PUBLIC_URL>/link`).
2. `GET /link` shows a form: one code field (`autocomplete="one-time-code"`,
   `autocapitalize="characters"`, autofocus; accepts `XXXX-XXXX` or `XXXXXXXX`,
   any case, spaces ignored) and two submit buttons, Continue with Google /
   GitHub (a provider not configured is disabled). It sets the CSRF cookie and
   puts `HMAC-SHA256(SESSION_KEY, "csrf:" + token)` in a hidden field. An
   existing valid cookie is reused, so several open tabs keep working.
3. `POST /link` checks, in order:
   - CSRF: the cookie must be present and the hidden field must equal its HMAC
     (constant-time compare). Otherwise `403` "This sign-in page expired, please
     reload…" and no OAuth state cookie.
   - The attempt limit (`CODE_LIMITER`, 10 per 60 s per IP). Otherwise `429`
     with the form and "Too many attempts, wait a minute.", `retry-after: 60`.
   - The code: it must exist, be unexpired, unclaimed and not yet signed in.
     Otherwise `400` with the form and one message for every kind of failure:
     "That code isn't valid or has expired. Check Claude Code for the current code."
   - Then exactly the old start step: signed state cookie + PKCE, `302` to the
     provider. The callback is unchanged.

**CSRF cookie:** over https `__Host-trm_csrf=<random 32 bytes>; Path=/; HttpOnly;
Secure; SameSite=Strict; Max-Age=900`. When `PUBLIC_URL` is plain `http://`
(local dev on `http://localhost:8787`) it is `trm_csrf` with the same
attributes but without `Secure`, since browsers may refuse `Secure` and
`__Host-` cookies over http.

**CSP of `/link`:** like every page (`default-src 'none'`, no scripts), except
`form-action 'self' https://accounts.google.com https://github.com`. Browsers
apply `form-action` to the redirect that follows a form POST too, so the
providers' authorize origins must be listed or the 302 is blocked. All other
pages keep `form-action 'none'`.

**Why:** with the code in the link, someone could start a link on *their*
machine and send the victim the URL; the victim signs in and the attacker's
device is linked to the victim's account. Anything in a URL, or in a form
another site auto-submits, is attacker-controlled. Now the code is never in a
URL, OAuth only starts from `POST /link` (there is no `GET` route that starts it:
`/auth/{google,github}/start` are gone and answer 404), a cross-site POST lacks
the `SameSite=Strict` cookie and cannot read the hidden field, and the user has
to type a code they read in their own Claude Code. As a safety net, the mod
lists the account's devices with a Remove button (`GET /v1/me`,
`DELETE /v1/devices/:id`).

**Guessing codes:** codes are 8 symbols from a 32-symbol alphabet (2^40 ≈ 1.1 × 10^12
values) and live 10 minutes. With 10 attempts per minute per IP an attacker gets
100 guesses per IP per code lifetime; even with, say, 10,000 codes open at once,
the chance that one IP hits any of them in 10 minutes is about
100 × 10,000 / 2^40 ≈ 1 in a million (1,000 IPs: about 1 in a thousand per
10 minutes of sustained effort). A hit would sign that someone else's pending
device into the guesser's account (its owner would see "Synced as <their
email>" in the pane, and the device would show in the guesser's device list);
it never gives access to the victim's account. The limiter is per Cloudflare location and eventually
consistent, so treat 10/min as approximate; the margin is several orders of
magnitude.

Bearer-authenticated endpoints answer `401 {"error":"unauthorized"}` for a
missing or unknown token, and `401 {"error":"device_expired","message":...}` for
a device unused for 90 days (it is deleted at that moment, so later calls get
`unauthorized`). Either way the mod should drop its token and offer to link
again. Error bodies are `{ error, message? }`: `error` is a stable code,
`message` (when present) a human-readable explanation.

## Lists sync

Each device uploads one list per day: key `d:<device>-<day>`, data the mod's
`[readings, watched spans, steps]` for that day (the server only checks it is a
JSON array). A day's list stops changing once the day is over, so it is
uploaded for the last time then, and an active device writes one list per
sync. The Claude account (`<accountUuid>.<orgUuid>`) goes in `account`. The server stores
`HMAC-SHA256(ACCOUNT_HASH_KEY, "account:" + account)`, never the account id.

### `PUT /v1/lists`

```json
{ "account": "<accountUuid>.<orgUuid>",
  "lists": [ { "key": "d:lx3k2a9fz-20261010",
               "data": [ [[1760000000000, 0, 42, 1760003600000]],
                         [[1760000000000, 1760000300000]],
                         [[1760000000000, "claude-opus-5-5", "high", 123, 0]] ] } ] }
```

→ `200 { "ok": true, "stored": 1 }`. Each list is upserted under
(user, account hash, key) with `updated_at` = server time and the calling
device; the last write wins (each key is owned by one device, so in practice
there are no conflicts). A key repeated within one request keeps its last
occurrence. Send only the lists that changed since the last successful PUT.

| Limit | Error |
| --- | --- |
| `account`: non-empty string, ≤ 200 chars | 400 `missing_account` / `invalid_account` |
| `lists`: array of ≤ 50 entries | 400 `invalid_lists` / 413 `too_many_lists` |
| `key` matches `^d:[A-Za-z0-9._-]{1,80}$` | 400 `invalid_key` |
| `data` is a JSON array | 400 `invalid_data` |
| `JSON.stringify(data)` ≤ 128 KB | 413 `list_too_large` |
| request body ≤ 256 KB | 413 `body_too_large` |
| ≤ 500 stored lists per (user, Claude account) | 413 `list_quota_exceeded` (with `message`) |
| 60 requests / 60 s per device (GET and PUT together) | 429 `rate_limited`, `retry-after: 60` |

A rejected request stores nothing. The quota only blocks *new* keys: lists
already stored can always be updated, and lists not updated for 15 days are
deleted daily, which frees room.

### `GET /v1/lists?account=<accountUuid>.<orgUuid>&since=<cursor>`

→ `200 { "lists": [ { "key", "data", "updatedAt" } ], "cursor": "<opaque>", "more": false }`

- No `since`: everything stored for that user + account. With `since`: what
  changed after that cursor.
- Lists come in (`updatedAt`, `key`) order. A page holds at most 500 lists and
  stops adding lists once their data reaches 512 KB (one list is always
  returned), so a response stays well under 1 MB.
- `more: true`: call again **straight away** with the returned `cursor`.
  These page boundaries are exact (a compound `updatedAt` + `key` position), so
  a sequence of pages returns every list exactly once and terminates even when
  thousands of lists share one timestamp.
- `more: false`: keep the returned `cursor` for the next poll. This final
  cursor deliberately reaches back **10 s before the sequence's first page**,
  so a PUT whose timestamp was taken before the read but committed after it
  (or that ran on a worker with a slightly late clock) is still seen.
  Consequence: lists updated within ~10 s before a poll come again on the next
  poll. The mod merges and de-duplicates, so repeats are harmless.
- The cursor is opaque (base64url). A malformed one is `400 invalid_cursor`;
  on that, drop the cursor and do a full GET.
- A missing `account` is `400 missing_account`. `updatedAt` is server time in ms.

### Rate limiting

`POST /link` (typing a link code) uses a second binding, `CODE_LIMITER`
(`namespace_id = "1002"`, 10 requests per 60 s), keyed by an HMAC of the client
IP. It is checked after the CSRF check and before the code lookup, and costs no
D1 writes. Without the binding code entry is not rate-limited.

`/v1/lists` uses the Workers Rate Limiting binding `LISTS_LIMITER`
(`[[ratelimits]]` in `wrangler.toml`): 60 requests per 60 s, keyed by device
id, checked after authentication. It costs no D1 writes. Cloudflare keeps its
counters per location and eventually consistent, so it guards against runaway
clients rather than enforcing an exact quota. Miniflare implements the binding,
so the tests exercise it locally. Without the binding the endpoints are not
rate-limited.

### Retention and device expiry

- Each authenticated request reads the device row; `last_seen_at` is only
  rewritten when it is more than an hour old (≤ 24 writes per device per day).
- A device whose `last_seen_at` is more than 90 days old is rejected with
  `device_expired` and deleted.
- The daily cron (`17 3 * * *` UTC) deletes link codes an hour after expiry,
  lists not updated for 15 days (the mod learns from the last 14), and devices unused for
  90 days. Each step runs in bounded batches (lists: up to 50 × 1000 per run,
  walking the table by rowid; devices: up to 20 × 500). Anything left over
  goes the next day, and a failing step does not stop the others.
- `DELETE /v1/me` removes the user's lists together with everything else.

### Free-tier cost per sync

D1 free tier: 5 M rows read and 100 k rows written per day; Workers: 100 k
requests per day. In D1 an index on a written column costs an extra row write,
so `lists` has only the indexes the API needs (the daily purge scans instead).
Approximate cost of one sync cycle (the mod's plan: PUT today's list only if it
changed, then GET with its cursor, every 10 minutes per active device):

| Step | Rows read | Rows written |
| --- | --- | --- |
| Auth (each request) | 1 | at most 1 per hour |
| PUT of today's list | ~1 (existence check) | ~2 (row + sync index), ~3 the first time each day |
| PUT bringing a new key (once per device per day) | + up to 500 (quota count) | |
| GET | about the lists returned, +1 | 0 |

A typical cycle: 2 requests, a few rows read, ~2 rows written. A device active
8 hours a day (~50 cycles) costs ~100 requests and ~100 writes a day, and
nothing while idle (no change, no PUT). Writes are the binding limit: roughly
1,000 active devices a day fit the free tier (100 k writes), and the $5 plan's
50 M writes a month cover ~15,000. A first full sync reads each stored list
once (at most 500 rows). The daily purge reads the `lists` table about once and
writes per deleted list.
These are estimates from D1's documented billing rules, not measurements.

### Account linking

A sign-in resolves to a user like this: an identity seen before → its user;
otherwise a user already holding an identity with the **same verified email** →
the new identity is attached to it; otherwise a new user. Google sign-ins require
`email_verified`; GitHub uses the account's primary email and refuses it unless
verified. Emails are compared lower-cased.

### Security notes

- Only SHA-256 hashes of poll tokens and device tokens are stored.
- The link code is typed on `/link`, never carried in a URL; OAuth starts only
  from `POST /link` behind a `SameSite=Strict` CSRF cookie + HMAC'd hidden field
  and a per-IP attempt limit (`CODE_LIMITER`). See
  [Device sign-in](#device-sign-in-typed-code).
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
| `ACCOUNT_HASH_KEY` | HMAC key for hashing Claude account ids (`<accountUuid>.<orgUuid>`) in `/v1/lists`. **Never rotate once lists are stored**: their keys derive from it. Without it `/v1/lists` answers `503 not_configured`. |
| `SESSION_KEY` | HMAC key for the state cookie, the sign-in page's CSRF field and the rate-limit IP hash. Rotating it only invalidates sign-ins in progress. |

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
open the returned `url` (`http://localhost:8787/link`), type the returned `code`, sign in, then
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

Then register the production redirect URIs above, do a real `POST /v1/link/start`,
open `<PUBLIC_URL>/link` and type the code to verify.

### Upgrading an existing deployment

Apply new migrations before deploying code that needs them:

```sh
cd server
bun run db:migrate:remote   # applies any pending migrations, e.g. 0002_lists_sync.sql
bun run deploy
```

The `[[ratelimits]]` bindings' `namespace_id`s (`1001` for `LISTS_LIMITER`,
`1002` for `CODE_LIMITER`) must be unique within your Cloudflare account; change
them if they clash with another Worker's.
