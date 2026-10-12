import { C, FONT, esc } from './range'

/**
 * The drawing kit the cards share: text and runs of text that wrap, rectangles, the icons, the striped
 * projection pattern and each card's header. Sizes follow the design's three steps, 28 / 16 / 13 px.
 */

export const SIZE = { title: 28, body: 16, meta: 13 } as const

export type Txt = { size: number; weight?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; opacity?: number }
export const t = (x: number | string, y: number, s: string, o: Txt) =>
  `<text x="${typeof x === 'number' ? x.toFixed(1) : x}" y="${y.toFixed(1)}" text-anchor="${o.anchor ?? 'start'}" style="fill:${o.fill ?? C.fg}"${o.opacity !== undefined ? ` fill-opacity="${o.opacity}"` : ''} font-family="${FONT}" font-size="${o.size}px" font-weight="${o.weight ?? 400}">${esc(s)}</text>`
/** About how wide a text runs. */
export const tw = (s: string, size: number, weight = 400) => s.length * size * (weight >= 600 ? 0.57 : weight >= 500 ? 0.545 : 0.53)

export const rect = (x: number, y: number, w: number, h: number, style: string, extra = '') =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" style="${style}"${extra}/>`
/** A box with only its top corners rounded, as a path. */
export const topRounded = (x: number, y: number, w: number, h: number, r: number) => {
  r = Math.max(0, Math.min(r, w / 2, h))
  return `M${x.toFixed(1)} ${(y + h).toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)}H${(x + w - r).toFixed(1)}Q${(x + w).toFixed(1)} ${y.toFixed(1)} ${(x + w).toFixed(1)} ${(y + r).toFixed(1)}V${(y + h).toFixed(1)}`
}
/** A box with only its left corners rounded, or only its right ones. */
export const sideRounded = (x: number, y: number, w: number, h: number, r: number, side: 'left' | 'right') => {
  r = Math.max(0, Math.min(r, w, h / 2))
  return side === 'left'
    ? `M${(x + w).toFixed(1)} ${y.toFixed(1)}H${(x + r).toFixed(1)}Q${x.toFixed(1)} ${y.toFixed(1)} ${x.toFixed(1)} ${(y + r).toFixed(1)}V${(y + h - r).toFixed(1)}Q${x.toFixed(1)} ${(y + h).toFixed(1)} ${(x + r).toFixed(1)} ${(y + h).toFixed(1)}H${(x + w).toFixed(1)}Z`
    : `M${x.toFixed(1)} ${y.toFixed(1)}H${(x + w - r).toFixed(1)}Q${(x + w).toFixed(1)} ${y.toFixed(1)} ${(x + w).toFixed(1)} ${(y + r).toFixed(1)}V${(y + h - r).toFixed(1)}Q${(x + w).toFixed(1)} ${(y + h).toFixed(1)} ${(x + w - r).toFixed(1)} ${(y + h).toFixed(1)}H${x.toFixed(1)}Z`
}

/**
 * The projection's stripes, in the accent on the track's colour, as the design's
 * `repeating-linear-gradient(125deg, transparent 4px, accent 2px)`: `id` names it, `bg` is what shows between.
 */
export const stripes = (id: string, bg: string, period = 6, line = 2, ink: string = C.accent) =>
  `<pattern id="${id}" width="${period}" height="${period}" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="${period}" height="${period}" style="fill:${bg}"/><rect width="${line}" height="${period}" style="fill:${ink}"/></pattern>`

// ---- runs of text that wrap ----

/** A piece of a sentence and how it looks: muted, or in the text colour and bolder, or in a state's colour. */
export type Run = { s: string; fill?: string; weight?: number }

/**
 * Runs laid out as one paragraph, `width` wide, from the first baseline `y`; words break onto new lines as
 * they need to, each keeping its run's look. The y of the last baseline comes back.
 */
export function rich(runs: Run[], x: number, y: number, width: number, size: number, lh = 1.6, base: Omit<Run, 's'> = {}): { svg: string; y: number; lines: number } {
  // words, each knowing whether a space came before it (a run may end or begin with one)
  type Word = { s: string; fill: string; weight: number; space: boolean }
  const words: Word[] = []
  let pending = false
  for (const r of runs) {
    for (const p of r.s.split(/(\s+)/)) {
      if (p === '') continue
      if (/^\s+$/.test(p)) { pending = true; continue }
      words.push({ s: p, fill: r.fill ?? base.fill ?? C.muted, weight: r.weight ?? base.weight ?? 400, space: pending })
      pending = false
    }
  }
  const lines: Word[][] = [[]]
  let cx = 0
  for (const w of words) {
    const line = lines[lines.length - 1]!
    const gap = line.length && w.space ? size * 0.28 : 0
    const ww = tw(w.s, size, w.weight)
    if (line.length && cx + gap + ww > width) { lines.push([{ ...w, space: false }]); cx = ww; continue }
    line.push(w)
    cx += gap + ww
  }
  let svg = ''
  lines.forEach((line, i) => {
    if (!line.length) return
    const ly = y + i * size * lh
    svg += `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" font-family="${FONT}" font-size="${size}px" xml:space="preserve">`
    // consecutive words of the same look in one tspan, so the spacing is the font's own
    let cur: { fill: string; weight: number; s: string } | null = null
    const flush = () => { if (cur) svg += `<tspan style="fill:${cur.fill}" font-weight="${cur.weight}">${esc(cur.s)}</tspan>` }
    for (const w of line) {
      const sp = w.space ? ' ' : ''
      if (cur && cur.fill === w.fill && cur.weight === w.weight) cur.s += sp + w.s
      else { if (cur) cur.s += sp; flush(); cur = { fill: w.fill, weight: w.weight, s: w.s } }
    }
    flush()
    svg += '</text>'
  })
  return { svg, y: y + (lines.length - 1) * size * lh, lines: lines.length }
}

// ---- icons ----

/** The design's line icons, 24 units square. */
export const ICONS = {
  bars: '<path d="M5 20v-6m7 6V4m7 16V9" stroke-width="4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h3m3 0h2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  model: '<path d="m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  caretDown: '<path d="m6 9 6 6 6-6"/>',
  caretRight: '<path d="m9 6 6 6-6 6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
} as const
export type Icon = keyof typeof ICONS

/** An icon `size` px square at (x, y), stroked in `stroke`. */
export const icon = (name: Icon, x: number, y: number, size: number, stroke: string, width = 1.6) =>
  `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${(size / 24).toFixed(4)})" fill="none" style="stroke:${stroke}" stroke-width="${(width * 24 / size).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`
/** The icon on its rounded tile, as each card's header shows it. */
export const tile = (name: Icon, x: number, y: number, size: number, ink: string = C.fg) =>
  rect(x, y, size, size, `fill:${C.raised}`, ` rx="${(size * 0.21).toFixed(1)}"`) + icon(name, x + size * 0.25, y + size * 0.25, size * 0.5, ink, name === 'bars' ? 1.6 : 1.6)

// ---- the card's header ----

/** Below this the header's right-hand line goes under the title, as the design's phone layout does. */
export const NARROW = 560

/**
 * A card's header, `width` wide: its icon on a tile, the title beside it, and at the right a figure line
 * (under the title where the card is narrow). The y where the card's body starts comes back. `dense`, for a pane
 * too short for the cards, draws it smaller and closer to the body.
 */
export function cardHeader(name: Icon, title: string, meta: Run[], width: number, dense = false): { svg: string; y: number } {
  const narrow = width < NARROW
  const ts = dense ? 20 : narrow ? 24 : SIZE.title, tileS = dense ? 32 : narrow ? 39 : 48, gap = dense ? 10 : narrow ? 11 : 15
  const below = dense ? 14 : 22
  const blockH = ts * 1.25
  const top = Math.max(0, (tileS - blockH) / 2)
  let svg = tile(name, 0, 0, tileS)
  const tx = tileS + gap
  svg += t(tx, top + ts * 1.02, title, { size: ts, weight: 650 })
  const h = Math.max(blockH, tileS)
  const metaW = meta.reduce((a, r) => a + tw(r.s, SIZE.meta, r.weight), 0)
  if (!meta.length) return { svg, y: h + below }
  if (!narrow && tx + tw(title, ts, 650) + 24 + metaW <= width) {
    svg += rich(meta, width - metaW, h / 2 + SIZE.meta * 0.36, metaW + 40, SIZE.meta, 1.6, { fill: C.muted }).svg
    return { svg, y: h + below }
  }
  const m = rich(meta, 0, h + 12 + SIZE.meta, width, SIZE.meta, 1.6, { fill: C.muted })
  return { svg: svg + m.svg, y: m.y + below }
}

/**
 * A bar on a track, the design's `usage-track`: solid to `used`, striped to `to`, a mark at `limit`; each a
 * share (0–1) of the track. A tinted track's stripes sit on the accent's own tint (the today panel's).
 */
export function track(x: number, y: number, w: number, h: number, used: number, to: number, limit: number | null, o: { usedFill?: string; stripe: string; r?: number }): string {
  const r = o.r ?? 5, ux = w * Math.max(0, Math.min(1, used)), px = w * Math.max(0, Math.min(1, to))
  let s = rect(x, y, w, h, `fill:${C.raised}`, ` rx="${r}"`)
  if (px > ux) s += rect(x + ux, y, px - ux, h, `fill:url(#${o.stripe})`)
  if (ux > 0) s += `<path d="${sideRounded(x, y, ux, h, r, 'left')}" style="fill:${o.usedFill ?? C.accent}"/>`
  if (limit !== null) s += rect(x + w * limit - (limit >= 1 ? 2 : 1), y - 4, 2, h + 8, `fill:${C.fg}`, ' rx="1"')
  return s
}

/** Three labels under a track: left, centred and right, each a run of text. Onto more lines where they don't fit. */
export function trackLabels(cols: Array<Run[] | null>, y: number, width: number, size = SIZE.meta): { svg: string; y: number } {
  const ws = cols.map(c => (c ? c.reduce((a, r) => a + tw(r.s, size, r.weight ?? 400), 0) : 0))
  const third = width / 3
  if (ws.every(w => w <= third - 6)) {
    let svg = ''
    cols.forEach((c, i) => {
      if (!c) return
      const x = i === 0 ? 0 : i === 1 ? width / 2 - ws[1]! / 2 : width - ws[2]!
      svg += rich(c, x, y, ws[i]! + 40, size, 1.6, { fill: C.muted }).svg
    })
    return { svg, y }
  }
  let svg = '', ly = y
  cols.filter((c): c is Run[] => !!c).forEach((c, i) => {
    const r = rich(c, 0, ly + (i ? size * 1.6 : 0), width, size, 1.6, { fill: C.muted })
    svg += r.svg
    ly = r.y
  })
  return { svg, y: ly }
}

/** A row of figures with a caption over each, the design's `metric-grid`: four across, two where it's narrow. */
export function metricGrid(items: Array<{ label: string; value: string; fill?: string }>, width: number): { svg: string; y: number } {
  const cols = width < NARROW ? 2 : 4, cw = (width - (cols - 1) * 12) / cols
  let svg = '', y = 0
  items.forEach((it, i) => {
    const c = i % cols, r = Math.floor(i / cols), x = c * (cw + 12)
    y = 13 + r * 54
    svg += t(x, 13 + 13 + r * 54, it.label, { size: SIZE.meta, fill: C.muted })
    svg += t(x, 13 + 13 + 5 + 19 + r * 54, it.value, { size: SIZE.meta, weight: 500, fill: it.fill ?? C.fg })
  })
  return { svg, y: y + 13 + 5 + 19 + 21 }
}
