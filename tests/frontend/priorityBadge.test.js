import { describe, expect, test } from 'bun:test'
import { priorityBadge } from '../../public/js/lib/priorityBadge.js'

describe('priorityBadge', () => {
  test('returns null for "none" (nothing shown for the common case)', () => {
    expect(priorityBadge('none')).toBeNull()
  })

  test('returns null for missing priority (todos predating this feature)', () => {
    expect(priorityBadge(undefined)).toBeNull()
    expect(priorityBadge(null)).toBeNull()
  })

  test('returns null for an unrecognized value rather than throwing', () => {
    expect(priorityBadge('urgent')).toBeNull()
  })

  test('returns the high badge', () => {
    expect(priorityBadge('high')).toEqual({ label: '高', className: 'prio-high' })
  })

  test('returns the low badge', () => {
    expect(priorityBadge('low')).toEqual({ label: '低', className: 'prio-low' })
  })
})
