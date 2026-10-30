import { describe, expect, test } from 'bun:test'
import { canGoNext } from '../../public/js/lib/reportNav.js'

describe('canGoNext', () => {
  test('disabled when there is no current week to advance from', () => {
    expect(canGoNext(null, '2026-07-27')).toBe(false)
    expect(canGoNext('', '2026-07-27')).toBe(false)
  })

  test('disabled while the current week is not known yet (latest is null)', () => {
    expect(canGoNext('2026-07-27', null)).toBe(false)
  })

  test('disabled when already viewing the current week', () => {
    expect(canGoNext('2026-07-27', '2026-07-27')).toBe(false)
  })

  test('disabled if somehow past the current week', () => {
    expect(canGoNext('2026-08-03', '2026-07-27')).toBe(false)
  })

  test('enabled when viewing a past week', () => {
    expect(canGoNext('2026-07-20', '2026-07-27')).toBe(true)
  })
})
