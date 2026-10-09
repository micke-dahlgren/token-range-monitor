import type { Palettes, RangeReading, RangeStep } from '../types'
import { C, DAY, FONT, HOUR, KEEP, MONO, at, drawing, esc, isWatched, ofKind, pct, usedBetween } from './range'
import type { InfoSpot, Model, Watch } from './range'
import { DEFAULT_PALETTES } from './theme'

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

// ---- words ----

const comma = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+$)/, ',')
const times = (x: number) => (x >= 1 ? x.toFixed(1) : x.toFixed(2)) + '×'
const one = (n: number) => n.toFixed(1).replace(/\.0$/, '')

/** A model's cost against the baseline, and its likely range. */
export function ratio(m: ModelCost, b: ModelCost): { x: string; range: string } {
  const x = m.w / b.w, err = Math.hypot(m.rel, b.rel)
  return { x: times(x), range: `${times(Math.max(0, x * (1 - err)))}–${times(x * (1 + err))}` }
}

const responsesText = (m: ModelCost) =>
  `${comma(m.responses)} ${m.responses === 1 ? 'response' : 'responses'}${m.sub === m.responses && m.sub > 0 ? ', all subagents' : m.sub > m.responses / 2 ? ', mostly subagents' : ''}`

/** The tooltip on the card's ⓘ. */
export const MODELS_INFO = 'Cost: how much of your limit each model uses token for token, compared with the model you pick. Learned from your history; shown once it’s within ±20%. This week: points of the weekly limit that went to each model, by effort.'

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
      ...sp.models.map(m => `${m.cost.name} ${one(m.pts)} (${m.effort.map(([e, v]) => `${e} ${one(v)}`).join(', ')})`),
      ...(sp.unsplit ? [`not split yet ${one(sp.unsplit)}`] : []),
      `not recorded ${one(sp.away)}`,
    ].join(', ')}.`)
  }
  return rows
}

// ---- drawing ----

/** Lower effort draws lighter within its model's colour. */
const SHADE: Record<string, number> = { low: 0.35, medium: 0.55, high: 0.78, xhigh: 0.9, max: 1 }
const shade = (e: string) => SHADE[e] ?? 0.7
const colorOf = (f: Family) => (f === 'other' ? C.dim : C[f])

type Txt = { size: number; weight?: number; fill?: string; anchor?: string; mono?: boolean }
const t = (x: number | string, y: number, s: string, o: Txt) =>
  `<text x="${typeof x === 'number' ? x.toFixed(1) : x}" y="${y.toFixed(1)}" text-anchor="${o.anchor ?? 'start'}" style="fill:${o.fill ?? C.fg}" font-family="${o.mono ? MONO : FONT}" font-size="${o.size}px" font-weight="${o.weight ?? 400}">${esc(s)}</text>`
/** About how wide a text runs. */
const tw = (s: string, size: number, _mono = false) => s.length * size * 0.6
const dot = (x: number, y: number, fill: string, size = 10, opacity = 1) =>
  `<rect x="${x}" y="${(y - size / 2).toFixed(1)}" width="${size}" height="${size}" rx="${size * 0.3}" style="fill:${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''}/>`
const rule = (y: number) => `<line x1="0" x2="100%" y1="${y}" y2="${y}" style="stroke:${C.dim}" stroke-opacity="0.25"/>`
const LABEL = 11

/** A span in words: "14 days", "9 hours", "40 minutes". */
const spanText = (h: number) => {
  const [n, unit] = h >= 48 ? [Math.round(h / 24), 'day'] : h >= 1 ? [Math.round(h), 'hour'] : [Math.max(1, Math.round(h * 60)), 'minute']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/** The card's head: "Models" and how long the costs were learned from; its info circle is drawn by `withInfo`, which opens the tooltip over the rows. */
export function modelsHead(l: Learned, now: number, pal: Palettes = DEFAULT_PALETTES): { svg: string; height: number; info: InfoSpot } {
  const size = 1.2 * 16, y = size, r = 8
  const learned = l.since === null ? 'learning' : `learned from ${spanText((now - l.since) / HOUR)}`
  const height = Math.ceil(y + 8)
  return {
    svg: drawing(t(0, y, 'Models', { size, weight: 500 }) + t('100%', y, learned, { size: 12, fill: C.dim, anchor: 'end' }), height, pal),
    height,
    info: { cx: tw('Models', size) * 0.95 + 14, cy: y - size * 0.32, r },
  }
}

/** The cost rows, `width` wide: each model's cost against the baseline, or a meter while it learns. */
export function modelsCosts(l: Learned, b: ModelCost | null, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  let s = '', y = 0
  // ---- costs ----
  l.models.forEach((m, i) => {
    if (i > 0) s += rule(y)
    const top = y + (i > 0 ? 11 : 4), name = top + 13, meta = name + 19
    const learning = !m.shown
    s += dot(0, name - 4.5, colorOf(m.family)) + t(18, name, m.name, { size: 15, weight: 500 })
    const isBase = !!b && m === b
    if (isBase) {
      const x = 18 + tw(m.name, 15) + 10
      s += `<rect x="${x.toFixed(1)}" y="${(name - 12).toFixed(1)}" width="${(tw('baseline', 11, true) + 12).toFixed(1)}" height="17" rx="4" style="fill:${C.dim}" fill-opacity="0.14"/>`
        + t(x + 6, name, 'baseline', { size: 11, weight: 500, mono: true })
    }
    let fig: string, right: string
    if (learning) { fig = ''; right = 'not sure enough yet' }
    else if (!b) { fig = ''; right = 'compares once a second model shows' }
    else if (isBase) { fig = '1×'; right = 'the others compare to this' }
    else { const r = ratio(m, b); fig = r.x; right = `likely ${r.range}` }
    if (learning) s += t('100%', name, 'Learning', { size: 12, mono: true, fill: C.over, anchor: 'end' })
    else if (fig) s += t('100%', name, fig, { size: 15, weight: 500, mono: true, anchor: 'end' })
    else s += t('100%', name, 'Known', { size: 12, mono: true, fill: C.dim, anchor: 'end' })
    s += t(0, meta, responsesText(m), { size: 12.5, fill: C.dim }) + t('100%', meta, right, { size: 12.5, fill: C.dim, anchor: 'end' })
    y = meta + 5
    if (learning) {
      // the meter runs from ±100% (nothing known) to ±20% (shown)
      const p = isFinite(m.rel) ? Math.max(0.04, Math.min(1, (1 - Math.min(m.rel, 1)) / (1 - SHOW_WITHIN))) : 0.04
      const note = `shows at ±20% · ${m.more ? `about ${comma(m.more)} more responses` : 'needs more responses'}`
      // the text sits at the right on a backing of the card's colour, as wide as the text and a 16px gap:
      // the track runs under it and stops short of it, however wide the frame is drawn
      const noteW = tw(note, 11.5, true) * 1.05, gapW = 16
      const room = Math.max(0.2, 1 - (noteW + gapW) / width)
      const my = y + 11
      s += `<rect x="0" y="${my - 3}" width="100%" height="6" rx="3" style="fill:${C.dim}" fill-opacity="0.14"/>`
        + `<rect x="0" y="${my - 3}" width="${pct(room * p)}" height="6" rx="3" style="fill:${C.over}"/>`
        + at(1, `<rect x="${-(noteW + gapW).toFixed(1)}" y="${my - 8}" width="${(noteW + gapW).toFixed(1)}" height="16" style="fill:${C.card}"/>`
          + t(0, my + 4, note, { size: 11.5, mono: true, fill: C.dim, anchor: 'end' }))
      y = my + 9
    }
  })
  if (!l.models.length) {
    s += t(0, 16, 'No responses recorded yet. Costs are learned from the responses your sessions get.', { size: 12.5, fill: C.dim })
    y = 24
  }
  return drawing(s, y + 4, pal)
}

/** This week's points: a bar split by model and effort, each model's efforts as chips, and what isn't split or wasn't recorded. */
export function modelsSpend(sp: Spend, width: number, pal: Palettes = DEFAULT_PALETTES): string {
  let s = '', y = 14
  const head = `This week · ${Math.round(sp.week)}% of limit used`, sub = 'points of the weekly limit, by model and effort'
  s += t(0, y, head, { size: LABEL, weight: 500, mono: true, fill: C.dim })
  if (head.length * LABEL * 0.6 + tw(sub, 12) + 16 <= width) s += t('100%', y, sub, { size: 12, fill: C.dim, anchor: 'end' })
  else { y += 17; s += t(0, y, sub, { size: 12, fill: C.dim }) }
  y += 10
  const total = Math.max(sp.week, sp.models.reduce((a, m) => a + m.pts, 0) + sp.unsplit + sp.away, 0.0001)
  const segs = [
    ...sp.models.flatMap(m => m.effort.map(([e, v]) => ({ fill: colorOf(m.cost.family), o: shade(e), v }))),
    ...(sp.unsplit ? [{ fill: C.over, o: 0.45, v: sp.unsplit }] : []),
  ]
  let f = 0, bar = `<rect x="0" y="0" width="100%" height="22" style="fill:${C.dim}" fill-opacity="0.12"/>`
  for (const g of segs) {
    bar += `<rect x="${pct(f)}" y="0" width="${pct(g.v / total)}" height="22" style="fill:${g.fill}" fill-opacity="${g.o}"/>`
    if (f > 0) bar += `<line x1="${pct(f)}" x2="${pct(f)}" y1="0" y2="22" style="stroke:${C.card}"/>`
    f += g.v / total
  }
  if (sp.away) bar += `<rect x="${pct(f)}" y="0" width="${pct(sp.away / total)}" height="22" fill="url(#away)"/>` + (f > 0 ? `<line x1="${pct(f)}" x2="${pct(f)}" y1="0" y2="22" style="stroke:${C.card}"/>` : '')
  s += `<defs><pattern id="away" width="5" height="22" patternUnits="userSpaceOnUse"><rect width="2" height="22" style="fill:${C.dim}" fill-opacity="0.55"/></pattern>`
    + `<clipPath id="stack"><rect x="0" y="0" width="100%" height="22" rx="5"/></clipPath></defs>`
    + `<svg x="0" y="${y}" width="100%" height="22" overflow="hidden"><g clip-path="url(#stack)">${bar}</g></svg>`
  y += 22 + 8

  // each model: its points, then a chip per effort, largest first
  for (const m of sp.models) {
    s += rule(y)
    const hy = y + 20
    s += dot(0, hy - 4.5, colorOf(m.cost.family)) + t(17, hy, m.cost.name, { size: 13.5, weight: 500 }) + t('100%', hy, one(m.pts), { size: 13, weight: 500, mono: true, anchor: 'end' })
    let cx = 17, cy = hy + 9
    for (const [e, v] of m.effort) {
      const a = one(v), share = `${Math.round(v / (m.pts || 1) * 100)}%`
      const w = 8 + 8 + 6 + tw(e, 12.5) + 6 + tw(a, 12, true) + 6 + tw(share, 11.5, true) + 8
      if (cx > 17 && cx + w > width) { cx = 17; cy += 28 }
      let x = cx + 8
      s += `<rect x="${cx.toFixed(1)}" y="${cy}" width="${w.toFixed(1)}" height="22" rx="5" style="fill:${C.dim}" fill-opacity="0.12"/>`
      s += dot(x, cy + 11, colorOf(m.cost.family), 8, shade(e)); x += 14
      s += t(x, cy + 15.5, e, { size: 12.5 }); x += tw(e, 12.5) + 6
      s += t(x, cy + 15.5, a, { size: 12, weight: 500, mono: true }); x += tw(a, 12, true) + 6
      s += t(x, cy + 15.5, share, { size: 11.5, mono: true, fill: C.dim })
      cx += w + 6
    }
    y = cy + 22 + 7
  }

  // what isn't split by model: side by side when they fit, else one under the other
  const legend = [
    ...(sp.unsplit ? [{ label: 'Not split yet', v: sp.unsplit, sw: dot(0, 0, C.over, 10, 0.45) }] : []),
    { label: 'Not recorded', v: sp.away, sw: `<rect x="0" y="-5" width="10" height="10" rx="3" fill="url(#away)" style="stroke:${C.dim}" stroke-opacity="0.55"/>` },
  ]
  const cols = legend.length > 1 && width >= 2 * 150 + 14 ? 2 : 1
  if (sp.models.length) s += rule(y)
  y += 6
  legend.forEach((g, i) => {
    const col = i % cols, row = Math.floor(i / cols), ly = y + 14 + row * 22
    const x0 = col / cols, x1 = (col + 1) / cols
    s += at(x0, `<g transform="translate(${col ? 7 : 0},${ly - 4.5})">${g.sw}</g>` + t(col ? 24 : 17, ly, g.label, { size: 13, fill: C.dim }))
    s += at(x1, t(col < cols - 1 ? -7 : 0, ly, one(g.v), { size: 13, weight: 500, mono: true, fill: C.dim, anchor: 'end' }))
  })
  y += 14 + Math.ceil(legend.length / cols) * 22 - 14

  if (!sp.models.length) {
    const note = `No model’s cost is known yet, so this week can’t be split. The ${one(sp.unsplit)} points recorded here will split once a model’s figure shows.`
    const lines = wrapAt(note, width - 26, 13)
    const H = lines.length * 19 + 16
    y += 14
    const dash = `style="stroke:${C.dim}" stroke-opacity="0.45" stroke-dasharray="4 4" fill="none"`
    s += `<rect x="0.5" y="${y + 0.5}" width="99.9%" height="${H}" rx="8" ${dash}/>`
      + lines.map((ln, i) => t(12, y + 22 + i * 19, ln, { size: 13, fill: C.dim })).join('')
    y += H + 2
  }
  return drawing(s, y + 6, pal)
}

/** Text broken into lines that fit `width` at `size`. */
function wrapAt(s: string, width: number, size: number): string[] {
  const lines: string[] = []
  for (const word of s.split(' ')) {
    const last = lines[lines.length - 1]
    if (last !== undefined && tw(`${last} ${word}`, size) <= width) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return lines
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
