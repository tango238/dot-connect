import { describe, expect, test } from 'bun:test'
import { computeRange, hasValidRange, posPct } from '../../public/js/lib/planRange.js'

function milestone(startDate, targetDate) {
  return { startDate, targetDate }
}

describe('hasValidRange', () => {
  test('accepts a well-formed date pair', () => {
    expect(hasValidRange(milestone('2026-07-21', '2026-08-08'))).toBe(true)
  })

  test('rejects a non-date string in the right shape (month 99)', () => {
    expect(hasValidRange(milestone('2026-99-99', '2026-08-08'))).toBe(false)
  })

  test('rejects a completely malformed string', () => {
    expect(hasValidRange(milestone('not-a-date', '2026-08-08'))).toBe(false)
  })

  test('rejects when either side is missing/malformed', () => {
    expect(hasValidRange(milestone('2026-07-21', 'nope'))).toBe(false)
    expect(hasValidRange(milestone('', '2026-08-08'))).toBe(false)
  })
})

describe('computeRange', () => {
  test('spans one week before the earliest start and after the latest target', () => {
    const milestones = [milestone('2026-07-21', '2026-08-08'), milestone('2026-08-03', '2026-08-15')]
    const { start, end } = computeRange(milestones, '2026-07-30')
    expect(start.toISOString().slice(0, 10)).toBe('2026-07-14')
    expect(end.toISOString().slice(0, 10)).toBe('2026-08-22')
  })

  test('also widens the range to include "today" when milestones sit entirely in the past or future', () => {
    const milestones = [milestone('2026-01-01', '2026-01-10')]
    const { end } = computeRange(milestones, '2026-07-30')
    // today (07-30) + 1 week margin, not the milestone's own +1 week
    expect(end.toISOString().slice(0, 10)).toBe('2026-08-06')
  })

  test('falls back to a today-centered range with no milestones', () => {
    const { start, end } = computeRange([], '2026-07-30')
    expect(start.toISOString().slice(0, 10)).toBe('2026-07-23')
    expect(end.toISOString().slice(0, 10)).toBe('2026-08-20')
  })
})

describe('posPct', () => {
  test('clamps to 0 and 100 at the range edges', () => {
    const start = new Date('2026-07-14T00:00:00Z')
    const end = new Date('2026-08-22T00:00:00Z')
    expect(posPct('2026-07-14', start, end)).toBe(0)
    expect(posPct('2026-08-22', start, end)).toBe(100)
  })

  test('places the midpoint at 50%', () => {
    const start = new Date('2026-07-01T00:00:00Z')
    const end = new Date('2026-07-31T00:00:00Z')
    expect(posPct('2026-07-16', start, end)).toBeCloseTo(50, 0)
  })

  test('clamps dates outside the range instead of going negative or over 100', () => {
    const start = new Date('2026-07-14T00:00:00Z')
    const end = new Date('2026-08-22T00:00:00Z')
    expect(posPct('2026-01-01', start, end)).toBe(0)
    expect(posPct('2026-12-31', start, end)).toBe(100)
  })
})
