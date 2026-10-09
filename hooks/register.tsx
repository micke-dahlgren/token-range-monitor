import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { RangeReading, RangeSettings, RangeStep, RangeWatch } from '../types'
import {
  DEFAULT_SETTINGS, KEEP, MIN, heartbeat, MIN_RECORDED_H, UNIT_MAX, UNIT_MIN, averageName, clampWindow, averageNote, chosenAverage,
  drawingHeight, emptyChartSvg, emptyChartText, fit, fx, headerDraw, paceExplain, paceText, recentPace, withInfo, fiveChart, headerSvg, noteSvg, merge, parseWindow, project, rateText, recordedHours, resetsIn,
  isShort, leftText, runsOut, weekChart, windowHours,
} from './range'
import type { Average, Model } from './range'
import { DEFAULT_PALETTES, palettesFor, resolveTheme } from './theme'
import { baselineOf, learn, mergeSteps, MODELS_INFO, modelsCosts, modelsHead, modelsSpend, modelsText, shortNames, spend, units } from './models'

const PANE = 'token-range-monitor'
const TITLE = 'Token Range Monitor'
const readings = atom({ plugin: 'token-range-monitor', key: 'readings' } as const, [])
const settings = atom({ plugin: 'token-range-monitor', key: 'settings' } as const, DEFAULT_SETTINGS)
const tick = atom({ plugin: 'token-range-monitor', key: 'tick' } as const, 0)
const seen = atom({ plugin: 'token-range-monitor', key: 'seen' } as const, [])
const palettes = atom({ plugin: 'token-range-monitor', key: 'palettes' } as const, DEFAULT_PALETTES)
const steps = atom({ plugin: 'token-range-monitor', key: 'steps' } as const, [])

/**
 * Usage limits are the account's, so the record is too: everything is stored
 * under the signed-in account (`<account>/`), and signing in to another
 * account starts from that account's own record. Within it each session
 * writes its readings under its own key (`r:`), and the spans it was watching
 * under the twin key (`w:`), so sessions never overwrite each other, and every
 * session reads them all. The responses it saw, each one's model and tokens,
 * go under a third (`u:`).
 */
let account = ''
const OWN = 'r:'
const SEEN = 'w:'
const STEPS = 'u:'
const ownPrefix = () => `${account}/${OWN}`
const seenKeyOf = (key: string) => key.replace(`/${OWN}`, `/${SEEN}`)
const stepsKeyOf = (key: string) => key.replace(`/${OWN}`, `/${STEPS}`)
const newOwnKey = (now: number) => `${ownPrefix()}${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
/** A stored list's key: whose (none for a record kept before accounts), and which kind. */
const parseKey = (key: string) => /^(?:(.+)\/)?([rwu]):/.exec(key)

let ownKey = ''
let own: RangeReading[] = []
let ownSeen: RangeWatch[] = []
let othersSeen: RangeWatch[] = []
let ownSteps: RangeStep[] = []
let othersSteps: RangeStep[] = []

/**
 * The signed-in account and organisation, from Claude Code's own config:
 * the limits belong to both. `none` off a subscription, which has no limits.
 */
let accountRead: { mtime: number; account: string } | undefined
async function accountOf($: EngineInterface): Promise<string | null> {
  try {
    const dir = await $.env.get('CLAUDE_CONFIG_DIR')
    const file = dir ? `${dir}/.claude.json` : `${(await $.env.get('HOME')) ?? ''}/.claude.json`
    // the file is read again only once it changed
    const { mtimeMs } = await $.fs.stat(file)
    if (accountRead?.mtime === mtimeMs) return accountRead.account
    const o = (JSON.parse(await $.fs.read(file)) as { oauthAccount?: { accountUuid?: string; organizationUuid?: string } }).oauthAccount
    const a = o?.accountUuid ? `${o.accountUuid}.${o.organizationUuid ?? ''}` : 'none'
    accountRead = { mtime: mtimeMs, account: a }
    return a
  } catch {
    // unreadable (mid-write, say): no answer, which is no sign-in elsewhere
    return null
  }
}

/** Follows a sign-in to another account: this session starts a fresh list under it. True when it moved. */
async function followAccount($: EngineInterface): Promise<boolean> {
  const now = await $.clock.now()
  const a = (await accountOf($)) ?? (account || 'none')
  if (a === account) return false
  account = a
  ownKey = newOwnKey(now)
  own = []
  ownSeen = []
  ownSteps = []
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
      // a file being written as it's read is skipped this time, the others still count
      try {
        out.push(...Object.entries(JSON.parse(await $.fs.read(`${stores}/${f.name}`)) as Record<string, unknown>))
      } catch { /* next minute */ }
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
  const stepLists: RangeStep[][] = []
  // the other copies' lists, read as they stand; this copy's own file is among them, and merging drops the repeats
  for (const [key, value] of await otherCopies($)) {
    const k = parseKey(key)
    if (!k || !Array.isArray(value) || (k[1] !== undefined && k[1] !== account)) continue
    if (k[2] === 'w') spans.push(...(value as RangeWatch[]))
    else if (k[2] === 'u') stepLists.push(value as RangeStep[])
    else lists.push(value as RangeReading[])
  }
  for (const key of await $.store.keys()) {
    const k = parseKey(key)
    if (!k || key === ownKey || key === seenKeyOf(ownKey) || key === stepsKeyOf(ownKey)) continue
    const [, whose, kind] = k
    const list = ((await $.store.get(key)) ?? []) as Array<RangeReading | RangeWatch | RangeStep>
    // drop lists once everything in them has aged out, whichever account's
    const end = (x: RangeReading | RangeWatch | RangeStep) => (kind === 'w' ? (x as RangeWatch)[1] : x[0])
    if (list.every(x => end(x) < now - KEEP)) { await $.store.delete(key); continue }
    if (whose === undefined) {
      // a record kept before accounts: it was this account's, so it moves under it
      await $.store.set(`${account}/${key}`, list)
      await $.store.delete(key)
    } else if (whose !== account) continue
    if (kind === 'w') spans.push(...(list as RangeWatch[]))
    else if (kind === 'u') stepLists.push(list as RangeStep[])
    else lists.push(list as RangeReading[])
  }
  othersSeen = spans
  othersSteps = mergeSteps(stepLists, now)
  await update($, steps, () => mergeSteps([othersSteps, ownSteps], now))
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

/** Notes one response: its model, effort and weighted tokens. Saved at most every 30 seconds. */
let stepsSavedAt = 0
let stepsUnsaved = false
async function record($: EngineInterface, step: RangeStep) {
  const now = step[0]
  if (!ownKey) ownKey = newOwnKey(now)
  ownSteps = [...ownSteps.filter(s => s[0] >= now - KEEP), step]
  stepsUnsaved = true
  if (now - stepsSavedAt > 30_000) await saveSteps($, now)
  await update($, steps, list => [...list, step])
}
async function saveSteps($: EngineInterface, now: number) {
  if (!stepsUnsaved || !ownKey) return
  stepsSavedAt = now
  stepsUnsaved = false
  await $.store.set(stepsKeyOf(ownKey), ownSteps)
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
let themeFile: { slug: string; path: string } | undefined
async function loadTheme($: EngineInterface) {
  const setting = ((await $.settings.read()) as { theme?: unknown }).theme
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const theme = await resolveTheme(setting, async slug => {
    // found once, then read where it was; searched again only if it's gone
    if (themeFile?.slug === slug && await $.fs.exists(themeFile.path)) return await $.fs.read(themeFile.path)
    const own = `${dir}/themes/${slug}.json`
    if (await $.fs.exists(own)) { themeFile = { slug, path: own }; return await $.fs.read(own) }
    // plugins are cached as cache/<marketplace>/<plugin>/<version>/
    const cache = `${dir}/plugins/cache`
    for (const m of await $.fs.list(cache).catch(() => [])) {
      for (const pl of await $.fs.list(`${cache}/${m.name}`).catch(() => [])) {
        for (const ver of await $.fs.list(`${cache}/${m.name}/${pl.name}`).catch(() => [])) {
          const file = `${cache}/${m.name}/${pl.name}/${ver.name}/themes/${slug}.json`
          if (await $.fs.exists(file)) { themeFile = { slug, path: file }; return await $.fs.read(file) }
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
  const weekAvg = chosenAverage(s)
  // the 5-hour average runs from the window's opening: Anthropic's own figure, and the chart shows the whole window
  const fiveAvg: Average = { type: 'reset' }
  const week = project(list, 'week', now, weekAvg, watched)
  return {
    now, s, weekRecorded, pal, week,
    five: project(list, 'five', now, fiveAvg, watched),
    pace: week ? recentPace(list, week, now, watched) : null,
    learned: learn(list, await read($, steps), watched, now),
    steps: await read($, steps),
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
      await saveSteps($, await $.clock.now())
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

  // every model response, main and subagents': its model, effort and tokens, for learning what each model costs
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      if (r?.usage) await record($, [await $.clock.now(), r.usage.model || e.model, e.effort === undefined ? '' : String(e.effort), units(r.usage), e.agentId ? 1 : 0])
    } catch { /* never in the way of the response */ }
    return r
  })

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
            <Button key="reset-five" plain dimColor label={resetsIn(five, s.fine)} onPress={() => toggleFine($)} />
          </Box>
        )}
        <Button key="details" label="Details" onPress={() => void $.ui.open({ id: PANE, title: TITLE })} />
      </Box>
    )
  })

  // B: the side pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { now, s, week, five, pal, pace, weekRecorded, learned, steps: stepList } = await models($)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : null
    // both cards fit the pane: charts drawn at its width, sharing the height that's left
    const size = fit(e.props.bodyColumns)
    // the weekly head carries the 1hr pace, its info circle opening a tooltip over the chart: head and chart are one drawing
    const weekDrawing = (m: Model) => {
      const chart = emptyChartText(m, now) ? emptyChartSvg(m, now, size.width, pal) : weekChart(m, now, size.width, pal, size.weekHeight)
      if (!pace) return chart
      const head = headerDraw(m, 'This week', size.width, pal, resetsIn(m, s.fine), pace)
      return withInfo(head, chart, `${paceText(pace)}\n${paceExplain(pace)}`, size.width, pal)
    }

    // one dark card per limit, as on the car's display: head, chart, controls, then the notes
    // every drawing in a frame as wide as the card, given its height: it fills the width, and its text keeps its size
    const Draw = ({ svg, alt }: { svg: string; alt: string }) =>
      Svg ? <Svg source={svg} height={drawingHeight(svg)} isInteractive alt={alt} /> : null
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
        {!headInChart && <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" columnGap={2}>
          {Svg ? (
            <Draw
              svg={headerSvg(m, title, size.width, pal, resetsIn(m, s.fine))}
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
        </Box>}
        {/* the chart and its controls are one unit: the controls stay right under the chart */}
        <Box key={`graph-${m.kind}`} flexDirection="column" gap={1}>
          {chart && Svg && (
            <Draw
              svg={chart}
              alt={`${headInChart ? `${title}. ${resetsIn(m, s.fine)}. ${isShort(m) ? `${runsOut(m)}. ` : ''}Left at reset ${leftText(m)}, average ${m.noData ? 'no data' : rateText(m, m.rate)}, limit ${rateText(m, m.limit)}. ${pace ? `1hr pace ${pace.ready ? `${fx(pace.rate * 24)}%/day` : 'no data'}. ${paceText(pace)} ${paceExplain(pace)} ` : ''}` : ''}${emptyChartText(m, now) ? emptyChartText(m, now)!.join('. ') : `${averageNote(m)} Average ${rateText(m, m.rate)}, limit ${rateText(m, m.limit)}.`}`}
            />
          )}
          {controls}
        </Box>
        <Box flexDirection="column" marginTop={controls ? 1 : 0}>
          {notes.map(note => (Svg
            ? <Draw svg={noteSvg(note, size.width, pal)} alt={note} />
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

    // the models card: each model's cost against the baseline, and this week's points by model and effort
    const base = baselineOf(learned, s.baseline)
    const sp = week ? spend(week, learned, stepList, now) : null
    const shown = learned.models.filter(m => m.shown)
    const names = shortNames(shown)
    const modelsCard = (
      <Box key="block-models" flexDirection="column" gap={1} marginBottom={1} padding={2} borderStyle="round" borderColor="userMessageBackground" backgroundColor="userMessageBackground">
        {Svg ? (
          <>
            {/* the head's info circle opens its tooltip over the rows: head and rows are one drawing */}
            <Draw svg={withInfo(modelsHead(learned, now, pal), modelsCosts(learned, base, size.width, pal), MODELS_INFO, size.width, pal, 'What do these figures mean?')} alt={`Models. ${modelsText(learned, base, null).join(' ')}`} />
            {base && (
              <Box flexDirection="row" flexWrap="wrap" justifyContent="flex-end" alignItems="center" columnGap={1} rowGap={1}>
                <Text color="inactive">Compare with</Text>
                {shown.map(m => seg(`base-${m.id}`, names.get(m.id) ?? m.name, m === base, () => void choose($, { baseline: m.id })))}
              </Box>
            )}
            {sp && <Draw svg={modelsSpend(sp, size.width, pal)} alt={modelsText({ ...learned, models: [] }, null, sp).join(' ')} />}
          </>
        ) : (
          <Box flexDirection="column">
            <Text bold>Models</Text>
            {modelsText(learned, base, sp).map(line => <Text>{line}</Text>)}
            {base && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Text color="inactive">Compare with</Text>
                {shown.map(m => seg(`base-${m.id}`, names.get(m.id) ?? m.name, m === base, () => void choose($, { baseline: m.id })))}
              </Box>
            )}
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
        {modelsCard}
      </Box>
    )
  })
}
