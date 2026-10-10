import { expect, test } from 'claude-code/testing'

import type { RangeReading, RangeStep, RangeWatch } from '../types'
import { DAY, HOUR, KEEP, MIN, windowHours } from '../hooks/range'
import {
  BACKOFF_MAX, agoText, backoffMs, batches, changedLists, dayOf, dayStart, fingerprint, isDeviceId, joinSpans, listKey, newDeviceId,
  packDays, packLists, parseListKey, serverFrom, splitSpan, unpack, unpacked, DEFAULT_SERVER,
} from '../hooks/sync'

const MIDNIGHT = Date.UTC(2026, 9, 10)   // 2026-10-10 00:00 UTC
const NOW = MIDNIGHT + 12 * HOUR
const reset = MIDNIGHT + 3 * DAY

test('days are UTC days, and keys name the device and the day', async () => {
  expect(dayOf(MIDNIGHT - 1)).toBe('20261009')
  expect(dayOf(MIDNIGHT)).toBe('20261010')
  expect(dayStart('20261010')).toBe(MIDNIGHT)
  expect(listKey('abc123', '20261010')).toBe('d:abc123-20261010')
  expect(listKey('abc123', '20261010', 2)).toBe('d:abc123-20261010.2')
  expect(parseListKey('d:abc123-20261010')).toEqual({ device: 'abc123', day: '20261010', part: 0 })
  expect(parseListKey('d:abc123-20261010.2')).toEqual({ device: 'abc123', day: '20261010', part: 2 })
  expect(parseListKey('r:abc123')).toBeNull()
  // every key the server would take
  expect(/^d:[A-Za-z0-9._-]{1,80}$/.test(listKey(newDeviceId(NOW), '20261010', 3))).toBe(true)
  const id = newDeviceId(NOW)
  expect(isDeviceId(id)).toBe(true)
  expect(id).toHaveLength(16)
})

test('a watched span crossing midnight is split there, each piece in its own day', async () => {
  expect(splitSpan([MIDNIGHT - 10 * MIN, MIDNIGHT + 10 * MIN])).toEqual([[MIDNIGHT - 10 * MIN, MIDNIGHT - 1], [MIDNIGHT, MIDNIGHT + 10 * MIN]])
  expect(splitSpan([MIDNIGHT + MIN, MIDNIGHT + 2 * MIN])).toEqual([[MIDNIGHT + MIN, MIDNIGHT + 2 * MIN]])
  expect(splitSpan([MIDNIGHT - MIN, MIDNIGHT + DAY + MIN])).toHaveLength(3)
  expect(splitSpan([5, 4])).toEqual([])
  // sessions watching at once are one stretch watched
  expect(joinSpans([[10, 20], [15, 30], [40, 50]])).toEqual([[10, 30], [40, 50]])
})

test('packing: every local list in one list per day, repeats dropped, midnight respected', async () => {
  const late: RangeReading = [MIDNIGHT - 5 * MIN, 1, 30, reset]
  const early: RangeReading = [MIDNIGHT + 5 * MIN, 1, 31, reset]
  const step1: RangeStep = [MIDNIGHT - MIN, 'claude-opus-5-5', 'high', 100, 0]
  const step2: RangeStep = [MIDNIGHT + MIN, 'claude-opus-5-5', 'high', 50, 1]
  const span: RangeWatch = [MIDNIGHT - 10 * MIN, MIDNIGHT + 10 * MIN]
  // two sessions on this computer, each holding part of the day, one repeating the other
  const days = packDays({ readings: [[late, early], [early]], spans: [span, [MIDNIGHT - 5 * MIN, MIDNIGHT - 2 * MIN]], steps: [[step1], [step2, step1]] }, NOW)
  expect([...days.keys()]).toEqual(['20261009', '20261010'])
  expect(days.get('20261009')).toEqual([[late], [[MIDNIGHT - 10 * MIN, MIDNIGHT - 1]], [step1]])
  expect(days.get('20261010')).toEqual([[early], [[MIDNIGHT, MIDNIGHT + 10 * MIN]], [step2]])

  // the oldest day only partly kept is left out, so no list shrinks as it ages
  const old: RangeReading = [NOW - KEEP + HOUR, 1, 1, reset]
  expect(packDays({ readings: [[old]], spans: [], steps: [] }, NOW).size).toBe(0)
  const kept: RangeReading = [dayStart(dayOf(NOW - KEEP)) + DAY + HOUR, 1, 1, reset]
  expect(packDays({ readings: [[kept]], spans: [], steps: [] }, NOW).size).toBe(1)

  // unpacked again, the days are the record's lists
  const back = unpacked(days.values())
  expect(back.readings.flat()).toEqual([late, early])
  expect(back.spans).toHaveLength(2)
  expect(back.steps.flat()).toEqual([step1, step2])
})

test('a day too big for one list goes on in parts', async () => {
  const steps: RangeStep[] = Array.from({ length: 400 }, (_, i) => [MIDNIGHT + i * 1000, 'claude-sonnet-5', 'medium', i, 0])
  const days = new Map([['20261010', [[[MIDNIGHT, 1, 3, reset]], [], steps] as [RangeReading[], RangeWatch[], RangeStep[]]]])
  const lists = packLists('dev1', days, 4000)
  expect(lists.length).toBeGreaterThan(1)
  expect(lists[0]!.key).toBe('d:dev1-20261010')
  expect(lists[1]!.key).toBe('d:dev1-20261010.1')
  expect(lists.every(l => JSON.stringify(l.data).length <= 4000)).toBe(true)
  expect(lists.flatMap(l => l.data[2])).toEqual(steps)
  expect(lists.flatMap(l => l.data[0])).toHaveLength(1)
  // one that fits is one list
  expect(packLists('dev1', days)).toHaveLength(1)
})

test('only lists whose content changed are sent, in requests the server takes', async () => {
  const a = { key: 'd:dev-20261009', data: [[], [], []] as [RangeReading[], RangeWatch[], RangeStep[]] }
  const b = { key: 'd:dev-20261010', data: [[[NOW, 1, 3, reset]], [], []] as [RangeReading[], RangeWatch[], RangeStep[]] }
  const sent = { [a.key]: fingerprint(a.data), [b.key]: fingerprint([[], [], []]) }
  expect(changedLists([a, b], sent).map(l => l.key)).toEqual([b.key])
  expect(changedLists([a, b], { ...sent, [b.key]: fingerprint(b.data) })).toEqual([])
  expect(fingerprint(b.data)).not.toBe(fingerprint(a.data))

  const many = Array.from({ length: 120 }, (_, i) => ({ key: `d:dev-${i}`, data: [] }))
  expect(batches(many).map(x => x.length)).toEqual([50, 50, 20])
  const big = Array.from({ length: 5 }, (_, i) => ({ key: `d:dev-${i}`, data: ['x'.repeat(100_000)] }))
  expect(batches(big).map(x => x.length)).toEqual([2, 2, 1])
})

test('failures back off, doubling up to an hour, never sooner than the server asks', async () => {
  expect(backoffMs(1)).toBe(2 * MIN)
  expect(backoffMs(2)).toBe(4 * MIN)
  expect(backoffMs(3)).toBe(8 * MIN)
  expect(backoffMs(20)).toBe(BACKOFF_MAX)
  expect(backoffMs(1, 5 * MIN)).toBe(5 * MIN)
})

test("another device's list is checked item by item", async () => {
  expect(unpack({})).toBeNull()
  expect(unpack([[], []])).toBeNull()
  expect(unpack([[[1, 1, 2, 3], ['x'], [1, 2, 3]], [[1, 2], [1]], [[1, 'm', 'e', 3, 0], [1, 'm', 'e', 3, 2]]])).toEqual(
    [[[1, 1, 2, 3]], [[1, 2]], [[1, 'm', 'e', 3, 0]]])
})

test('the server option, the last sync, and what KEEP leaves of the window choices', async () => {
  expect(serverFrom(undefined)).toBe(DEFAULT_SERVER)
  expect(serverFrom('https://sync.example.com/')).toBe('https://sync.example.com')
  expect(serverFrom('not a url')).toBe(DEFAULT_SERVER)
  expect(agoText(undefined, NOW)).toBe('not synced yet')
  expect(agoText(NOW - 20_000, NOW)).toBe('just now')
  expect(agoText(NOW - 3 * MIN, NOW)).toBe('3 min ago')
  expect(agoText(NOW - 2 * HOUR, NOW)).toBe('2 h ago')
  // fifteen days kept: the longest window on offer (7 days) and the 14 days the models learn from still fit
  expect(KEEP).toBe(15 * DAY)
  expect(windowHours({ n: 7, unit: 'd' })).toBe(168)
  expect(windowHours({ n: 3, unit: 'w' })).toBe(KEEP / HOUR - 24)
})
