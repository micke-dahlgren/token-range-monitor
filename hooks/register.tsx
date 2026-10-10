import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { RangeReading, RangeSettings, RangeStep, RangeSync, RangeWatch } from '../types'
import {
  DEFAULT_SETTINGS, KEEP, MIN, heartbeat, MIN_RECORDED_H, UNIT_MAX, UNIT_MIN, averageName, clampWindow, averageNote, chosenAverage,
  emptyChartSvg, emptyChartText, fit, fiveChart, LAST_INFO, LAST_LABEL, lastIsShort, lastWindow, lastWindowNote, lastWindowText, headerSvg, noteSvg, merge, parseWindow, project, rateText, recordedHours, resetsIn,
  bandPart, bandWidth, isShort, leftText, paceText, refine, runsOut, weekChart, windowHours,
} from './range'
import type { Average, LastWindow, Model } from './range'
import { DEFAULT_PALETTES, palettesFor, resolveTheme } from './theme'
import { baselineOf, learn, mergeSteps, MODELS_INFO, modelsCosts, modelsHead, modelsSpend, modelsText, shortNames, spend, units } from './models'
import {
  agoText, cancelSignIn, cleanName, configureSync, DEVICE_KEY, DEVICES_FRESH, deleteSynced, deviceLabel, downloadedFor, endSync, GENERIC_NAMES, isDeviceId,
  NAME_KEY, platformOf, refreshDevices, removeDevice, signIn, signOut, startSync, syncTick,
} from './sync'
import type { Lists, Platform, SyncIO } from './sync'

const PANE = 'token-range-monitor'
const TITLE = 'Token Range Monitor'
const readings = atom({ plugin: 'token-range-monitor', key: 'readings' } as const, [])
const settings = atom({ plugin: 'token-range-monitor', key: 'settings' } as const, DEFAULT_SETTINGS)
const tick = atom({ plugin: 'token-range-monitor', key: 'tick' } as const, 0)
const seen = atom({ plugin: 'token-range-monitor', key: 'seen' } as const, [])
const palettes = atom({ plugin: 'token-range-monitor', key: 'palettes' } as const, DEFAULT_PALETTES)
const steps = atom({ plugin: 'token-range-monitor', key: 'steps' } as const, [])
/**
 * A drawing as a plain image: the drawings are made for a frame (a wide canvas, filled to the frame's width), so as
 * an image each gets the width it was laid out for and a viewBox, and scales evenly to the width it's shown at.
 */
const asImage = (svg: string, width: number) =>
  svg.replace(/^<svg ([^>]*?)width="\d+" height="(\d+)">/, (_, attrs: string, h: string) =>
    `<svg ${attrs}width="${Math.round(width)}" height="${h}" viewBox="0 0 ${Math.round(width)} ${h}" preserveAspectRatio="xMidYMin meet">`)
/** Which cards' Details blocks are open: `week`, `five`, `models`. */
const details = atom({ plugin: 'token-range-monitor', key: 'details' } as const, [] as string[])
/** What the pane's sync row shows; sync itself (./sync) keeps it through syncIO. */
const syncView = atom({ plugin: 'token-range-monitor', key: 'sync' } as const, { status: 'signedOut' } as RangeSync)

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

/** The home folder: HOME, or on Windows, where the desktop app often leaves HOME unset, USERPROFILE. */
async function homeOf($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
}

/**
 * The signed-in account and organisation, from Claude Code's own config:
 * the limits belong to both. `none` off a subscription, which has no limits.
 */
let accountRead: { mtime: number; account: string } | undefined
async function accountOf($: EngineInterface): Promise<string | null> {
  try {
    const dir = await $.env.get('CLAUDE_CONFIG_DIR')
    const file = dir ? `${dir}/.claude.json` : `${await homeOf($)}/.claude.json`
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
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await homeOf($)}/.claude`
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

/**
 * Every list recorded on this computer for the signed-in account: this
 * session's, the other sessions', the other copies'. Lists other devices
 * synced are not among them (they are kept under `sync:` keys).
 */
async function localLists($: EngineInterface, now: number) {
  const lists: RangeReading[][] = [own]
  const spans: RangeWatch[] = []
  const stepLists: RangeStep[][] = []
  // the other copies' lists, read as they stand; this copy's own file is among them, and merging drops the repeats
  for (const [key, value] of await otherCopies($)) {
    const k = parseKey(key)
    // a record kept under none was this account's too (see below)
    if (!k || !Array.isArray(value) || (k[1] !== undefined && k[1] !== account && !(k[1] === 'none' && account !== 'none'))) continue
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
    } else if (whose === 'none' && account && account !== 'none') {
      // kept while the account couldn't be read (HOME unset, as on Windows): only a subscription reports
      // limits, so the record was this account's all along, and it moves under it
      await $.store.set(`${account}/${key.slice('none/'.length)}`, list)
      await $.store.delete(key)
    } else if (whose !== account) continue
    if (kind === 'w') spans.push(...(list as RangeWatch[]))
    else if (kind === 'u') stepLists.push(list as RangeStep[])
    else lists.push(list as RangeReading[])
  }
  return { lists, spans, stepLists }
}

/** What this computer recorded, this session's unsaved part included: what sync uploads. */
async function collectLocal($: EngineInterface): Promise<Lists> {
  const { lists, spans, stepLists } = await localLists($, await $.clock.now())
  return { readings: lists, spans: [...spans, ...ownSeen], steps: [...stepLists, ownSteps] }
}

/** A device id another copy's store already holds, so every copy on this computer syncs as one device. */
async function peekDevice($: EngineInterface): Promise<string | undefined> {
  for (const [key, value] of await otherCopies($)) if (key === DEVICE_KEY && isDeviceId(value)) return value
  return undefined
}

/**
 * The computer's own name, for the server's device list: the environment's
 * (COMPUTERNAME on Windows, HOSTNAME where the shell exports it), else a host
 * command's where one can run (`scutil --get ComputerName` on macOS, `hostname`
 * elsewhere; CLI only, kept in the store for sessions that can't run one),
 * else a generic name for the platform ("Mac", "Windows PC", "Linux computer").
 */
async function hostName($: EngineInterface): Promise<string> {
  const fromEnv = cleanName(await $.env.get('COMPUTERNAME').catch(() => undefined)) ?? cleanName(await $.env.get('HOSTNAME').catch(() => undefined))
  if (fromEnv) return fromEnv
  const platform = platformOf({
    os: await $.env.get('OS').catch(() => undefined),
    cfEncoding: await $.env.get('__CF_USER_TEXT_ENCODING').catch(() => undefined),
    home: await $.env.get('HOME').catch(() => undefined),
  })
  const found = await commandName($, platform)
  if (found) {
    await $.store.set(NAME_KEY, found).catch(() => undefined)
    return found
  }
  return cleanName(await $.store.get(NAME_KEY).catch(() => undefined)) ?? GENERIC_NAMES[platform]
}

/** The name a host command prints, or null: no command runs here (the desktop), it failed, or it took over 3 s. */
async function commandName($: EngineInterface, platform: Platform): Promise<string | null> {
  if (platform === 'windows') return null
  try {
    const r = await $.process.run(platform === 'mac' ? ['scutil', '--get', 'ComputerName'] : ['hostname'], { timeoutMs: 3_000 })
    return r.exitCode === 0 ? cleanName(r.stdout.split('\n')[0]) : null
  } catch {
    return null
  }
}

/** Opens the pane, and asks for the device list if it wasn't asked for just now. */
async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
  void refreshDevices(syncIO($), DEVICES_FRESH).catch(() => undefined)
}

/** What sync reaches through the engine: every call on `$` spelled here, in the hooks module. */
function syncIO($: EngineInterface): SyncIO {
  return {
    now: () => $.clock.now(),
    fetch: (url, init) => $.http.fetch(url, init),
    get: key => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
    del: key => $.store.delete(key),
    keys: () => $.store.keys(),
    trafficOff: () => $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'),
    hostName: () => hostName($),
    every: (ms, fn) => $.clock.every(ms, fn),
    after: (ms, fn) => $.clock.after(ms, fn),
    log: (text, options) => $.ui.log(text, options),
    view: () => read($, syncView),
    setView: async change => { await update($, syncView, change) },
    account: () => account,
    collect: () => collectLocal($),
    reload: () => loadAll($),
    peekDevice: () => peekDevice($),
  }
}

async function loadAll($: EngineInterface) {
  const now = await $.clock.now()
  const { lists, spans, stepLists } = await localLists($, now)
  // the other devices' lists, as synced: read beside this computer's, merging drops the repeats
  const far = await downloadedFor(syncIO($), account)
  lists.push(...(far.readings as RangeReading[][]))
  spans.push(...far.spans)
  stepLists.push(...(far.steps as RangeStep[][]))
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
let seenShownAt = 0
async function watch($: EngineInterface) {
  const now = await $.clock.now()
  if (!ownKey) ownKey = newOwnKey(now)
  const before = ownSeen.length
  ownSeen = heartbeat(ownSeen, now)
  if (ownSeen.length !== before || now - seenSavedAt > 30_000) {
    seenSavedAt = now
    await $.store.set(seenKeyOf(ownKey), ownSeen)
  }
  // a redraw for a new span, else at most every 30 seconds: each response would redraw the pane otherwise
  if (ownSeen.length !== before || now - seenShownAt >= 30_000) {
    seenShownAt = now
    await update($, seen, () => [...othersSeen, ...ownSeen])
  }
}

/** Notes one response: its model, effort and weighted tokens. Saved at most every 30 seconds. */
let stepsSavedAt = 0
let stepsShownAt = 0
let stepsUnsaved = false
async function record($: EngineInterface, step: RangeStep) {
  const now = step[0]
  if (!ownKey) ownKey = newOwnKey(now)
  ownSteps = [...ownSteps.filter(s => s[0] >= now - KEEP), step]
  stepsUnsaved = true
  if (now - stepsSavedAt > 30_000) await saveSteps($, now)
  // the models card follows at most every 30 seconds, not on every response: the minute's loadAll catches up the rest
  if (now - stepsShownAt >= 30_000) {
    stepsShownAt = now
    await update($, steps, () => mergeSteps([othersSteps, ownSteps], now))
  }
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
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await homeOf($)}/.claude`
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
  // the drawings' time, up to the next whole minute: a redraw with nothing new (a scroll, a response, the minute's tick)
  // then draws the very same drawings, which the surface keeps instead of loading them again (that flashed)
  const now = Math.ceil((await $.clock.now()) / MIN) * MIN
  const weekRecorded = recordedHours(list, 'week', now)
  const weekAvg = chosenAverage(s)
  // the 5-hour average runs from the window's opening: Anthropic's own figure, and the chart shows the whole window
  const fiveAvg: Average = { type: 'reset' }
  const stepList = await read($, steps)
  const learned = learn(list, stepList, watched, now)
  const projected = project(list, 'week', now, weekAvg, watched)
  // the bars follow the responses behind each rise, each weighed by its model's cost where that's known
  const shown = learned.models.filter(m => m.shown)
  const usual = shown.length ? shown.reduce((a, m) => a + m.w, 0) / shown.length : 1
  const weightOf = new Map(learned.models.map(m => [m.id, m.shown ? m.w : usual]))
  const work = stepList.map(st => [st[0], st[3] * (weightOf.get(st[1]) ?? usual)] as const)
  const shaped = (m: Model | null) => (m ? { ...m, increments: refine(m.increments, work) } : null)
  const week = shaped(projected)
  return {
    now, s, weekRecorded, pal, week,
    five: shaped(project(list, 'five', now, fiveAvg, watched)),
    // how each limit's previous window ended, where the record can tell
    lastWeek: lastWindow(list, 'week', now, watched),
    lastFive: lastWindow(list, 'five', now, watched),
    learned,
    steps: stepList,
  }
}

async function choose($: EngineInterface, change: Partial<RangeSettings>) {
  await update($, settings, s => ({ ...s, ...change }))
  await $.store.set('settings', await read($, settings))
}

/** Sets the weekly window: any length, one that can't give an estimate yet saying so in the chart's place. */
async function setWindow($: EngineInterface, n: number, unit: 'h' | 'd') {
  await choose($, { mode: 'window', n: clampWindow(n, unit), unit })
}

export const register: Register = (on, options) => {
  configureSync(options.syncServer)

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
    await startSync(syncIO($))
    await loadAll($)
    // a theme that can't be read leaves the card's default colours, never the rest of the start
    await loadTheme($).catch(() => undefined)
    await capture($, (await $.session.usage()).rateLimits)
    // the first sync waits for the session to be under way: nothing on the network holds up its start
    $.clock.after(1_000, () => void syncTick(syncIO($), true))
    // once a minute: pick up other sessions' readings and move "now" along; sync when it's due
    $.clock.every(60_000, async () => {
      await saveSteps($, await $.clock.now())
      const moved = await followAccount($)
      await loadAll($)
      await loadTheme($).catch(() => undefined)   // picks up a theme file edited in place
      await capture($, (await $.session.usage()).rateLimits)
      await update($, tick, n => n + 1)
      // another account's record syncs at once
      await syncTick(syncIO($), moved)
    })
    return next(e)
  })

  // at the end, the responses not yet saved are, and sync uploads once more
  on('session.end', async ($, e, next) => {
    try {
      await saveSteps($, await $.clock.now())
      await endSync(syncIO($))
    } catch { /* never in the way of the exit */ }
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
    await openPane($)
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
    const { week, five } = await models($)
    if (!week && !five) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const limits = [week, five].filter((m): m is Model => !!m)
    // the full line where it fits, else the short one, so the band stays one line in a narrow column
    const short = bandWidth(limits, false) > e.props.bodyColumns
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        {limits.flatMap((m, i) => {
          const p = bandPart(m, short)
          return [
            ...(i ? [<Text key={`sep-${m.kind}`} dimColor>·</Text>] : []),
            <Box key={`band-${m.kind}`} flexDirection="row">
              <Text dimColor>{p.label} </Text>
              <Text bold dimColor={!!m.noData} color={m.noData ? undefined : m.over ? 'error' : 'success'}>{p.value}</Text>
              {p.rest && <Text dimColor>{p.rest}</Text>}
            </Box>,
          ]
        })}
        <Button key="details" label="Details" onPress={() => void openPane($)} />
      </Box>
    )
  })

  // B: the side pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { now, s, week, five, pal, lastWeek, lastFive, weekRecorded, learned, steps: stepList } = await models($)
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    const sync = await read($, syncView)
    // the real time for the sync row's texts: `now` is the drawings', rounded up to the minute
    const clockNow = await $.clock.now()
    // the terminal draws no Svg: there the cards are text
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null
    // both cards fit the pane: charts drawn at its width, sharing the height that's left
    const size = fit(e.props.bodyColumns)
    const lastOf = (m: Model) => (m.kind === 'week' ? lastWeek : lastFive)
    const cardDrawing = (m: Model) => emptyChartText(m, now) ? emptyChartSvg(m, now, size.width, pal)
      : m.kind === 'week' ? weekChart(m, now, size.width, pal, size.weekHeight) : fiveChart(m, now, size.width, pal, size.fiveHeight)
    // a card's explanation behind a Details button, a paragraph a line; nothing to say, no button
    const open = await read($, details)
    const detailsBlock = (key: string, paragraphs: string[]) => {
      if (!paragraphs.length) return null
      const isOpen = open.includes(key)
      return (
        <Box key={`details-${key}`} flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key={`details-btn-${key}`} plain dimColor label={isOpen ? 'Hide details' : 'Details'}
              onPress={() => void update($, details, l => (l.includes(key) ? l.filter(k => k !== key) : [...l, key]))} />
          </Box>
          {isOpen && paragraphs.map((para, i) => <Text key={`details-${key}-${i}`} dimColor>{para}</Text>)}
        </Box>
      )
    }
    // the head's figures in words, for a drawing's alt text
    const figuresText = (m: Model) =>
      `At reset ${leftText(m)}, your pace ${m.noData ? 'no data' : rateText(m, m.rate)}, safe pace ${rateText(m, m.limit)}.${paceText(m) ? ` ${paceText(m)}` : ''}`
    const lastAlt = (last: LastWindow | null) => (last ? `${LAST_LABEL} ${lastWindowText(last)}. ${lastWindowNote(last)} ` : '')

    // one dark card per limit, as on the car's display: head, chart, controls, then the notes
    // every drawing a plain image, never interactive: the surface loads an interactive drawing (a sandboxed frame)
    // again on every redraw, a scroll's too, and that flashed. A plain function, not a component, each drawing keyed;
    // its height left out, so it follows the drawing's proportions at whatever width it's shown
    const draw = (key: string, svg: string, alt: string) =>
      Svg ? <Svg key={key} source={asImage(svg, size.width)} alt={alt} /> : null
    const block = (title: string, m: Model, chart: string | null, controls: JSX.Element | null, notes: string[]) => {
      const last = lastOf(m)
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
          {Svg ? (
            draw(`head-${m.kind}`, headerSvg(m, title, size.width, pal, resetsIn(m), last),
              `${title}. ${resetsIn(m)}. ${isShort(m) ? `${runsOut(m)}. ` : ''}${figuresText(m)} ${lastAlt(last)}`)
          ) : (
            <Box flexDirection="column">
              <Text bold>{title}</Text>
              {isShort(m) && <Text color="error">{runsOut(m)}</Text>}
              {/* no chart here to show the two paces side by side: say it */}
              {paceText(m) && <Text color={isShort(m) ? 'error' : undefined} dimColor={!isShort(m)}>{paceText(m)}</Text>}
              <Text>
                {`${m.kind === 'week' ? 'At week reset' : 'At 5h reset'} ${leftText(m)} · Your pace ${m.noData ? 'no data' : rateText(m, m.rate)} · Safe pace ${rateText(m, m.limit)}`}
              </Text>
              {/* the last window, quietly: dim, its figure in left-at-reset's colour */}
              {last && (
                <Box key={`last-${m.kind}`} flexDirection="row" columnGap={1}>
                  <Text dimColor>{LAST_LABEL}</Text>
                  <Text dimColor color={lastIsShort(last) ? 'error' : 'success'}>{lastWindowText(last)}</Text>
                </Box>
              )}
            </Box>
          )}
          {!Svg && <Text dimColor>{resetsIn(m)}</Text>}
        </Box>
        {/* the chart and its controls are one unit: the controls stay right under the chart */}
        <Box key={`graph-${m.kind}`} flexDirection="column" gap={1}>
          {chart && Svg && (
            draw(`chart-${m.kind}`, chart, `${emptyChartText(m, now) ? emptyChartText(m, now)!.join('. ') : `${averageNote(m)} Your pace ${rateText(m, m.rate)}, safe pace ${rateText(m, m.limit)}.`}`)
          )}
          {controls}
        </Box>
        <Box flexDirection="column" marginTop={controls ? 1 : 0}>
          {notes.map((note, i) => (Svg
            ? draw(`note-${m.kind}-${i}`, noteSvg(note, size.width, pal), note)
            : <Text color="inactive">{note}</Text>))}
        </Box>
        {/* what Last window means, behind a Details button: the drawings carry no tooltip */}
        {detailsBlock(m.kind, last ? [LAST_INFO, lastWindowNote(last)] : [])}
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
          // a column like the card's own, so a part left out (no baseline, no spend yet) is simply not there
          <Box flexDirection="column" gap={1}>
            {draw('models-head', modelsHead(learned, now, pal).svg, 'Models')}
            {draw('models-costs', modelsCosts(learned, base, size.width, pal), `Models. ${modelsText(learned, base, null).join(' ')}`)}
            {base && (
              <Box flexDirection="row" flexWrap="wrap" justifyContent="flex-end" alignItems="center" columnGap={1} rowGap={1}>
                <Text color="inactive">Compare with</Text>
                {shown.map(m => seg(`base-${m.id}`, names.get(m.id) ?? m.name, m === base, () => void choose($, { baseline: m.id })))}
              </Box>
            )}
            {sp && draw('models-spend', modelsSpend(sp, size.width, pal), modelsText({ ...learned, models: [] }, null, sp).join(' '))}
            {detailsBlock('models', MODELS_INFO.split('\n').filter(Boolean))}
          </Box>
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

    // sync across devices: one quiet row under the cards, the same on every surface
    const syncRow = (v: RangeSync) => {
      return (
        <Box key="sync" flexDirection="column" gap={1} marginTop={1}>
          {/* the row's parts as one flat list: a fragment here is drawn as a column of its own on the desktop */}
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
            {v.status === 'signedIn'
              ? [
                  <Text key="who" color="inactive">{`Synced as ${v.email || 'you'} · last sync ${agoText(v.last, clockNow)} ·`}</Text>,
                  <Button key="sync-signout" label="Sign out" dimColor={!!v.busy} onPress={() => void signOut(syncIO($))} />,
                  <Button key="sync-delete" label={v.confirmDelete ? 'Press again to delete all synced data' : 'Delete synced data'}
                    variant={v.confirmDelete ? 'primary' : 'secondary'} dimColor={!!v.busy} onPress={() => void deleteSynced(syncIO($))} />,
                ]
              : v.status === 'waiting'
                ? [
                    <Text key="waiting" color="inactive">{`Waiting for sign-in… code ${v.code ?? ''} ·`}</Text>,
                    <Button key="sync-cancel" label="Cancel" onPress={() => void cancelSignIn(syncIO($))} />,
                  ]
                : [
                    <Text key="title" color="inactive">{v.status === 'off' ? 'Sync across devices · off' : 'Sync across devices ·'}</Text>,
                    ...(v.status === 'off' ? [] : [<Button key="sync-signin" label="Sign in" dimColor={!!v.busy} onPress={() => void signIn(syncIO($))} />]),
                  ]}
          </Box>
          {/* the devices signed in to this account, this one first: any other one can be removed */}
          {v.status === 'signedIn' && v.devices && v.devices.length > 0 && (
            <Box key="devices" flexDirection="column">
              <Text key="devices-title" color="inactive">Linked devices</Text>
              {v.devices.map(d => (
                <Box key={`device-${d.id}`} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
                  {d.current
                    ? [<Text key="name">{`${deviceLabel(d)} · this device`}</Text>]
                    : [
                        <Text key="name">{`${deviceLabel(d)} · last seen ${d.lastSeenAt === undefined ? 'never' : agoText(d.lastSeenAt, clockNow)} ·`}</Text>,
                        <Button key={`sync-remove-${d.id}`}
                          label={v.confirmRemove === d.id ? `Press again to remove ${deviceLabel(d)} and its synced data` : 'Remove'}
                          variant={v.confirmRemove === d.id ? 'primary' : 'secondary'} dimColor={!!v.busy}
                          onPress={() => void removeDevice(syncIO($), d.id)} />,
                      ]}
                </Box>
              ))}
            </Box>
          )}
          {/* the page to sign in on, where the code is typed: as a link, and as text to copy */}
          {v.status === 'waiting' && v.url && (
            <Box flexDirection="column">
              {/* the link inside a Text, as the inline element it is; the address again as plain text to copy */}
              <Text>Open <Link href={v.url} label="the sign-in page" /> and enter the code {v.code ?? 'shown above'}.</Text>
              <Text dimColor>{v.url}</Text>
            </Box>
          )}
          {v.note && <Text dimColor>{v.note}</Text>}
        </Box>
      )
    }

    if (!week && !five) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>No usage limits reported yet.</Text>
          <Text dimColor>They arrive with Claude's next response, on a Pro or Max subscription.</Text>
          {syncRow(sync)}
        </Box>
      )
    }

    return (
      <Box key="cards" flexDirection="column">
        {week
          ? block('This week', week, Svg ? cardDrawing(week) : null, windowControls, [
            ...(Svg && emptyChartText(week, now) ? [] : [averageNote(week)]),
          ])
          : <Text dimColor>No weekly limit reported.</Text>}
        {five
          ? block('5-hour window', five, Svg ? cardDrawing(five) : null, null, Svg && emptyChartText(five, now) ? [] : [averageNote(five)])
          : <Text dimColor>No active 5-hour window.</Text>}
        {modelsCard}
        {syncRow(sync)}
      </Box>
    )
  })
}
