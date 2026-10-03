import { describe, expect, test } from 'bun:test'
import { canGoNext } from '../../public/js/lib/reportNav.js'

describe('canGoNext', () => {
  test('disabled when there is no current week to advance from', () => {
    expect(canGoNext(null, '2026-07-27')).toBe(false)
    expect(canGoNext('', '2026-07-27')).toBe(false)
  })

  test('disabled when no report has ever been generated (latest is null)', () => {
    expect(canGoNext('2026-07-27', null)).toBe(false)
  })

  test('disabled when already viewing the latest known week', () => {
    expect(canGoNext('2026-07-27', '2026-07-27')).toBe(false)
  })

  test('disabled if somehow past the latest known week', () => {
    expect(canGoNext('2026-08-03', '2026-07-27')).toBe(false)
  })

  test('enabled when a newer week is known to exist', () => {
    expect(canGoNext('2026-07-20', '2026-07-27')).toBe(true)
  })
})
