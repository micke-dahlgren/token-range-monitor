import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { RangeReading, RangeSettings, RangeWatch } from '../types'
import {
  DEFAULT_SETTINGS, FIVE_WINDOW_MIN, KEEP, MIN, heartbeat, MIN_RECORDED_H, UNIT_MAX, UNIT_MIN, averageName, clampWindow, averageNote, chosenAverage,
  emptyChartSvg, emptyChartText, fit, fx, headerDraw, paceExplain, paceText, recentPace, withInfo, fiveChart, headerSvg, noteSvg, merge, parseWindow, project, rateText, recordedHours, resetsIn,
  isShort, leftText, runsOut, weekChart, windowHours,
} from './range'
import type { Average, Model } from './range'
import { DEFAULT_PALETTES, palettesFor, resolveTheme } from './theme'

const PANE = 'token-range-monitor'
const TITLE = 'Token Range Monitor'
const readings = atom({ plugin: 'token-range-monitor', key: 'readings' } as const, [])
const settings = atom({ plugin: 'token-range-monitor', key: 'settings' } as const, DEFAULT_SETTINGS)
const tick = atom({ plugin: 'token-range-monitor', key: 'tick' } as const, 0)
const seen = atom({ plugin: 'token-range-monitor', key: 'seen' } as const, [])
const palettes = atom({ plugin: 'token-range-monitor', key: 'palettes' } as const, DEFAULT_PALETTES)

/**
 * Usage limits are the account's, so the record is too: everything is stored
 * under the signed-in account (`<account>/`), and signing in to another
 * account starts from that account's own record. Within it each session
 * writes its readings under its own key (`r:`), and the spans it was watching
 * under the twin key (`w:`), so sessions never overwrite each other, and every
 * session reads them all.
 */
let account = ''
const OWN = 'r:'
const SEEN = 'w:'
const ownPrefix = () => `${account}/${OWN}`
const seenKeyOf = (key: string) => key.replace(`/${OWN}`, `/${SEEN}`)
const newOwnKey = (now: number) => `${ownPrefix()}${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
/** A stored list's key: whose (none for a record kept before accounts), and which kind. */
const parseKey = (key: string) => /^(?:(.+)\/)?([rw]):/.exec(key)

let ownKey = ''
let own: RangeReading[] = []
let ownSeen: RangeWatch[] = []
let othersSeen: RangeWatch[] = []

/**
 * The signed-in account and organisation, from Claude Code's own config:
 * the limits belong to both. `none` off a subscription, which has no limits.
 */
async function accountOf($: EngineInterface): Promise<string> {
  try {
    const dir = await $.env.get('CLAUDE_CONFIG_DIR')
    const file = dir ? `${dir}/.claude.json` : `${(await $.env.get('HOME')) ?? ''}/.claude.json`
    const o = (JSON.parse(await $.fs.read(file)) as { oauthAccount?: { accountUuid?: string; organizationUuid?: string } }).oauthAccount
    return o?.accountUuid ? `${o.accountUuid}.${o.organizationUuid ?? ''}` : 'none'
  } catch {
    return 'none'
  }
}

/** Follows a sign-in to another account: this session starts a fresh list under it. True when it moved. */
async function followAccount($: EngineInterface): Promise<boolean> {
  const now = await $.clock.now()
  const a = await accountOf($)
  if (a === account) return false
  account = a
  ownKey = newOwnKey(now)
  own = []
  ownSeen = []
  return true
}

/**
 * Claude Code keeps a store per copy of a plugin: one installed from the
 * marketplace and one run from a folder don't share. Every copy's store sits
 * in the same folder, so each copy also reads the others' (never writes them),
 * and sessions running different copies still see each other's usage.
 */
async function otherCopies($: EngineInterface): Promise<Array<[string, unknown]>> {
  try {
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
    const stores = `${dir}/plugins/store`
    const out: Array<[string, unknown]> = []
    for (const f of await $.fs.list(stores)) {
      if (!/^token-range-monitor_.*\.json$/.test(f.name)) continue
      const entries = JSON.parse(await $.fs.read(`${stores}/${f.name}`)) as Record<string, unknown>
      out.push(...Object.entries(entries))
    }
    return out
  } catch {
    return []
  }
}

async function loadAll($: EngineInterface) {
  const now = await $.clock.now()
  const lists: RangeReading[][] = [own]
  const spans: RangeWatch[] = []
  // the other copies' lists, read as they stand; this copy's own file is among them, and merging drops the repeats
  for (const [key, value] of await otherCopies($)) {
    const k = parseKey(key)
    if (!k || !Array.isArray(value) || (k[1] !== undefined && k[1] !== account)) continue
    if (k[2] === 'w') spans.push(...(value as RangeWatch[]))
    else lists.push(value as RangeReading[])
  }
  for (const key of await $.store.keys()) {
    const k = parseKey(key)
    if (!k || key === ownKey || key === seenKeyOf(ownKey)) continue
    const [, whose, kind] = k
    const list = ((await $.store.get(key)) ?? []) as Array<RangeReading | RangeWatch>
    // drop lists once everything in them has aged out, whichever account's
    const end = (x: RangeReading | RangeWatch) => (kind === 'w' ? (x as RangeWatch)[1] : x[0])
    if (list.every(x => end(x) < now - KEEP)) { await $.store.delete(key); continue }
    if (whose === undefined) {
      // a record kept before accounts: it was this account's, so it moves under it
      await $.store.set(`${account}/${key}`, list)
      await $.store.delete(key)
    } else if (whose !== account) continue
    if (kind === 'w') spans.push(...(list as RangeWatch[]))
    else lists.push(list as RangeReading[])
  }
  othersSeen = spans
  await update($, readings, () => merge(lists, now))
  await update($, seen, () => [...othersSeen, ...ownSeen])
}

/**
 * Notes that this session just got fresh figures (a response arrived), for telling
 * usage seen here from usage made elsewhere. Saved at most every 30 seconds.
 */
let seenSavedAt = 0
async function watch($: EngineInterface) {
  const now = await $.clock.now()
  if (!ownKey) ownKey = newOwnKey(now)
  const before = ownSeen.length
  ownSeen = heartbeat(ownSeen, now)
  if (ownSeen.length !== before || now - seenSavedAt > 30_000) {
    seenSavedAt = now
    await $.store.set(seenKeyOf(ownKey), ownSeen)
  }
  await update($, seen, () => [...othersSeen, ...ownSeen])
}

async function capture($: EngineInterface, limits: readonly SessionRateLimit[]) {
  // figures from another account mean a sign-in since: read that account's record first
  if (await followAccount($)) await loadAll($)
  const now = await $.clock.now()
  const known = await read($, readings)
  const fresh: RangeReading[] = []
  for (const rl of limits) {
    const kind = rl.kind === 'five_hour' ? 0 : rl.kind === 'seven_day' ? 1 : -1
    if (kind === -1 || !rl.resetsAt) continue
    const resetsAt = Date.parse(rl.resetsAt)
    let last: RangeReading | undefined
    for (const r of known) if (r[1] === kind && (!last || r[0] >= last[0])) last = r
    if (!last || last[2] !== rl.percentUsed || Math.abs(last[3] - resetsAt) > 5 * MIN) {
      fresh.push([now, kind, rl.percentUsed, resetsAt])
    }
  }
  if (fresh.length === 0) return
  if (!ownKey) ownKey = newOwnKey(now)
  own = merge([own, fresh], now)
  await $.store.set(ownKey, own)
  await update($, readings, list => merge([list, fresh], now))
}

/**
 * Reads the person's theme and derives the card's palettes from it. A custom
 * theme (`custom:<slug>`) is the person's own file or one a plugin ships.
 */
async function loadTheme($: EngineInterface) {
  const setting = ((await $.settings.read()) as { theme?: unknown }).theme
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const theme = await resolveTheme(setting, async slug => {
    const own = `${dir}/themes/${slug}.json`
    if (await $.fs.exists(own)) return await $.fs.read(own)
    // plugins are cached as cache/<marketplace>/<plugin>/<version>/
    const cache = `${dir}/plugins/cache`
    for (const m of await $.fs.list(cache).catch(() => [])) {
      for (const pl of await $.fs.list(`${cache}/${m.name}`).catch(() => [])) {
        for (const ver of await $.fs.list(`${cache}/${m.name}/${pl.name}`).catch(() => [])) {
          const file = `${cache}/${m.name}/${pl.name}/${ver.name}/themes/${slug}.json`
          if (await $.fs.exists(file)) return await $.fs.read(file)
        }
      }
    }
    return undefined
  })
  const next = palettesFor(theme)
  if (JSON.stringify(next) !== JSON.stringify(await read($, palettes))) await update($, palettes, () => next)
}

async function models($: EngineInterface) {
  const list = await read($, readings)
  const watched = await read($, seen)
  const s = await read($, settings)
  const pal = await read($, palettes)
  await read($, tick)
  const now = await $.clock.now()
  const weekRecorded = recordedHours(list, 'week', now)
  const fiveRecorded = recordedHours(list, 'five', now)
  const weekAvg = chosenAverage(s)
  // until half an hour is on record, Anthropic's own figure since the 5-hour window opened stands in
  const fiveAvg: Average = fiveRecorded < FIVE_WINDOW_MIN / 60 ? { type: 'reset' } : { type: 'hours', hours: FIVE_WINDOW_MIN / 60 }
  const week = project(list, 'week', now, weekAvg, watched)
  return {
    now, s, weekRecorded, pal, week,
    five: project(list, 'five', now, fiveAvg, watched),
    pace: week ? recentPace(list, week, now, watched) : null,
  }
}

async function toggleFine($: EngineInterface) {
  await update($, settings, s => ({ ...s, fine: !s.fine }))
  await $.store.set('settings', await read($, settings))
}

async function choose($: EngineInterface, change: Partial<RangeSettings>) {
  await update($, settings, s => ({ ...s, ...change }))
  await $.store.set('settings', await read($, settings))
}

/** Sets the weekly window: any length, one that can't give an estimate yet saying so in the chart's place. */
async function setWindow($: EngineInterface, n: number, unit: 'h' | 'd') {
  await choose($, { mode: 'window', n: clampWindow(n, unit), unit })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    account = ''
    await followAccount($)
    const saved = (await $.store.get('settings')) as RangeSettings | undefined
    // a saved "everything recorded" (now retired) becomes the custom window it sat beside
    if (saved) await update($, settings, () => ({ ...DEFAULT_SETTINGS, ...saved, mode: saved.mode === 'reset' ? 'reset' : 'window' }))
    await $.command.register({
      name: 'token-range',
      description: 'Token Range Monitor: open the pane, or set what the weekly average covers (/token-range 2d, /token-range 6h, /token-range reset)',
      argumentHint: '[window | reset]',
    })
    await loadAll($)
    await loadTheme($)
    await capture($, (await $.session.usage()).rateLimits)
    // once a minute: pick up other sessions' readings and move "now" along
    $.clock.every(60_000, async () => {
      await followAccount($)
      await loadAll($)
      await loadTheme($)   // picks up a theme file edited in place
      await capture($, (await $.session.usage()).rateLimits)
      await update($, tick, n => n + 1)
    })
    return next(e)
  })

  // a turn's end and each tool call both follow a response, so the figures are fresh then;
  // the once-a-minute check above only re-reads the last response's figures, so it isn't watching
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await capture($, e.rateLimits)
    await watch($)
    return next(e)
  })

  // a theme switched from /theme, the menu or another plugin redraws the card at once
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    await loadTheme($)
    return result
  }).catch(($, e, next) => next(e))   // never stands in the way of the theme change itself

  on('tool.call', async ($, e, next) => {
    await watch($)
    return next(e)
  })

  on('command.run', { command: 'token-range' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    await $.ui.open({ id: PANE, title: TITLE })
    if (!arg) return { text: 'Token Range Monitor opened.' }
    if (arg === 'reset' || arg === 'since reset') {
      await choose($, { mode: 'reset' })
      return { text: 'Weekly average now covers the time since the reset.' }
    }
    const w = parseWindow(arg)
    if (!w) return { text: `Couldn't read "${arg}". Use a window like 6h or 2d (at most 7d), or "reset".` }
    await setWindow($, w.unit === 'h' ? w.n : w.n * (w.unit === 'w' ? 7 : 1), w.unit === 'h' ? 'h' : 'd')
    // held to what's on offer: under 6 hours becomes 6
    const avg: Average = { type: 'hours', hours: windowHours(await read($, settings)) }
    return { text: `Weekly average now uses the last ${averageName(avg)}.` }
  })

  // C: one line above the prompt
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { now, s, week, five } = await models($)
    void now
    if (!week && !five) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        {week && (
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>Left at week reset</Text>
            <Text bold dimColor={!!week.noData} color={week.noData ? undefined : week.over ? 'error' : 'success'}>{leftText(week)}</Text>
            <Button key="reset-week" plain dimColor label={resetsIn(week, s.fine)} onPress={() => toggleFine($)} />
          </Box>
        )}
        {week && five && <Text dimColor>·</Text>}
        {five && (
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>Left at 5h reset</Text>
            <Text bold dimColor={!!five.noData} color={five.noData ? undefined : five.over ? 'error' : 'success'}>{leftText(five)}</Text>
          </Box>
        )}
        <Button key="details" label="Details" onPress={() => void $.ui.open({ id: PANE, title: TITLE })} />
      </Box>
    )
  })

  // B: the side pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { now, s, week, five, pal, pace, weekRecorded } = await models($)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : null
    // both cards fit the pane: charts drawn at its width, sharing the height that's left
    const size = fit(e.props.bodyColumns, e.props.scroll?.bodyRows, week, five, s.mode === 'window', now)
    // the weekly head carries the 1hr pace, its info circle opening a tooltip over the chart: head and chart are one drawing
    const weekDrawing = (m: Model) => {
      const chart = emptyChartText(m, now) ? emptyChartSvg(m, now, size.width, pal) : weekChart(m, now, size.width, pal, size.weekHeight)
      if (!pace) return chart
      const head = headerDraw(m, 'This week', size.headWidth, pal, resetsIn(m, s.fine), pace)
      return withInfo(head, chart, `${paceText(pace)}\n${paceExplain(pace)}`, size.width, pal)
    }

    // one dark card per limit, as on the car's display: head, chart, controls, then the notes
    // `chart` may hold the head too (the weekly card with its pace): then no separate head is drawn
    const block = (title: string, m: Model, chart: string | null, controls: JSX.Element | null, notes: string[]) => {
      const headInChart = !!chart?.includes('class="info"')
      return (
      <Box
        key={`block-${m.kind}`}
        flexDirection="column"
        gap={1}
        marginBottom={1}
        padding={2}
        borderStyle="round"
        borderColor="userMessageBackground"
        backgroundColor="userMessageBackground"
      >
        {/* the countdown is drawn in the head, at its right, so its text takes the drawing's styles */}
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" columnGap={2}>
          {Svg ? (headInChart ? null :
            <Svg
              source={headerSvg(m, title, size.headWidth, pal, resetsIn(m, s.fine))}
              alt={`${title}. ${resetsIn(m, s.fine)}. ${isShort(m) ? `${runsOut(m)}. ` : ''}Left at reset ${leftText(m)}, average ${m.noData ? 'no data' : rateText(m, m.rate)}, limit ${rateText(m, m.limit)}.`}
            />
          ) : (
            <Box flexDirection="column">
              <Text bold>{title}</Text>
              {isShort(m) && <Text color="error">{runsOut(m)}</Text>}
              <Text>
                {`${m.kind === 'week' ? 'Left at week reset' : 'Left at 5h reset'} ${leftText(m)} · Average ${m.noData ? 'no data' : rateText(m, m.rate)} · Limit ${rateText(m, m.limit)}${m.kind === 'week' && pace ? ` · 1hr pace ${pace.ready ? `${fx(pace.rate * 24)}%/day` : 'no data'}` : ''}`}
              </Text>
            </Box>
          )}
          {!Svg && <Button key={`reset-${m.kind}`} plain label={resetsIn(m, s.fine)} onPress={() => toggleFine($)} />}
        </Box>
        {chart && Svg && (
          <Svg
            source={chart}
            isInteractive={headInChart || undefined}
            alt={`${headInChart ? `${title}. ${resetsIn(m, s.fine)}. ${isShort(m) ? `${runsOut(m)}. ` : ''}Left at reset ${leftText(m)}, average ${m.noData ? 'no data' : rateText(m, m.rate)}, limit ${rateText(m, m.limit)}. ${pace ? `1hr pace ${pace.ready ? `${fx(pace.rate * 24)}%/day` : 'no data'}. ${paceText(pace)} ${paceExplain(pace)} ` : ''}` : ''}${emptyChartText(m, now) ? emptyChartText(m, now)!.join('. ') : `${averageNote(m)} Average ${rateText(m, m.rate)}, limit ${rateText(m, m.limit)}.`}`}
          />
        )}
        {controls}
        <Box flexDirection="column" marginTop={controls ? 2 : 0}>
          {notes.map(note => (Svg
            ? <Svg source={noteSvg(note, size.width, pal)} alt={note} />
            : <Text color="inactive">{note}</Text>))}
        </Box>
      </Box>
      )
    }

    // the window selector: native widgets, so hover, focus and clicks are the surface's own
    const unit = s.unit === 'h' ? 'h' : 'd'
    const n = clampWindow(s.n, unit)
    const isCustom = s.mode === 'window'
    const seg = (key: string, label: string, isOn: boolean, onPress: () => void, off = false) => (
      <Button key={key} label={label} variant={isOn && !off ? 'primary' : 'secondary'} dimColor={!isOn || off} onPress={() => { if (!off) onPress() }} />
    )
    // until there's enough recorded for a weekly average, there's nothing to choose between: the choices dim and do nothing
    const choicesOff = weekRecorded < MIN_RECORDED_H.week
    const windowControls = (
      // a block at the right under the chart: what the average covers, and for a custom window its length beneath
      <Box flexDirection="column" alignSelf="flex-end" alignItems="flex-start" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
          {seg('mode-reset', 'Since reset', s.mode === 'reset', () => void choose($, { mode: 'reset' }), choicesOff)}
          {seg('mode-custom', 'Custom', isCustom, () => void setWindow($, n, unit), choicesOff)}
        </Box>
        {isCustom && !choicesOff && (
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
            <Text color="inactive">Last</Text>
            <Button key="win-dec" label="−" dimColor={n <= UNIT_MIN[unit]} onPress={() => void setWindow($, n - 1, unit)} />
            <Text bold color="text">{` ${n} `}</Text>
            <Button key="win-inc" label="+" dimColor={n >= UNIT_MAX[unit]} onPress={() => void setWindow($, n + 1, unit)} />
            {seg('unit-h', 'hours', unit === 'h', () => void setWindow($, n, 'h'))}
            {seg('unit-d', 'days', unit === 'd', () => void setWindow($, n, 'd'))}
          </Box>
        )}
      </Box>
    )

    if (!week && !five) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>No usage limits reported yet.</Text>
          <Text dimColor>They arrive with Claude's next response, on a Pro or Max subscription.</Text>
        </Box>
      )
    }

    return (
      <Box key="cards" flexDirection="column">
        {week
          ? block('This week', week, Svg ? weekDrawing(week) : null, windowControls, [
            ...(Svg && emptyChartText(week, now) ? [] : [averageNote(week)]),
          ])
          : <Text dimColor>No weekly limit reported.</Text>}
        {five
          ? block('5-hour window', five, Svg ? (emptyChartText(five, now) ? emptyChartSvg(five, now, size.width, pal) : fiveChart(five, now, size.width, pal, size.fiveHeight)) : null, null, Svg && emptyChartText(five, now) ? [] : [averageNote(five)])
          : <Text dimColor>No active 5-hour window.</Text>}
      </Box>
    )
  })
}
