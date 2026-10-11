import { expect, test } from 'claude-code/testing'

import type { RangeStep } from '../types'
import { HOUR, MIN } from '../hooks/range'
import type { Increment } from '../hooks/range'
import { CHATS, OTHER_DEVICE, OTHER_INFO, projectName, projectSplit } from '../hooks/projects'
import type { ProjectSplit } from '../hooks/projects'

const T0 = Date.UTC(2026, 9, 10, 12, 0)
const FROM = T0 - 24 * HOUR

/** Opus weighs twice what Sonnet does. */
const weightOf = (model: string) => (model.includes('opus') ? 2 : 1)

/** A rise seen while watching: `amount` at `end`, the reading before it at `from`. */
const rise = (from: number, end: number, amount: number): Increment => ({ start: end - 5 * MIN, end, amount, from })
const step = (t: number, model: string, units: number, project?: string): RangeStep =>
  project === undefined ? [t, model, '', units, 0] : [t, model, '', units, 0, project]

/** A figure to float precision (the testing library has no toBeCloseTo). */
const near = (x: number) => Math.round(x * 1e9) / 1e9
const sum = (s: ProjectSplit) => s.rows.reduce((a, r) => a + r.pct, 0) + s.otherTotal + s.unused

test('a project is its folder, a worktree counts as its repo, scratch workspaces are chats', async () => {
  expect(projectName('C:\\Projekt\\token-range-monitor')).toBe('token-range-monitor')
  expect(projectName('C:\\Projekt\\token-range-monitor\\')).toBe('token-range-monitor')
  expect(projectName('/home/u/foo')).toBe('foo')
  expect(projectName('/home/u/foo/')).toBe('foo')
  expect(projectName('C:\\Projekt\\foo\\.claude\\worktrees\\bar')).toBe('foo')
  expect(projectName('/home/u/foo/.claude/worktrees/bar/')).toBe('foo')
  expect(projectName('C:\\Users\\Gamer\\AppData\\Roaming\\Claude\\scratch-workspaces\\abc123')).toBe(CHATS)
  expect(projectName('/Users/u/Library/Application Support/claude/Scratch-Workspaces/abc123/')).toBe(CHATS)
  // a folder that only looks like one is still a project
  expect(projectName('/home/u/scratch-workspaces')).toBe('scratch-workspaces')
})

test('watched rises are shared among the projects by weighted work', async () => {
  const incs = [rise(T0 - 3 * HOUR, T0 - 2 * HOUR, 6), rise(T0 - 2 * HOUR, T0 - HOUR, 4)]
  const steps = [
    // first rise: alpha 100 opus units (200) and beta 100 sonnet units (100) → 4 and 2
    step(T0 - 2.5 * HOUR, 'claude-opus-5-5', 100, 'alpha'),
    step(T0 - 2.2 * HOUR, 'claude-sonnet-5', 100, 'beta'),
    // second rise: beta alone → 4
    step(T0 - 1.5 * HOUR, 'claude-sonnet-5', 50, 'beta'),
    // before the first rise's previous reading: not behind it
    step(T0 - 4 * HOUR, 'claude-opus-5-5', 1000, 'alpha'),
  ]
  const s = projectSplit(incs, steps, weightOf, FROM, T0, 10)
  expect(s.rows.map(r => r.name)).toEqual(['beta', 'alpha'])
  expect(near(s.rows[0]!.pct)).toBe(6)
  expect(near(s.rows[1]!.pct)).toBe(4)
  expect(near(s.otherTotal)).toBe(0)
  expect(near(s.unused)).toBe(90)
  expect(near(sum(s))).toBe(100)
})

test('chats, other devices, before 1.4 and away each have their part of Other', async () => {
  const hole: Increment = { start: T0 - 10 * HOUR, end: T0 - 8 * HOUR, amount: 3, hole: [T0 - 12 * HOUR, T0 - 10 * HOUR] }
  const incs = [
    hole,
    rise(T0 - 7 * HOUR, T0 - 6 * HOUR, 4),
    // nothing recorded behind this one
    rise(T0 - 5 * HOUR, T0 - 4 * HOUR, 2),
    rise(T0 - 3 * HOUR, T0 - 2 * HOUR, 8),
  ]
  const steps = [
    step(T0 - 6.5 * HOUR, 'claude-sonnet-5', 10, CHATS),
    step(T0 - 6.4 * HOUR, 'claude-sonnet-5', 10, OTHER_DEVICE),
    step(T0 - 6.3 * HOUR, 'claude-sonnet-5', 20),
    step(T0 - 2.5 * HOUR, 'claude-opus-5-5', 10, 'alpha'),
  ]
  // 17 seen on record, 25 used: 8 came before recording began
  const s = projectSplit(incs, steps, weightOf, FROM, T0, 25)
  expect(s.rows).toEqual([{ name: 'alpha', pct: 8 }])
  expect(near(s.other.chats)).toBe(1)
  expect(near(s.other.devices)).toBe(1)
  expect(near(s.other.before)).toBe(2)
  expect(near(s.other.away)).toBe(3 + 2 + 8)
  expect(near(s.otherTotal)).toBe(17)
  expect(near(s.unused)).toBe(75)
  expect(near(sum(s))).toBe(100)
})

test('only the window counts, and a record bigger than the figure is scaled down to it', async () => {
  const incs = [
    // wholly before the window
    rise(FROM - 3 * HOUR, FROM - 2 * HOUR, 50),
    // straddles its start: half of it is inside
    { start: FROM - HOUR, end: FROM + HOUR, amount: 4, from: FROM - 2 * HOUR },
    rise(T0 - 2 * HOUR, T0 - HOUR, 6),
  ]
  const steps = [step(FROM, 'claude-sonnet-5', 10, 'alpha'), step(T0 - 1.5 * HOUR, 'claude-sonnet-5', 10, 'beta')]
  const s = projectSplit(incs, steps, weightOf, FROM, T0, 8)
  expect(s.rows[0]).toEqual({ name: 'beta', pct: 6 })
  expect(s.rows[1]).toEqual({ name: 'alpha', pct: 2 })
  expect(near(sum(s))).toBe(100)

  // 8 on record, 4 used: everything halves, nothing is away
  const half = projectSplit(incs, steps, weightOf, FROM, T0, 4)
  expect(half.rows.map(r => r.pct)).toEqual([3, 1])
  expect(half.other.away).toBe(0)
  expect(near(sum(half))).toBe(100)

  // nothing on record at all
  const none = projectSplit([], [], weightOf, FROM, T0, 39)
  expect(none.rows).toEqual([])
  expect(none.other.away).toBe(39)
  expect(none.unused).toBe(61)
})

test('every part of Other is explained', async () => {
  expect(Object.keys(OTHER_INFO).sort()).toEqual(['away', 'before', 'chats', 'devices'])
  expect(OTHER_INFO.devices.text).toContain('project names stay there')
})
