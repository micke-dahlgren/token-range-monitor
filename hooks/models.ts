import type { Palettes, RangeReading, RangeStep } from '../types'
import { C, DAY, FONT, HOUR, KEEP, drawing, esc, increments, isWatched, ofKind, usedBetween } from './range'
import type { Model, Watch } from './range'
import { DEFAULT_PALETTES } from './theme'
import { NARROW, SIZE, cardHeader, rect, rich, t, tw } from './ui'

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
 * (UNITS), so only the weight across models is learned. A model's cost shows
 * once its weight is known within ±SHOW_WITHIN.
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
  /** 5-hour points per million weighted tokens; 0 until anything is known. */
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
    // the limit is read at whole points, so each end of a stretch is off by part of the response that crossed
    // the point, evenly anywhere in it: never trust a fit closer than that (two ends, each size²/12)
    const perResponse = rows.reduce((s, r) => s + r.y, 0) / rows.reduce((s, r) => s + r.n, 0)
    const s2 = Math.max(rss / (rows.length - active.length), perResponse ** 2 / 6)
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

/** The names the baseline buttons show: the family alone, unless two versions of it are shown. */
export function shortNames(models: readonly ModelCost[]): Map<string, string> {
  const count = (f: Family) => models.filter(m => m.family === f).length
  return new Map(models.map(m => [m.id, m.family !== 'other' && count(m.family) === 1 ? m.name.replace(/ [\d.]+$/, '') : m.name]))
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
  const models = (l.perWeek ? l.models.filter(m => m.shown) : []).map(cost => {
    const by = new Map<string, number>()
    for (const s of steps) if (s[1] === cost.id && s[0] > start && s[0] <= now) by.set(s[2] || 'default', (by.get(s[2] || 'default') ?? 0) + s[3] / 1e6 * cost.w / l.perWeek!)
    const effort = [...by].sort((a, b) => b[1] - a[1])
    return { cost, pts: effort.reduce((s, e) => s + e[1], 0), effort }
  }).filter(m => m.pts > 0)
  const recorded = usedBetween(week.increments.filter(i => !i.hole), start, now)
  const split = models.reduce((s, m) => s + m.pts, 0)
  return { week: week.pct, models, unsplit: Math.max(0, recorded - split), away: Math.max(0, week.pct - recorded) }
}

// ---- words ----

const comma = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+$)/, ',')
const times = (x: number) => (x >= 1 ? x.toFixed(1) : x.toFixed(2)) + '×'
const one = (n: number) => n.toFixed(1).replace(/\.0$/, '')
/** A share of the weekly limit: "41.2%". */
const pc = (n: number) => `${one(n)}%`

/** A model's cost against the baseline, and its likely range. */
export function ratio(m: ModelCost, b: ModelCost): { x: string; range: string } {
  const x = m.w / b.w, err = Math.hypot(m.rel, b.rel)
  return { x: times(x), range: `${times(Math.max(0, x * (1 - err)))}–${times(x * (1 + err))}` }
}

const responsesText = (m: ModelCost) =>
  `${comma(m.responses)} ${m.responses === 1 ? 'response' : 'responses'}${m.sub === m.responses && m.sub > 0 ? ', all subagents' : m.sub > m.responses / 2 ? ', mostly subagents' : ''}`

/** The tooltip on the card's ⓘ. */
export const MODELS_INFO = 'Cost: how much of your limit each model uses token for token, compared with the model you pick. Learned from your history; shown once it’s within ±20%. This week: the % of the weekly limit that went to each model, by effort.'

/** The card in words, for a reader that can't see it and for surfaces without drawings. */
export function modelsText(l: Learned, b: ModelCost | null, sp: Spend | null): string[] {
  const rows = l.models.map(m => {
    if (!m.shown) return `${m.name}: learning, ${responsesText(m)}${m.more ? `, about ${comma(m.more)} more to go` : ''}.`
    if (!b) return `${m.name}: known, ${responsesText(m)}.`
    if (m === b) return `${m.name}: 1×, the baseline.`
    const r = ratio(m, b)
    return `${m.name}: ${r.x} ${b.name}, likely ${r.range}.`
  })
  if (sp) {
    rows.push(`This week ${Math.round(sp.week)}% used: ${[
      ...sp.models.map(m => `${m.cost.name} ${pc(m.pts)} (${m.effort.map(([e, v]) => `${e} ${pc(v)}`).join(', ')})`),
      ...(sp.unsplit ? [`not split yet ${pc(sp.unsplit)}`] : []),
      `not recorded ${pc(sp.away)}`,
    ].join(', ')}.`)
  }
  return rows
}

// ---- drawing ----

/** A model's colour for its cost figure: Opus the accent, then the second and third tones. */
const colorOf = (f: Family) => (f === 'other' ? C.muted : C[f])

/** A span in words: "14 days", "9 hours", "40 minutes". */
const spanText = (h: number) => {
  const [n, unit] = h >= 48 ? [Math.round(h / 24), 'day'] : h >= 1 ? [Math.round(h), 'hour'] : [Math.max(1, Math.round(h * 60)), 'minute']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/** One model's figure in the summary line: its cost against the baseline, 1× for the baseline, or learning. */
export function costWord(m: ModelCost, b: ModelCost | null): string {
  if (!m.shown) return 'learning'
  if (!b || m === b) return '1×'
  return ratio(m, b).x
}

/**
 * The models card's head, `width` wide: its header ("Models", how long the costs were learned from), and a
 * line of each model's cost against the baseline, a dot before each.
 */
export function modelsHead(l: Learned, b: ModelCost | null, now: number, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  const learned = l.since === null ? 'Learning' : `Learned from ${spanText((now - l.since) / HOUR)}`
  const head = cardHeader('model', 'Models', 'Relative token costs, learned from your usage', [{ s: learned }], width)
  let s = head.svg, y = head.y + SIZE.body * 1.05
  if (!l.models.length) {
    s += t(0, y, 'Learning from your responses.', { size: SIZE.body, fill: C.muted })
    return drawing(s, Math.ceil(y + 10), pal)
  }
  let x = 0
  l.models.forEach((m, i) => {
    const word = `${m.name} ${costWord(m, b)}`, w = 11 + tw(word, SIZE.body)
    const sep = i ? 12 + tw('·', SIZE.body) + 12 : 0
    if (i && x + sep + w > width) { x = 0; y += SIZE.body * 1.8 }
    else if (i) { s += t(x + 12, y, '·', { size: SIZE.body, fill: C.faint }); x += sep }
    s += `<circle cx="${(x + 3).toFixed(1)}" cy="${(y - SIZE.body * 0.33).toFixed(1)}" r="3" style="fill:${C.accent}"/>` + t(x + 11, y, word, { size: SIZE.body, fill: C.muted })
    x += w
  })
  return drawing(s, Math.ceil(y + 10), pal)
}

/**
 * The cost columns, `width` wide: each model's name (the baseline marked), its cost against the baseline as
 * a large figure in its colour, how many responses it's learned from and its likely range; a model still
 * learning says so, and how many more responses it needs. Three across, one per row where it's narrow.
 */
export function modelsCosts(l: Learned, b: ModelCost | null, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  if (!l.models.length) {
    const r = t(0, 18, 'No responses recorded yet. Costs are learned from the responses your sessions get.', { size: SIZE.meta, fill: C.muted })
    return drawing(r, 28, pal)
  }
  const narrow = width < NARROW, cols = narrow ? 1 : Math.min(3, l.models.length), cw = width / cols
  let s = '', rowTop = 12, rowH = 0
  l.models.forEach((m, i) => {
    const col = i % cols
    if (i && col === 0) { rowTop += rowH + 10; rowH = 0 }
    const x = col * cw + (col ? 20 : 0), inner = cw - (col ? 20 : 0) - (col < cols - 1 ? 20 : 0)
    const isBase = !!b && m === b
    let y = rowTop + 6 + SIZE.body * 1.05
    s += t(x, y, m.name, { size: SIZE.body, weight: 500 })
    if (isBase) {
      const bx = x + tw(m.name, SIZE.body, 500) + 7
      s += rect(bx, y - 13, tw('baseline', SIZE.meta) + 10, 19, `fill:${C.raised}`, ' rx="3"') + t(bx + 5, y + 1, 'baseline', { size: SIZE.meta, fill: C.muted })
    }
    const notes: string[] = [responsesText(m)]
    let fig: string, figFill: string = colorOf(m.family), big = true
    if (!m.shown) {
      fig = 'Learning'; figFill = C.muted; big = false
      notes.push('Not sure enough yet', `Shows at ±20% · ${m.more ? `~${comma(m.more)} more responses` : 'needs more responses'}`)
    } else if (!b) { fig = 'Known'; figFill = C.muted; big = false; notes.push('Compares once a second model shows') }
    else if (isBase) { fig = '1×'; notes.push('the others compare to this') }
    else { const r = ratio(m, b); fig = r.x; notes.push(`likely ${r.range}`) }
    if (narrow) {
      // the figure at the right of the name and its notes
      const mid = rowTop + 6 + (SIZE.body * 1.5 + notes.length * SIZE.meta * 1.6) / 2
      s += t(x + inner, mid + (big ? SIZE.title : SIZE.body) * 0.36, fig, { size: big ? SIZE.title : SIZE.body, weight: big ? 600 : 400, fill: figFill, anchor: 'end' })
      y += 4
    } else {
      y += 7 + (big ? SIZE.title * 1.15 : SIZE.body * 1.6)
      s += t(x, y, fig, { size: big ? SIZE.title : SIZE.body, weight: big ? 600 : 400, fill: figFill })
      y += 7
    }
    for (const n of notes) { y += SIZE.meta * 1.6; s += t(x, y, n, { size: SIZE.meta, fill: C.muted }) }
    rowH = Math.max(rowH, y - rowTop + 6)
  })
  return drawing(s, Math.ceil(rowTop + rowH + 8), pal)
}

/**
 * This week's points by model, `width` wide: the heading; per model, its share of the weekly limit, a track
 * split by effort and a chip per effort; then what isn't split by model yet and what wasn't recorded.
 */
export function modelsSpend(sp: Spend, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  let s = '', y = SIZE.body * 1.1
  s += t(0, y, `This week · ${Math.round(sp.week)}% of limit used`, { size: SIZE.body })
  y += SIZE.meta * 1.6
  s += t(0, y, '% of the weekly limit, by model and effort', { size: SIZE.meta, fill: C.muted })
  y += 13
  const row = (name: string, v: number, quiet: boolean, outline = false) => {
    const hy = y + (quiet ? 9 : 14) + SIZE.body * 1.05
    s += outline
      ? rect(0.5, hy - 9.5, 7, 7, `fill:none;stroke:${C.faint}`, ' rx="2"')
      : rect(0, hy - 10, 8, 8, `fill:${C.accent}`, ' rx="2"')
    s += t(15, hy, name, { size: SIZE.body, fill: quiet ? C.muted : C.fg }) + t(width, hy, pc(v), { size: SIZE.body, fill: quiet ? C.muted : C.fg, anchor: 'end' })
    return hy
  }
  for (const m of sp.models) {
    const hy = row(m.cost.name, m.pts, false)
    // the track: each effort's share of the weekly limit, side by side, the lesser ones lighter
    const ty = hy + 9
    s += rect(0, ty, width, 6, `fill:${C.raised}`, ' rx="3"')
    let x = 0
    m.effort.forEach(([, v], i) => {
      const w = Math.min(width - x, v / 100 * width)
      if (w > 0) s += rect(x, ty, w, 6, `fill:${C.accent}`, ` rx="3"${i ? ' fill-opacity="0.5"' : ''}`)
      x += w + 3
    })
    // a chip per effort: its name, and its share of the weekly limit
    let cx = 0, cy = ty + 6 + 8
    for (const [e, v] of m.effort) {
      const a = pc(v), w = 6 + tw(`${e} `, SIZE.meta) + tw(a, SIZE.meta) + 6
      if (cx > 0 && cx + w > width) { cx = 0; cy += 27 }
      s += rect(cx, cy, w, 22, `fill:${C.raised}`, ' rx="3"')
      s += `<text x="${(cx + 6).toFixed(1)}" y="${(cy + 15.5).toFixed(1)}" font-family="${FONT}" font-size="${SIZE.meta}px" xml:space="preserve"><tspan style="fill:${C.muted}">${esc(`${e} `)}</tspan><tspan style="fill:${C.faint}">${esc(a)}</tspan></text>`
      cx += w + 7
    }
    y = cy + 22 + 14
  }
  if (sp.unsplit) y = row('Not split yet', sp.unsplit, true) + 9
  y = row('Not recorded', sp.away, true, true) + 9
  if (!sp.models.length) {
    const note = rich([{ s: `No model’s cost is known yet, so this week can’t be split. The ${pc(sp.unsplit)} of the week recorded here will split once a model’s figure shows.` }],
      0, y + 12 + SIZE.meta * 1.2, width, SIZE.meta, 1.7)
    s += note.svg
    y = note.y + 10
  }
  return drawing(s, Math.ceil(y + 4), pal)
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
