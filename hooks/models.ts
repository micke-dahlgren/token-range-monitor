import type { RangeReading, RangeStep } from '../types'
import { DAY, KEEP, isWatched, ofKind, usedBetween } from './range'
import type { Model, Watch } from './range'

/**
 * What each model costs, learned from this account's own history.
 *
 * Every response reports its model and tokens. Between two readings of the
 * weekly limit the plugin knows how far the limit rose and which models did
 * the work then, so over many such stretches it can solve for each model's
 * weight: rise ≈ Σ w·T. Within a model, its token kinds are combined at that
 * model's published price ratios (UNITS), so only the weight across models is
 * learned. A model's cost shows once its weight is known within ±SHOW_WITHIN.
 */

/** A response's tokens, weighted as a model's price list weighs them: input 1, output 5, cache writes 1.25, cache reads 0.1. */
export const units = (u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) =>
  u.input_tokens + 5 * u.output_tokens + 1.25 * u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens

/** How far back the costs are learned from. */
export const LEARN_SPAN = 14 * DAY
/** A cost shows once its 90% range is within this share of it. */
export const SHOW_WITHIN = 0.2
/** And once this many stretches had the model in them: a few stretches can fit too well by chance. */
const MIN_STRETCHES = 5
/** z for a 90% range. */
const Z90 = 1.645

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const
export type Family = (typeof FAMILIES)[number] | 'other'

/** A model's name and family from its id: `claude-opus-5-5` is Opus 5.5, `claude-3-5-sonnet-20241022` Sonnet 3.5. */
export function modelName(id: string): { name: string; family: Family; version: number[] } {
  const parts = id.toLowerCase().replace(/\[.*\]$/, '').replace(/^claude-/, '').split('-').filter(p => !/^\d{8}$/.test(p) && p !== 'latest')
  const family = (FAMILIES as readonly string[]).find(f => parts.includes(f)) as Family | undefined
  const version = parts.filter(p => /^\d{1,2}$/.test(p)).map(Number)
  if (!family) return { name: id, family: 'other', version }
  const title = family[0]!.toUpperCase() + family.slice(1)
  return { name: version.length ? `${title} ${version.join('.')}` : title, family, version }
}

/** Fable, Opus, Sonnet, Haiku, then the rest; newest version first within a family. */
function byRank(a: string, b: string) {
  const A = modelName(a), B = modelName(b)
  const rank = (f: Family) => (f === 'other' ? 9 : FAMILIES.indexOf(f))
  if (rank(A.family) !== rank(B.family)) return rank(A.family) - rank(B.family)
  for (let i = 0; i < Math.max(A.version.length, B.version.length); i++) {
    const d = (B.version[i] ?? 0) - (A.version[i] ?? 0)
    if (d) return d
  }
  return a.localeCompare(b)
}

export type ModelCost = {
  id: string
  name: string
  family: Family
  /** Weekly points per million weighted tokens; 0 until anything is known. */
  w: number
  /** The 90% range as a share of `w`: Infinity while nothing is known. */
  rel: number
  shown: boolean
  /** Responses in the learning span, and how many of them subagents made. */
  responses: number
  sub: number
  /** About how many more responses until it shows; 0 once it does or when it can't be told. */
  more: number
}

export type Learned = {
  models: ModelCost[]
  /** When the first stretch learned from began (ms), or null with none yet. */
  since: number | null
}

/** Solves the normal equations A·x = b (A symmetric, small) and gives A's inverse too; null when A is singular. */
function solve(A: number[][], b: number[]): { x: number[]; inv: number[][] } | null {
  const n = b.length
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)), b[i]!])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r
    if (Math.abs(M[p]![c]!) < 1e-12) return null
    ;[M[c], M[p]] = [M[p]!, M[c]!]
    const d = M[c]![c]!
    for (let k = 0; k <= 2 * n; k++) M[c]![k]! /= d
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r]![c]!
      if (f) for (let k = 0; k <= 2 * n; k++) M[r]![k]! -= f * M[c]![k]!
    }
  }
  return { x: M.map(r => r[2 * n]!), inv: M.map(r => r.slice(n, 2 * n)) }
}

/**
 * Each model's weight from the stretches between weekly readings that this
 * computer watched whole, and how sure that weight is. Weights can't go
 * below zero: a model whose best fit is negative is left out and refitted.
 */
export function learn(readings: readonly RangeReading[], steps: readonly RangeStep[], seen: readonly Watch[], now: number): Learned {
  const from = now - LEARN_SPAN
  const recent = steps.filter(s => s[0] >= from && s[0] <= now)
  const ids = [...new Set(recent.map(s => s[1]))].sort(byRank)
  const weeks = ofKind(readings, 'week').filter(r => r[0] >= from)
  const sorted = [...recent].sort((a, b) => a[0] - b[0])

  // the stretches: how far the limit rose, and each model's tokens (in millions) meanwhile
  const rows: Array<{ y: number; x: number[] }> = []
  let since: number | null = null
  for (let i = 1; i < weeks.length; i++) {
    const a = weeks[i - 1]!, b = weeks[i]!
    // a reset in between, or a gap nobody here watched: usage from elsewhere would count against these models
    if (Math.abs(a[3] - b[3]) > 5 * 60_000 || !isWatched(seen, a[0], b[0])) continue
    const y = b[2] - a[2]
    if (y < 0) continue
    const x = ids.map(() => 0)
    for (const s of sorted) if (s[0] > a[0] && s[0] <= b[0]) x[ids.indexOf(s[1])]! += s[3] / 1e6
    if (x.every(v => v === 0)) continue
    rows.push({ y, x })
    since ??= a[0]
  }

  // least squares over the models still in, dropping the most negative until none is
  let active = ids.map((_, i) => i).filter(i => rows.some(r => r.x[i]! > 0))
  let fit: { x: number[]; inv: number[][] } | null = null
  while (active.length) {
    const A = active.map(i => active.map(j => rows.reduce((s, r) => s + r.x[i]! * r.x[j]!, 0)))
    const b = active.map(i => rows.reduce((s, r) => s + r.x[i]! * r.y, 0))
    fit = solve(A, b)
    if (!fit) break
    const worst = fit.x.reduce((k, v, j) => (v < (fit!.x[k] ?? 0) ? j : k), 0)
    if (fit.x[worst]! >= 0) break
    active = active.filter((_, j) => j !== worst)
    fit = null
  }
  const w = ids.map(() => 0), rel = ids.map(() => Infinity)
  if (fit && rows.length > active.length) {
    active.forEach((i, j) => { w[i] = fit!.x[j]! })
    const rss = rows.reduce((s, r) => s + (r.y - r.x.reduce((t, v, i) => t + v * w[i]!, 0)) ** 2, 0)
    // the readings are whole points: never trust a fit closer than that rounding allows
    const s2 = Math.max(rss / (rows.length - active.length), 1 / 12)
    active.forEach((i, j) => {
      if (w[i]! > 0) rel[i] = Z90 * Math.sqrt(s2 * fit!.inv[j]![j]!) / w[i]!
    })
  }

  return {
    since,
    models: ids.map((id, i) => {
      const mine = recent.filter(s => s[1] === id)
      const stretches = rows.filter(r => r.x[i]! > 0).length
      const shown = rel[i]! <= SHOW_WITHIN && stretches >= MIN_STRETCHES
      // the range narrows about as the square root of what's behind it
      const more = shown || !isFinite(rel[i]!) ? 0 : Math.max(1, Math.ceil(mine.length * ((rel[i]! / SHOW_WITHIN) ** 2 - 1)))
      return { id, ...modelName(id), w: w[i]!, rel: rel[i]!, shown, responses: mine.length, sub: mine.filter(s => s[4]).length, more }
    }),
  }
}

/** The model the others compare to: the one picked, else the newest Sonnet shown, else the most used shown. Null under two shown. */
export function baselineOf(l: Learned, picked: string | undefined): ModelCost | null {
  const shown = l.models.filter(m => m.shown)
  if (shown.length < 2) return null
  return shown.find(m => m.id === picked) ?? shown.find(m => m.family === 'sonnet') ?? [...shown].sort((a, b) => b.responses - a.responses)[0]!
}

export type Spend = {
  /** % of the weekly limit used. */
  week: number
  /** Points per shown model, split by effort (largest first). */
  models: Array<{ cost: ModelCost; pts: number; effort: Array<[string, number]> }>
  /** Recorded here, but by models whose cost isn't known yet. */
  unsplit: number
  /** Used where this computer wasn't watching. */
  away: number
}

/** This week's points by model and effort, from the responses since the reset and the learned weights. */
export function spend(week: Model, l: Learned, steps: readonly RangeStep[], now: number): Spend {
  const start = week.resetsAt - 7 * DAY
  const models = l.models.filter(m => m.shown).map(cost => {
    const by = new Map<string, number>()
    for (const s of steps) if (s[1] === cost.id && s[0] > start && s[0] <= now) by.set(s[2] || 'default', (by.get(s[2] || 'default') ?? 0) + s[3] / 1e6 * cost.w)
    const effort = [...by].sort((a, b) => b[1] - a[1])
    return { cost, pts: effort.reduce((s, e) => s + e[1], 0), effort }
  }).filter(m => m.pts > 0)
  const recorded = usedBetween(week.increments.filter(i => !i.hole), start, now)
  const split = models.reduce((s, m) => s + m.pts, 0)
  return { week: week.pct, models, unsplit: Math.max(0, recorded - split), away: Math.max(0, week.pct - recorded) }
}

/** Steps older than the readings are kept are dropped, and repeats merged. */
export function mergeSteps(lists: ReadonlyArray<readonly RangeStep[]>, now: number): RangeStep[] {
  const seen = new Set<string>(), out: RangeStep[] = []
  for (const list of lists) {
    for (const s of list) {
      const id = `${s[0]}:${s[1]}:${s[3]}`
      if (s[0] < now - KEEP || seen.has(id)) continue
      seen.add(id)
      out.push(s)
    }
  }
  return out.sort((a, b) => a[0] - b[0])
}
