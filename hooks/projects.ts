import type { RangeStep } from '../types'
import type { Increment } from './range'

/** Tags on a step that aren't folder names: a desktop chat, and a response synced from another device. Colons can't appear in a Windows folder name and rarely elsewhere. */
export const CHATS = ':chats'
export const OTHER_DEVICE = ':device'

/**
 * The project a session's root folder stands for: its base name; a worktree under <repo>/.claude/worktrees/<name> counts as <repo>;
 * the desktop app's scratch workspaces (a path containing /Claude/scratch-workspaces/, any slash direction, case-insensitive) are CHATS.
 * Handles both / and \ separators and a trailing slash.
 */
export function projectName(root: string): string {
  const path = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/\/claude\/scratch-workspaces\//i.test(path + '/')) return CHATS
  const repo = /^(.*)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/i.exec(path)?.[1] ?? path
  const i = repo.lastIndexOf('/')
  return repo.slice(i + 1) || repo
}

export type OtherPart = 'chats' | 'devices' | 'before' | 'away'

export type ProjectSplit = {
  /** % of the weekly limit used this window (= pct). */
  used: number
  /** Real projects, largest first, in % of the weekly limit. */
  rows: Array<{ name: string; pct: number }>
  /**
   * % each: chats = CHATS steps, devices = OTHER_DEVICE steps, before = steps with no project (recorded before 1.4),
   * away = rises with no responses behind them, rises over unwatched gaps, and whatever of `used` the record doesn't cover.
   */
  other: Record<OtherPart, number>
  otherTotal: number
  /** 100 − used, never below 0. */
  unused: number
}

const PARTS: Record<string, OtherPart> = { [CHATS]: 'chats', [OTHER_DEVICE]: 'devices' }

/**
 * The window's use split by project. `incs` are the weekly increments; only the part inside [from, now] counts,
 * an increment straddling either end pro-rated as usedBetween does. Each rise seen while watching is shared among
 * the responses made since the reading before it, by their units × their model's weight, the same rule as refine.
 * A rise with no responses behind it, or over a gap, goes to away. Rises adding up to more than `used` are scaled
 * down to it; to less, the rest is away. rows + otherTotal + unused = 100.
 */
export function projectSplit(incs: readonly Increment[], steps: readonly RangeStep[], weightOf: (model: string) => number, from: number, now: number, used: number): ProjectSplit {
  const sorted = [...steps].sort((a, b) => a[0] - b[0])
  const by = new Map<string, number>()
  const other: Record<OtherPart, number> = { chats: 0, devices: 0, before: 0, away: 0 }
  const add = (key: string, v: number) => by.set(key, (by.get(key) ?? 0) + v)
  let total = 0
  for (const inc of incs) {
    const overlap = Math.min(inc.end, now) - Math.max(inc.start, from)
    if (overlap <= 0) continue
    const amount = inc.amount * Math.min(1, overlap / (inc.end - inc.start))
    total += amount
    if (inc.hole || inc.from === undefined) { other.away += amount; continue }
    // the responses in (inc.from, inc.end]
    let lo = 0, hi = sorted.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m]![0] <= inc.from) lo = m + 1; else hi = m }
    const shares: Array<[string, number]> = []
    let weight = 0
    for (let i = lo; i < sorted.length && sorted[i]![0] <= inc.end; i++) {
      const s = sorted[i]!
      const w = s[3] * weightOf(s[1])
      if (!(w > 0)) continue
      shares.push([s[5] ?? '', w])
      weight += w
    }
    if (weight <= 0) { other.away += amount; continue }
    for (const [key, w] of shares) add(key, amount * w / weight)
  }
  // the record may cover more or less than the figure: scale down to it, or the rest is away
  const scale = total > used && total > 0 ? used / total : 1
  other.away = other.away * scale + Math.max(0, used - total)
  const rows: Array<{ name: string; pct: number }> = []
  for (const [key, v] of by) {
    const pct = v * scale
    if (key === '') other.before += pct
    else if (PARTS[key]) other[PARTS[key]!] += pct
    else rows.push({ name: key, pct })
  }
  rows.sort((a, b) => b.pct - a.pct || (a.name < b.name ? -1 : 1))
  const otherTotal = other.chats + other.devices + other.before + other.away
  return { used, rows, other, otherTotal, unused: Math.max(0, 100 - used) }
}

/** What each part of Other counts, for the pane and the README. */
export const OTHER_INFO: Record<OtherPart, { label: string; text: string }> = {
  chats: { label: 'Desktop chats', text: "Conversations in the desktop app's chat, which run in a temporary folder rather than a project." },
  devices: { label: 'Other devices', text: 'Responses synced from your other computers. Their project names stay there.' },
  before: { label: 'Before 1.4', text: 'Responses recorded before projects were tracked.' },
  away: { label: 'Away', text: 'Usage with no responses seen: claude.ai in a browser, the phone app, or a device without the plugin.' },
}
