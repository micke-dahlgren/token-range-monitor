import type { Palettes, RangeReading, RangeStep } from '../types'
import { C, DAY, FONT, HOUR, KEEP, drawing, esc, increments, isWatched, ofKind, usedBetween } from './range'
import type { Model, Watch } from './range'
import { DEFAULT_PALETTES } from './theme'
import { SIZE, cardHeader, rect, t, tw } from './ui'

/**
 * What each model costs, learned from this account's own history.
 *
 * Every response reports its model and tokens. Between two readings of the
 * 5-hour limit the plugin knows how far the limit rose and which models did
 * the work then, so over many such stretches it can solve for each model's
 * weight: rise ≈ Σ w·T. The 5-hour figure moves several times faster than the
 * weekly one, so it gives several times the stretches; how models compare
 * comes out the same from either limit, and the week's points are the 5-hour
 * ones exchanged at the account's own rate (5-hour points per weekly point). Within a
 * model, its token kinds are combined at that model's published price ratios
 * (UNITS), so only the weight across models is learned. Each weight starts at
 * the model's list price (LIST_PRICE), scaled to the account by one fitted
 * number, and the stretches pull it from there as they add up: every model has
 * a weight from its first response.
 */

/** A response's tokens, weighted as a model's price list weighs them: input 1, output 5, cache writes 1.25, cache reads 0.1. */
export const units = (u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) =>
  u.input_tokens + 5 * u.output_tokens + 1.25 * u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens

/** How far back the costs are learned from. */
export const LEARN_SPAN = 14 * DAY
/** Under this many stretches with the model in them, its weight is mostly its list price. */
const MIN_STRETCHES = 5
/** z for a 90% range. */
const Z90 = 1.645
/** The list price counts as this many typical stretches of the model: the data outweighs it once it has more. */
const PRIOR_STRETCHES = 10

/**
 * Published API prices per million input tokens, by family and version (output is 5× input for every one, as
 * UNITS weighs it). Only their ratios matter: they are each model's starting weight. A version not listed takes
 * its family's newest price.
 */
export const LIST_PRICE: Record<string, number> = {
  'fable 5.1': 10, 'fable 5': 10,
  'opus 5.5': 4, 'opus 5': 5, 'opus 4.8': 5, 'opus 4.7': 5, 'opus 4.6': 5,
  'sonnet 5.5': 2, 'sonnet 5': 2, 'sonnet 4.6': 3,
  'haiku 5.5': 0.1, 'haiku 4.5': 1,
}
const NEWEST: Record<string, number> = { fable: 10, opus: 4, sonnet: 2, haiku: 0.1 }

/** A model's list price per million input tokens, or null for a model of no known family. */
export function listPrice(id: string): number | null {
  const m = modelName(id)
  if (m.family === 'other') return null
  return LIST_PRICE[`${m.family} ${m.version.join('.')}`] ?? NEWEST[m.family]!
}

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
  /** 5-hour points per million weighted tokens (in list-price units until a stretch is watched); 0 when unknown. */
  w: number
  /** The 90% range as a share of `w`: Infinity while nothing is known. */
  rel: number
  /** Whether it has a weight at all: a list price, or a fit. */
  shown: boolean
  /** Whether that weight is still mostly the list price: too few stretches had the model in them. */
  prior: boolean
  /** Responses in the learning span, and how many of them subagents made. */
  responses: number
  sub: number
}

export type Learned = {
  models: ModelCost[]
  /** When the first stretch learned from began (ms), or null with none yet. */
  since: number | null
  /** 5-hour points per weekly point over the same span, or null until the weekly figure has moved enough to tell. */
  perWeek: number | null
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
  // each point where it was first reached: a repeat of it (another session, another device) would split a
  // stretch in two, the work before the repeat seeming to have cost nothing
  const fives = ofKind(readings, 'five').filter((r, i, all) => r[0] >= from && !(i > 0 && all[i - 1]![2] === r[2] && Math.abs(all[i - 1]![3] - r[3]) <= 5 * 60_000))
  const sorted = [...recent].sort((a, b) => a[0] - b[0])

  // the stretches: how far the limit rose, and each model's tokens (in millions) meanwhile
  const rows: Array<{ y: number; x: number[]; n: number }> = []
  let since: number | null = null
  for (let i = 1; i < fives.length; i++) {
    const a = fives[i - 1]!, b = fives[i]!
    // a reset in between, or a gap nobody here watched: usage from elsewhere would count against these models
    if (Math.abs(a[3] - b[3]) > 5 * 60_000 || !isWatched(seen, a[0], b[0])) continue
    const y = b[2] - a[2]
    if (y < 0) continue
    const x = ids.map(() => 0)
    let n = 0
    for (const s of sorted) if (s[0] > a[0] && s[0] <= b[0]) { x[ids.indexOf(s[1])]! += s[3] / 1e6; n++ }
    if (n === 0) continue
    rows.push({ y, x, n })
    since ??= a[0]
  }

  // each model's starting weight: its list price, scaled to this account's points by one number fitted to every stretch
  const price = ids.map(listPrice)
  const z = rows.map(r => r.x.reduce((t, v, i) => t + v * (price[i] ?? 0), 0))
  const zz = z.reduce((t, v) => t + v * v, 0)
  const scale = zz > 0 ? rows.reduce((t, r, k) => t + r.y * z[k]!, 0) / zz : 1
  const w0 = price.map(p => (p === null ? 0 : p * scale))
  // how much the start counts: PRIOR_STRETCHES of the model's typical stretch
  const lam = ids.map((_, i) => {
    if (price[i] === null) return 0
    const xs = rows.map(r => r.x[i]!).filter(v => v > 0)
    return xs.length ? PRIOR_STRETCHES * xs.reduce((t, v) => t + v * v, 0) / xs.length : 0
  })

  // least squares over the models still in, pulled toward their start, dropping the most negative until none is
  let active = ids.map((_, i) => i).filter(i => rows.some(r => r.x[i]! > 0))
  let fit: { x: number[]; inv: number[][] } | null = null
  while (active.length) {
    const A = active.map(i => active.map(j => rows.reduce((t, r) => t + r.x[i]! * r.x[j]!, 0) + (i === j ? lam[i]! : 0)))
    const b = active.map(i => rows.reduce((t, r) => t + r.x[i]! * r.y, 0) + lam[i]! * w0[i]!)
    fit = solve(A, b)
    if (!fit) break
    const worst = fit.x.reduce((k, v, j) => (v < (fit!.x[k] ?? 0) ? j : k), 0)
    if (fit.x[worst]! >= 0) break
    active = active.filter((_, j) => j !== worst)
    fit = null
  }
  // a model no watched stretch had, or one the fit dropped as negative, keeps its start
  const w = ids.map((_, i) => w0[i]!), rel = ids.map(() => Infinity)
  const fitted = fit && (rows.length > active.length || active.every(i => lam[i]! > 0))
  if (fit && fitted) {
    active.forEach((i, j) => { w[i] = fit!.x[j]! })
    const rss = rows.reduce((t, r) => t + (r.y - r.x.reduce((u, v, i) => u + v * w[i]!, 0)) ** 2, 0)
    // the limit is read at whole points, so each end of a stretch is off by part of the response that crossed
    // the point, evenly anywhere in it: never trust a fit closer than that (two ends, each size²/12)
    const perResponse = rows.reduce((t, r) => t + r.y, 0) / rows.reduce((t, r) => t + r.n, 0)
    const s2 = Math.max(rss / Math.max(1, rows.length - active.length), perResponse ** 2 / 6)
    active.forEach((i, j) => {
      if (w[i]! > 0) rel[i] = Z90 * Math.sqrt(s2 * fit!.inv[j]![j]!) / w[i]!
    })
  }

  // the exchange rate to weekly points, from what both limits rose by while watched
  const weekPts = usedBetween(increments(readings, 'week', seen).filter(x => !x.hole), from, now)
  const fivePts = usedBetween(increments(readings, 'five', seen).filter(x => !x.hole), from, now)

  return {
    since,
    perWeek: weekPts >= 3 && fivePts > 0 ? fivePts / weekPts : null,
    models: ids.map((id, i) => {
      const mine = recent.filter(s => s[1] === id)
      const stretches = rows.filter(r => r.x[i]! > 0).length
      return { id, ...modelName(id), w: w[i]!, rel: rel[i]!, shown: w[i]! > 0, prior: stretches < MIN_STRETCHES, responses: mine.length, sub: mine.filter(s => s[4]).length }
    }),
  }
}

/** The model the others compare to: the one picked, else the one known most precisely from your use, else the most used. Null under two shown. */
export function baselineOf(l: Learned, picked: string | undefined): ModelCost | null {
  const shown = l.models.filter(m => m.shown)
  if (shown.length < 2) return null
  return shown.find(m => m.id === picked)
    ?? [...shown].filter(m => !m.prior && isFinite(m.rel)).sort((a, b) => a.rel - b.rel)[0]
    ?? [...shown].sort((a, b) => b.responses - a.responses)[0]!
}

/** The names the baseline buttons show: the family alone, unless two versions of it are shown. */
export function shortNames(models: readonly ModelCost[]): Map<string, string> {
  const count = (f: Family) => models.filter(m => m.family === f).length
  return new Map(models.map(m => [m.id, m.family !== 'other' && count(m.family) === 1 ? m.name.replace(/ [\d.]+$/, '') : m.name]))
}

export type UsageSplit = {
  kind: 'five' | 'week'
  /** % of the limit used this window. */
  used: number
  /** Each model's % of the limit, largest first, split by effort (largest first). */
  models: Array<{ id: string; name: string; family: Family; pct: number; effort: Array<[string, number]> }>
  /** Used with no responses seen here behind it: another device, the phone, claude.ai, or a gap nobody watched. */
  notRecorded: number
  /** 100 − used, never below 0. */
  unused: number
}

/**
 * This window's use of a limit by model and effort. Each rise of the limit seen while watching is shared among
 * the responses made since the reading before it, by their weighted tokens × their model's weight; a rise with
 * no responses behind it, or over a gap, is not recorded. Rises adding up to more than the figure are scaled
 * down to it; to less, the rest is not recorded. models + notRecorded + unused = 100.
 */
export function usageSplit(m: Model, readings: readonly RangeReading[], steps: readonly RangeStep[], seen: readonly Watch[], weightOf: (id: string) => number, now: number): UsageSplit {
  const kind = m.kind as 'five' | 'week', from = m.resetsAt - (kind === 'five' ? 5 * HOUR : 7 * DAY), used = Math.min(100, m.pct)
  const sorted = [...steps].sort((a, b) => a[0] - b[0])
  const by = new Map<string, Map<string, number>>()
  let total = 0, away = 0
  for (const inc of increments(readings, kind, seen)) {
    const overlap = Math.min(inc.end, now) - Math.max(inc.start, from)
    if (overlap <= 0) continue
    const amount = inc.amount * Math.min(1, overlap / Math.max(1, inc.end - inc.start))
    total += amount
    if (inc.hole || inc.from === undefined) { away += amount; continue }
    // the responses in (inc.from, inc.end]
    let lo = 0, hi = sorted.length
    while (lo < hi) { const k = (lo + hi) >> 1; if (sorted[k]![0] <= inc.from) lo = k + 1; else hi = k }
    const shares: Array<[string, string, number]> = []
    let weight = 0
    for (let i = lo; i < sorted.length && sorted[i]![0] <= inc.end; i++) {
      const st = sorted[i]!, wt = st[3] * weightOf(st[1])
      if (!(wt > 0)) continue
      shares.push([st[1], st[2] || 'default', wt])
      weight += wt
    }
    if (weight <= 0) { away += amount; continue }
    for (const [id, effort, wt] of shares) {
      const e = by.get(id) ?? new Map<string, number>()
      e.set(effort, (e.get(effort) ?? 0) + amount * wt / weight)
      by.set(id, e)
    }
  }
  // the record may cover more or less than the figure: scale down to it, or the rest is not recorded
  const scale = total > used && total > 0 ? used / total : 1
  const models = [...by].map(([id, e]) => {
    const effort = [...e].map(([k, v]): [string, number] => [k, v * scale]).sort((a, b) => b[1] - a[1])
    return { id, ...modelName(id), pct: effort.reduce((t, x) => t + x[1], 0), effort }
  }).filter(x => x.pct > 0).sort((a, b) => b.pct - a.pct || byRank(a.id, b.id))
  return { kind, used, models, notRecorded: away * scale + Math.max(0, used - total), unused: Math.max(0, 100 - used) }
}

// ---- words ----

const times = (x: number) => (x >= 1 ? x.toFixed(1) : x.toFixed(2)) + '×'
const one = (n: number) => n.toFixed(1).replace(/\.0$/, '')
/** A share of the weekly limit: "41.2%". */
const pc = (n: number) => `${one(n)}%`

/** A model's cost against the baseline, and its likely range. */
export function ratio(m: ModelCost, b: ModelCost): { x: string; range: string } {
  // only what was measured counts toward the range: a list price is taken as given
  const x = m.w / b.w, err = Math.hypot(isFinite(m.rel) ? m.rel : 0, isFinite(b.rel) ? b.rel : 0)
  return { x: times(x), range: `${times(Math.max(0, x * (1 - err)))}–${times(x * (1 + err))}` }
}

/** What the card counts, under its Details. */
export const MODELS_INFO = 'The bar shows how much of the limit each model used this window, by effort. Each rise of the limit is shared among the responses behind it, weighed by token cost: each model starts at its list price and learns from your own use. Not recorded is use this computer didn’t see: another device, the phone, claude.ai.'

/** A model's efforts worth naming: a sliver under 0.05% would read as 0%. */
export const shownEffort = (m: UsageSplit['models'][number]) => m.effort.filter(([, v]) => v >= 0.05)

/** The frame a split is in: what its 100% is. */
export const splitFrame = (sp: UsageSplit) => (sp.kind === 'five' ? 'This 5-hour window · 100% = your 5-hour limit' : 'This week · 100% = your weekly limit')

/** The split in words, for a reader that can't see the bar and for the terminal. */
export function splitText(sp: UsageSplit): string {
  const parts = [
    ...sp.models.map(m => { const ef = shownEffort(m); return `${m.name} ${pc(m.pct)}${ef.length > 1 ? ` (${ef.map(([e, v]) => `${e} ${pc(v)}`).join(', ')})` : ''}` }),
    ...(sp.notRecorded >= 0.05 ? [`not recorded ${pc(sp.notRecorded)}`] : []),
    `unused ${pc(sp.unused)}`,
  ]
  return `${splitFrame(sp)}: ${parts.join(', ')}.`
}

/**
 * Each model's token cost against the baseline, a row per model from the most to the least costly: its figure, and where
 * the figure comes from (its list price, your use with its likely range, or a rough fit that needs more use).
 */
export function costRows(l: Learned, b: ModelCost | null): Array<{ id: string; name: string; x: string; note: string }> {
  if (!b) return []
  const others = l.models.filter(m => m.shown && m !== b)
  if (!others.length) return []
  return [b, ...others].sort((p, q) => q.w - p.w).map(m => {
    if (m === b) return { id: m.id, name: m.name, x: '1×', note: 'baseline' }
    const r = ratio(m, b)
    const note = m.prior ? 'list price' : isFinite(m.rel) && m.rel <= 0.5 ? `likely ${r.range}` : 'rough, needs more use'
    return { id: m.id, name: m.name, x: r.x, note }
  })
}

// ---- drawing ----

/** A model's colour for its cost figure: Opus the accent, then the second and third tones. */
const colorOf = (f: Family) => (f === 'other' ? C.muted : C[f])

/** The models card's head, `width` wide: its header, with the frame of the split under it on the right. */
export function modelsHead(sp: UsageSplit | null, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  const head = cardHeader('model', 'Models', 'Where your usage went', sp ? [{ s: sp.kind === 'five' ? 'This 5-hour window' : 'This week' }] : [], width)
  return drawing(head.svg, Math.ceil(head.y + 4), pal)
}

/**
 * The split, `width` wide: its frame, one stacked bar on the limit's scale (each model in its colour, what wasn't
 * recorded hatched, what's unused faint), then a row per model with its figure and a chip per effort, and the
 * not-recorded row.
 */
export function modelsUsage(sp: UsageSplit, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  let s = `<defs><pattern id="nr" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" style="fill:${C.raised}"/><rect width="2" height="5" style="fill:${C.faint}"/></pattern></defs>`
  let y = SIZE.meta * 1.15
  s += t(0, y, splitFrame(sp), { size: SIZE.meta, fill: C.muted })
  y += 10
  // the bar: models, then not recorded, then unused, 2px apart
  const parts = [...sp.models.map(m => ({ v: m.pct, fill: colorOf(m.family) })), { v: sp.notRecorded, fill: 'url(#nr)' }].filter(x => x.v >= 0.05)
  const H = 14
  s += rect(0, y, width, H, `fill:${C.raised}`, ' rx="4"')
  let x = 0
  for (const p of parts) {
    const w = Math.max(2, p.v / 100 * width)
    s += rect(x, y, Math.min(w, width - x), H, `fill:${p.fill}`, x === 0 ? ' rx="4"' : '')
    x += w + 2
    if (x >= width) break
  }
  y += H + 8
  const row = (name: string, v: number, dot: string, quiet: boolean) => {
    const hy = y + 12 + SIZE.body * 1.05
    s += rect(0, hy - 10, 8, 8, `fill:${dot}`, ' rx="2"')
    s += t(15, hy, name, { size: SIZE.body, fill: quiet ? C.muted : C.fg }) + t(width, hy, pc(v), { size: SIZE.body, fill: quiet ? C.muted : C.fg, anchor: 'end' })
    return hy
  }
  for (const m of sp.models) {
    const hy = row(m.name, m.pct, colorOf(m.family), false)
    y = hy + 4
    const ef = shownEffort(m)
    if (ef.length > 1 || (ef[0] && ef[0][0] !== 'default')) {
      // a chip per effort: its name, and its share of the limit
      let cx = 15, cy = hy + 6
      for (const [e, v] of ef) {
        const a = pc(v), w = 6 + tw(`${e} `, SIZE.meta) + tw(a, SIZE.meta) + 6
        if (cx > 15 && cx + w > width) { cx = 15; cy += 27 }
        s += rect(cx, cy, w, 22, `fill:${C.raised}`, ' rx="3"')
        s += `<text x="${(cx + 6).toFixed(1)}" y="${(cy + 15.5).toFixed(1)}" font-family="${FONT}" font-size="${SIZE.meta}px" xml:space="preserve"><tspan style="fill:${C.muted}">${esc(`${e} `)}</tspan><tspan style="fill:${C.faint}">${esc(a)}</tspan></text>`
        cx += w + 7
      }
      y = cy + 22
    }
  }
  if (sp.notRecorded >= 0.05) y = row('Not recorded', sp.notRecorded, C.faint, true) + 4
  if (!sp.models.length && sp.notRecorded < 0.05) {
    y += 12 + SIZE.meta * 1.2
    s += t(0, y, 'Nothing used yet this window.', { size: SIZE.meta, fill: C.muted })
  }
  return drawing(s, Math.ceil(y + 8), pal)
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
