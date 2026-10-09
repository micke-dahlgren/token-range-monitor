import { expect, test } from 'claude-code/testing'

import type { RangeReading, RangeStep } from '../types'
import { DAY, HOUR, MIN, project } from '../hooks/range'
import { baselineOf, learn, modelName, spend, units } from '../hooks/models'

const T0 = Date.UTC(2026, 9, 9, 15, 0)
const reset = T0 + 2 * DAY

/**
 * A week of work as the plugin would see it: a response every few minutes, the model
 * switching between sessions, weekly readings taken whenever the limit ticks up a point.
 * Opus costs 5 points per million weighted tokens, Sonnet 1; Haiku only now and then.
 */
function history(weights: Record<string, number>, mix: (i: number) => string, every = 3 * MIN) {
  const steps: RangeStep[] = [], readings: RangeReading[] = []
  let used = 0, shown = 0, t = T0 - 5 * DAY
  // a pseudo-random but fixed sequence of response sizes
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  readings.push([t, 1, 0, reset])
  for (let i = 0; t < T0 - 2 * MIN; i++) {
    t += every
    const model = mix(i)
    const u = 20_000 + rand() * 180_000
    const effort = rand() < 0.3 ? 'max' : 'high'
    steps.push([t, model, effort, u, rand() < 0.2 ? 1 : 0])
    used += u / 1e6 * weights[model]!
    if (Math.floor(used) > shown) { shown = Math.floor(used); readings.push([t, 1, shown, reset]) }
  }
  return { steps, readings, seen: [[T0 - 5 * DAY, T0]] as Array<[number, number]> }
}

test('model ids read as names', async () => {
  expect(modelName('claude-opus-5-5').name).toBe('Opus 5.5')
  expect(modelName('claude-fable-5-1').name).toBe('Fable 5.1')
  expect(modelName('claude-3-5-sonnet-20241022').name).toBe('Sonnet 3.5')
  expect(modelName('claude-haiku-5-5[1m]').family).toBe('haiku')
  expect(modelName('some-other-model').family).toBe('other')
})

test('tokens are weighted at the price ratios', async () => {
  expect(units({ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 40, cache_read_input_tokens: 1000 })).toBe(100 + 50 + 50 + 100)
})

test('each model’s cost is learned from the ticks, and shows once it is sure enough', async () => {
  const W = { 'claude-opus-5-5': 5, 'claude-sonnet-5-5': 1, 'claude-haiku-5-5': 0.3 }
  // long runs of one model, now and then a Haiku response
  const { steps, readings, seen } = history(W, i => (i % 97 === 0 ? 'claude-haiku-5-5' : Math.floor(i / 40) % 2 ? 'claude-opus-5-5' : 'claude-sonnet-5-5'))
  const l = learn(readings, steps, seen, T0)
  const [opus, sonnet, haiku] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(id => l.models.find(m => m.id === id)!)
  expect(l.models.map(m => m.name)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
  expect(opus!.shown).toBe(true)
  expect(sonnet!.shown).toBe(true)
  // the rare model is still learning, and says how far it has to go
  expect(haiku!.shown).toBe(false)
  expect(haiku!.more).toBeGreaterThan(0)
  const r = opus!.w / sonnet!.w
  expect(r).toBeGreaterThan(4.3)
  expect(r).toBeLessThan(5.7)

  // the baseline is Sonnet by default, any shown model when picked
  expect(baselineOf(l, undefined)).toBe(sonnet)
  expect(baselineOf(l, 'claude-opus-5-5')).toBe(opus)

  // this week's points split by model and effort, adding up to what was recorded
  const week = project(readings, 'week', T0, { type: 'reset' }, seen)!
  const sp = spend(week, l, steps, T0)
  expect(sp.models.map(m => m.cost.name)).toEqual(['Opus 5.5', 'Sonnet 5.5'])
  expect(sp.models[0]!.effort.map(e => e[0])).toEqual(['high', 'max'])
  const split = sp.models.reduce((s, m) => s + m.pts, 0)
  expect(Math.abs(split + sp.unsplit + sp.away - week.pct)).toBeLessThan(week.pct * 0.15)
})

test('one model alone is known but has nothing to compare with', async () => {
  const { steps, readings, seen } = history({ 'claude-opus-5-5': 5 }, () => 'claude-opus-5-5')
  const l = learn(readings, steps, seen, T0)
  expect(l.models[0]!.shown).toBe(true)
  expect(baselineOf(l, undefined)).toBe(null)
})

test('stretches nobody here watched teach nothing', async () => {
  // a response every 20 minutes: each stretch between ticks is longer than a pause, so with nothing watched none counts
  const { steps, readings } = history({ 'claude-opus-5-5': 5, 'claude-sonnet-5-5': 1 }, i => (Math.floor(i / 10) % 2 ? 'claude-opus-5-5' : 'claude-sonnet-5-5'), 20 * MIN)
  const l = learn(readings, steps, [], T0)
  expect(l.since).toBe(null)
  expect(l.models.every(m => !m.shown && m.rel === Infinity)).toBe(true)
  // with nothing known, the week's recorded points all wait to be split
  const week = project(readings, 'week', T0, { type: 'reset' }, [])!
  expect(spend(week, l, steps, T0).models).toEqual([])
  void HOUR
})
