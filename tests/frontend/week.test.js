import { describe, expect, test } from 'bun:test'
import { addDaysToDateStr, laterWeekStart, mondayOf } from '../../public/js/lib/week.js'

describe('mondayOf', () => {
  test('a Thursday rolls back to that week\'s Monday', () => {
    expect(mondayOf('2026-07-30')).toBe('2026-07-27')
  })

  test('a Monday returns itself', () => {
    expect(mondayOf('2026-07-27')).toBe('2026-07-27')
  })

  test('a Sunday rolls back to the Monday six days earlier (not forward)', () => {
    expect(mondayOf('2026-08-02')).toBe('2026-07-27')
  })

})

describe('addDaysToDateStr', () => {
  test('adds positive days, rolling over month boundaries', () => {
    expect(addDaysToDateStr('2026-07-27', 7)).toBe('2026-08-03')
  })

  test('subtracts days for negative input', () => {
    expect(addDaysToDateStr('2026-07-27', -7)).toBe('2026-07-20')
  })

  test('is a no-op for zero days', () => {
    expect(addDaysToDateStr('2026-07-27', 0)).toBe('2026-07-27')
  })
})

describe('laterWeekStart', () => {
  test('candidate always wins when current is null (no known latest yet)', () => {
    expect(laterWeekStart(null, '2026-07-27')).toBe('2026-07-27')
  })

  test('keeps current when it is later than candidate', () => {
    expect(laterWeekStart('2026-08-03', '2026-07-27')).toBe('2026-08-03')
  })

  test('adopts candidate when it is later than current', () => {
    expect(laterWeekStart('2026-07-20', '2026-07-27')).toBe('2026-07-27')
  })

  test('is stable when both are equal', () => {
    expect(laterWeekStart('2026-07-27', '2026-07-27')).toBe('2026-07-27')
  })
})
