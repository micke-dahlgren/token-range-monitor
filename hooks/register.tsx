import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { RangeReading, RangeSettings, RangeWatch } from '../types'
import {
  C, DEFAULT_SETTINGS, FIVE_WINDOW_MIN, KEEP, MIN, heartbeat, MIN_RECORDED_H, UNIT_MAX, averageName, averageNote, chosenAverage,
  fiveChart, headerSvg, merge, needsMore, parseWindow, project, rateText, recordedHours, resetsIn,
  isShort, leftText, runsOut, weekChart, windowHours,
} from './range'
import type { Average, Model } from './range'

const PANE = 'token-range-monitor'
const TITLE = 'Token Range Monitor'
const readings = atom({ plugin: 'token-range-monitor', key: 'readings' } as const, [])
const settings = atom({ plugin: 'token-range-monitor', key: 'settings' } as const, DEFAULT_SETTINGS)
const tick = atom({ plugin: 'token-range-monitor', key: 'tick' } as const, 0)
const seen = atom({ plugin: 'token-range-monitor', key: 'seen' } as const, [])

/**
 * Each session writes its readings under its own store key (`r:`), and the
 * spans it was watching under the twin key (`w:`), so sessions never overwrite each other.
 */
const OWN_PREFIX = 'r:'
const SEEN_PREFIX = 'w:'
const seenKeyOf = (key: string) => SEEN_PREFIX + key.slice(OWN_PREFIX.length)
const newOwnKey = (now: number) => `${OWN_PREFIX}${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

let ownKey = ''
let own: RangeReading[] = []
let ownSeen: RangeWatch[] = []
let othersSeen: RangeWatch[] = []

async function loadAll($: EngineInterface) {
  const now = await $.clock.now()
  const lists: RangeReading[][] = [own]
  const spans: RangeWatch[] = []
  for (const key of await $.store.keys()) {
    if (key.startsWith(SEEN_PREFIX) && key !== seenKeyOf(ownKey)) {
      const list = ((await $.store.get(key)) ?? []) as RangeWatch[]
      if (list.every(w => w[1] < now - KEEP)) await $.store.delete(key)
      else spans.push(...list)
      continue
    }
    if (!key.startsWith(OWN_PREFIX) || key === ownKey) continue
    const list = ((await $.store.get(key)) ?? []) as RangeReading[]
    // drop other sessions' lists once everything in them has aged out
    if (list.every(r => r[0] < now - KEEP)) await $.store.delete(key)
    else lists.push(list)
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

async function models($: EngineInterface) {
  const list = await read($, readings)
  const watched = await read($, seen)
  const s = await read($, settings)
  await read($, tick)
  const now = await $.clock.now()
  const weekRecorded = recordedHours(list, 'week', now)
  const fiveRecorded = recordedHours(list, 'five', now)
  const weekAvg = chosenAverage(s)
  const fiveAvg: Average = { type: 'hours', hours: FIVE_WINDOW_MIN / 60 }
  return {
    now, s, weekRecorded,
    week: project(list, 'week', now, weekAvg, watched),
    five: project(list, 'five', now, fiveAvg, watched),
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

/** Sets the weekly window; one the record doesn't cover yet is kept for later, with a word on how long to go. */
async function setWindow($: EngineInterface, n: number, unit: 'h' | 'd') {
  await choose($, { mode: 'window', n, unit })
  const hours = windowHours({ n, unit })
  const recordedH = recordedHours(await read($, readings), 'week', await $.clock.now())
  if (hours > recordedH) $.ui.toast(needsMore({ type: 'hours', hours }, recordedH), { timeoutMs: 6000 })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    ownKey = newOwnKey(now)
    own = []
    ownSeen = []
    const saved = (await $.store.get('settings')) as RangeSettings | undefined
    // a saved "everything recorded" (now retired) becomes the custom window it sat beside
    if (saved) await update($, settings, () => ({ ...DEFAULT_SETTINGS, ...saved, mode: saved.mode === 'reset' ? 'reset' : 'window' }))
    await $.command.register({
      name: 'token-range',
      description: 'Token Range Monitor: open the pane, or set what the weekly average covers (/token-range 2d, /token-range 6h, /token-range reset)',
      argumentHint: '[window | reset]',
    })
    await loadAll($)
    await capture($, (await $.session.usage()).rateLimits)
    // once a minute: pick up other sessions' readings and move "now" along
    $.clock.every(60_000, async () => {
      await loadAll($)
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
    const avg: Average = { type: 'hours', hours: windowHours(w) }
    await setWindow($, w.unit === 'h' ? w.n : w.n * (w.unit === 'w' ? 7 : 1), w.unit === 'h' ? 'h' : 'd')
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
    const { now, s, week, five, weekRecorded } = await models($)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = 'Svg' in els ? els.Svg : null
    const width = 760

    // one dark card per limit, as on the car's display: head, chart, controls, then the notes
    const block = (title: string, m: Model, chart: string | null, controls: JSX.Element | null, notes: string[]) => (
      <Box
        key={`block-${m.kind}`}
        flexDirection="column"
        gap={1}
        marginBottom={1}
        padding={2}
        borderStyle="round"
        borderColor={C.card}
        backgroundColor={C.card}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
          {Svg ? (
            <Svg
              source={headerSvg(m, title, width - 200)}
              alt={`${title}. ${isShort(m) ? `${runsOut(m)}. ` : ''}Left at reset ${leftText(m)}, average ${m.noData ? 'no data' : rateText(m, m.rate)}, limit ${rateText(m, m.limit)}.`}
            />
          ) : (
            <Box flexDirection="column">
              <Text bold>{title}</Text>
              {isShort(m) && <Text color="error">{runsOut(m)}</Text>}
              <Text>
                {`${m.kind === 'week' ? 'Left at week reset' : 'Left at 5h reset'} ${leftText(m)} · Average ${m.noData ? 'no data' : rateText(m, m.rate)} · Limit ${rateText(m, m.limit)}`}
              </Text>
            </Box>
          )}
          <Button key={`reset-${m.kind}`} plain label={resetsIn(m, s.fine)} onPress={() => toggleFine($)} />
        </Box>
        {chart && Svg && (
          <Svg
            source={chart}
            alt={`${averageNote(m)} Average ${rateText(m, m.rate)}, limit ${rateText(m, m.limit)}.`}
          />
        )}
        {controls}
        <Box flexDirection="column" marginTop={controls ? 2 : 0}>
          {notes.map(note => <Text color={C.dim}>{note}</Text>)}
        </Box>
      </Box>
    )

    // the window selector: native widgets, so hover, focus and clicks are the surface's own
    const unit = s.unit === 'h' ? 'h' : 'd'
    const n = Math.min(Math.max(1, s.n), UNIT_MAX[unit])
    const isCustom = s.mode === 'window'
    const seg = (key: string, label: string, isOn: boolean, onPress: () => void) => (
      <Button key={key} label={label} variant={isOn ? 'primary' : 'secondary'} dimColor={!isOn} onPress={onPress} />
    )
    const windowControls = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
          <Text color={C.dim}>Average over</Text>
          {seg('mode-reset', 'Since reset', s.mode === 'reset', () => void choose($, { mode: 'reset' }))}
          {seg('mode-custom', 'Custom', isCustom, () => void setWindow($, n, unit))}
        </Box>
        {isCustom && (
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
            <Text color={C.dim}>Last</Text>
            <Button key="win-dec" label="−" dimColor={n <= 1} onPress={() => void setWindow($, Math.max(1, n - 1), unit)} />
            <Text bold color={C.fg}>{` ${n} `}</Text>
            <Button key="win-inc" label="+" dimColor={n >= UNIT_MAX[unit]} onPress={() => void setWindow($, Math.min(UNIT_MAX[unit], n + 1), unit)} />
            {seg('unit-h', 'hours', unit === 'h', () => void setWindow($, Math.min(n, UNIT_MAX.h), 'h'))}
            {seg('unit-d', 'days', unit === 'd', () => void setWindow($, Math.min(n, UNIT_MAX.d), 'd'))}
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
      <Box flexDirection="column">
        {week
          ? block('This week', week, Svg ? weekChart(week, now, width) : null, windowControls, [
            averageNote(week),
          ])
          : <Text dimColor>No weekly limit reported.</Text>}
        {five
          ? block('5-hour window', five, Svg ? fiveChart(five, now, width) : null, null, [averageNote(five)])
          : <Text dimColor>No active 5-hour window.</Text>}
      </Box>
    )
  })
}
