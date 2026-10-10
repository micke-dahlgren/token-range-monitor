// Stores the OAuth secrets from a .env file with `wrangler secret put`, without
// printing them or going through a paste prompt.
// Usage (from server/): node scripts/secrets-from-env.mjs [path/to/.env]
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const NAMES = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
const file = process.argv[2] ?? '../.env'

const values = {}
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
  if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
}

const missing = NAMES.filter(n => !values[n])
if (missing.length) {
  console.error(`Missing in ${file}: ${missing.join(', ')}`)
  process.exit(1)
}

for (const name of NAMES) {
  const v = values[name]
  // shown so a wrong value is noticeable, never the secret itself
  console.log(`${name}: ${v.length} characters`)
  execSync(`bunx wrangler secret put ${name}`, { input: v, stdio: ['pipe', 'inherit', 'inherit'], shell: true })
}
