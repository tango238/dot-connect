import { describe, expect, test } from 'bun:test'
import { computeRange } from '../../public/js/lib/planRange.js'
import { dueTodos, groupDueTodosByMilestone } from '../../public/js/lib/planTodos.js'

function todo(id, dueDate, milestoneId = null, status = 'open') {
  return { id, dueDate, milestoneId, status, title: `T${id}` }
}

describe('dueTodos', () => {
  test('keeps only TODOs with a parseable YYYY-MM-DD due date', () => {
    const kept = dueTodos([todo(1, '2026-10-20'), todo(2, null), todo(3, 'soon'), todo(4, '2026-99-99')])
    expect(kept.map((t) => t.id)).toEqual([1])
  })
})

describe('groupDueTodosByMilestone', () => {
  const milestones = [{ id: 7 }, { id: 8 }]

  test('groups by milestone id and puts unlinked TODOs under the null key', () => {
    const groups = groupDueTodosByMilestone(
      [todo(1, '2026-10-20', 7), todo(2, '2026-10-21'), todo(3, '2026-10-22', 8)],
      milestones
    )
    expect(groups.get(7).map((t) => t.id)).toEqual([1])
    expect(groups.get(8).map((t) => t.id)).toEqual([3])
    expect(groups.get(null).map((t) => t.id)).toEqual([2])
  })

  test('a TODO pointing at a milestone not on the timeline falls into the null group', () => {
    const groups = groupDueTodosByMilestone([todo(1, '2026-10-20', 99)], milestones)
    expect(groups.has(99)).toBe(false)
    expect(groups.get(null).map((t) => t.id)).toEqual([1])
  })

  test('skips TODOs without a due date entirely', () => {
    const groups = groupDueTodosByMilestone([todo(1, null, 7), todo(2, null)], milestones)
    expect(groups.size).toBe(0)
  })

  test('sorts open TODOs before done ones, then by due date, then by id', () => {
    const groups = groupDueTodosByMilestone(
      [todo(1, '2026-10-25', 7, 'done'), todo(2, '2026-10-22', 7), todo(3, '2026-10-20', 7), todo(4, '2026-10-22', 7)],
      milestones
    )
    expect(groups.get(7).map((t) => t.id)).toEqual([3, 2, 4, 1])
  })
})

describe('computeRange with TODO due dates', () => {
  test('widens the range to cover a due date beyond every milestone', () => {
    const { start, end } = computeRange([{ startDate: '2026-10-01', targetDate: '2026-10-10' }], '2026-10-05', ['2026-11-01'])
    expect(start.toISOString().slice(0, 10)).toBe('2026-09-24')
    expect(end.toISOString().slice(0, 10)).toBe('2026-11-08')
  })

  test('ranges around due dates alone when there are no milestones', () => {
    const { start, end } = computeRange([], '2026-10-05', ['2026-09-20', '2026-10-20'])
    expect(start.toISOString().slice(0, 10)).toBe('2026-09-13')
    expect(end.toISOString().slice(0, 10)).toBe('2026-10-27')
  })
})
