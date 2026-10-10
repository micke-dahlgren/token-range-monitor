/** Small self-contained HTML pages (no external scripts, styles or fonts). */

export const REPO_URL = 'https://github.com/micke-dahlgren/token-range-monitor'

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const CSS = `
:root{--bg:#f6f6f4;--card:#fff;--text:#1d1d1b;--muted:#6b6b66;--border:#e3e2dd;--accent:#c96442;--btn:#fff;--btn-hover:#f0efea;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b19;--card:#262624;--text:#ececea;--muted:#a3a39d;--border:#3a3a37;--accent:#e08a68;--btn:#2f2f2c;--btn-hover:#383835}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px 24px}
main.wide{max-width:640px}
h1{font-size:1.25rem;margin:0 0 8px}
h2{font-size:1rem;margin:20px 0 4px}
p,li{color:var(--muted);margin:0 0 12px}
a{color:var(--accent)}
.code{font:600 1.9rem/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.12em;text-align:center;padding:14px;margin:16px 0;border:1px dashed var(--border);border-radius:10px;color:var(--text)}
.btn{display:block;text-align:center;text-decoration:none;color:var(--text);background:var(--btn);border:1px solid var(--border);border-radius:10px;padding:12px;margin:10px 0;font-weight:600}
.btn:hover{background:var(--btn-hover)}
.btn.off{opacity:.45;pointer-events:none}
.small{font-size:.85rem}
.ok{color:var(--text)}
`

function layout(title: string, body: string, wide = false): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Token Range Monitor</title><style>${CSS}</style></head>
<body><main${wide ? ' class="wide"' : ''}>${body}</main></body></html>`
}

export function linkPage(displayCode: string, enabled: { google: boolean; github: boolean }): string {
  const q = `?code=${encodeURIComponent(displayCode)}`
  const btn = (href: string, label: string, on: boolean) => `<a class="btn${on ? '' : ' off'}" href="${on ? escapeHtml(href) : '#'}">${label}${on ? '' : ' (not configured)'}</a>`
  return layout(
    'Link device',
    `<h1>Link Claude Code to your account</h1>
<p>Check that this code matches the one shown in Claude Code:</p>
<div class="code">${escapeHtml(displayCode)}</div>
${btn(`/auth/google/start${q}`, 'Continue with Google', enabled.google)}
${btn(`/auth/github/start${q}`, 'Continue with GitHub', enabled.github)}
<p class="small">Only continue if you started this from your own Claude Code. Signing in links that install to your account so your Token Range Monitor history syncs across devices. <a href="/privacy">Privacy</a></p>`,
  )
}

export const successPage = (email: string) =>
  layout('Device linked', `<h1>Device linked</h1><p class="ok">Device linked as <strong>${escapeHtml(email)}</strong>. You can close this tab and return to Claude Code.</p>`)

export const messagePage = (title: string, text: string) =>
  layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p class="small"><a href="/">Token Range Monitor</a></p>`)

export const landingPage = () =>
  layout(
    'Sync',
    `<h1>Token Range Monitor sync</h1>
<p>This is the sync service for <a href="${REPO_URL}">Token Range Monitor</a>, a Claude Code mod. There is nothing to do here: sign-in starts from inside Claude Code.</p>
<p class="small"><a href="/privacy">Privacy policy</a></p>`,
  )

export const privacyPage = () =>
  layout(
    'Privacy',
    `<h1>Privacy policy</h1>
<p>Token Range Monitor sync is an optional, free service for the open-source <a href="${REPO_URL}">Token Range Monitor</a> Claude Code mod. It stores only what it needs to sync your history between your own devices.</p>
<h2>What is stored</h2>
<ul>
<li>Your email address and the account id from the provider you sign in with (Google or GitHub). We request only your basic profile and email; no other data from those accounts is read or kept.</li>
<li>For each linked device: a name, when it was linked and last seen, and a hash of its access token.</li>
<li>Your usage-limit history recorded by the mod (readings of your Claude plan's usage limits, the time spans watched, and per-response model and token counts), filed under a keyed hash of your Claude account id rather than the id itself.</li>
</ul>
<h2>What is not stored</h2>
<p>No prompts, conversations, code or files. No passwords. No tracking, analytics or ads. Data is never sold or shared, except with Cloudflare, which hosts the service.</p>
<h2>Retention and deletion</h2>
<p>Sign-in codes expire after 10 minutes and are removed within a day. Usage history is kept while your account exists and old entries are pruned over time. You can unlink a device, or delete your account and everything stored for it, at any time from the mod's settings in Claude Code; deletion is immediate.</p>
<h2>Contact</h2>
<p>Questions: open an issue at <a href="${REPO_URL}/issues">${REPO_URL.replace('https://', '')}</a>.</p>`,
    true,
  )
