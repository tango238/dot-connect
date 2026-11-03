import { describe, expect, test } from 'bun:test'
import {
  comparePriority,
  formatPriority,
  isPrioritized,
  levelOptions,
  priorityBadge,
  priorityLevel,
  priorityScore,
} from '../../public/js/lib/priority.js'

describe('priorityLevel', () => {
  test('keeps 1〜5 and falls back to 1 for anything else', () => {
    expect(priorityLevel(3)).toBe(3)
    expect(priorityLevel('5')).toBe(5)
    expect(priorityLevel(0)).toBe(1)
    expect(priorityLevel(6)).toBe(1)
    expect(priorityLevel(2.5)).toBe(1)
    expect(priorityLevel(undefined)).toBe(1)
    expect(priorityLevel('high')).toBe(1)
  })
})

describe('priorityScore / comparePriority / isPrioritized', () => {
  test('score is the sum, ties go to urgency, and both-1 is "unset"', () => {
    expect(priorityScore({ urgency: 5, importance: 3 })).toBe(8)
    expect(priorityScore({})).toBe(2)
    const list = [
      { id: 'a', urgency: 2, importance: 4 },
      { id: 'b', urgency: 4, importance: 2 },
      { id: 'c', urgency: 5, importance: 5 },
      { id: 'd' },
    ]
    expect([...list].sort(comparePriority).map((x) => x.id)).toEqual(['c', 'b', 'a', 'd'])
    expect(isPrioritized({ urgency: 1, importance: 1 })).toBe(false)
    expect(isPrioritized({ urgency: 1, importance: 2 })).toBe(true)
    expect(isPrioritized({})).toBe(false)
  })
})

describe('priorityBadge / formatPriority', () => {
  test('returns null when both levels are 1 or missing', () => {
    expect(priorityBadge({ urgency: 1, importance: 1 })).toBeNull()
    expect(priorityBadge({})).toBeNull()
    expect(priorityBadge(null)).toBeNull()
  })

  test('labels both levels and colors by the higher one', () => {
    expect(priorityBadge({ urgency: 5, importance: 3 })).toEqual({ label: '緊5 重3', title: '緊急度 5 / 重要度 3', className: 'prio-5' })
    expect(priorityBadge({ urgency: 1, importance: 4 })).toEqual({ label: '緊1 重4', title: '緊急度 1 / 重要度 4', className: 'prio-4' })
    expect(formatPriority({ urgency: 2 })).toBe('緊急度 2 / 重要度 1')
  })
})

describe('levelOptions', () => {
  test('renders 1〜5 with the selected one marked and 低/高 hints at the ends', () => {
    const html = levelOptions(3)
    expect(html.match(/<option/g)).toHaveLength(5)
    expect(html).toContain('<option value="3" selected>3</option>')
    expect(html).toContain('>1(低)<')
    expect(html).toContain('>5(高)<')
    expect(levelOptions(undefined)).toContain('<option value="1" selected>')
  })
})
