import { describe, expect, test } from 'bun:test'
import { activeMilestonesWithProgress, completionPct } from '../../public/js/lib/milestoneProgress.js'

function milestone(overrides) {
  return { id: 1, title: 'M', status: 'active', linkedCount: 0, doneCount: 0, ...overrides }
}

describe('completionPct', () => {
  test('is 0 when nothing is linked (avoids dividing by zero)', () => {
    expect(completionPct(milestone({ linkedCount: 0, doneCount: 0 }))).toBe(0)
  })

  test('rounds to the nearest percent', () => {
    expect(completionPct(milestone({ linkedCount: 3, doneCount: 1 }))).toBe(33)
  })

  test('is 100 when every linked todo is done', () => {
    expect(completionPct(milestone({ linkedCount: 4, doneCount: 4 }))).toBe(100)
  })
})

describe('activeMilestonesWithProgress', () => {
  test('excludes done milestones', () => {
    const milestones = [milestone({ id: 1, status: 'active' }), milestone({ id: 2, status: 'done' })]
    const result = activeMilestonesWithProgress(milestones)
    expect(result.map((m) => m.id)).toEqual([1])
  })

  test('annotates each remaining milestone with pct', () => {
    const milestones = [milestone({ id: 1, linkedCount: 2, doneCount: 1 })]
    expect(activeMilestonesWithProgress(milestones)).toEqual([
      { id: 1, title: 'M', status: 'active', linkedCount: 2, doneCount: 1, pct: 50 },
    ])
  })

  test('returns an empty list when there are no active milestones', () => {
    expect(activeMilestonesWithProgress([milestone({ status: 'done' })])).toEqual([])
  })
})
