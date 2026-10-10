import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // test-only values; real secrets come from .dev.vars / `wrangler secret put`
          bindings: {
            PUBLIC_URL: 'http://localhost:8787',
            GOOGLE_CLIENT_ID: 'test-google-id',
            GOOGLE_CLIENT_SECRET: 'test-google-secret',
            GITHUB_CLIENT_ID: 'test-github-id',
            GITHUB_CLIENT_SECRET: 'test-github-secret',
            ACCOUNT_HASH_KEY: 'test-account-hash-key',
            SESSION_KEY: 'test-session-key',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.ts'] },
  }
})
