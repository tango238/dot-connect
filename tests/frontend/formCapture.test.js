import { describe, expect, test } from 'bun:test'
import { shouldRestoreCapturedForm } from '../../public/js/lib/formCapture.js'

describe('shouldRestoreCapturedForm', () => {
  test('false when nothing was captured', () => {
    expect(shouldRestoreCapturedForm(null, 5)).toBe(false)
    expect(shouldRestoreCapturedForm(null, null)).toBe(false)
  })

  test('true when the same form is still open', () => {
    expect(shouldRestoreCapturedForm({ id: 5 }, 5)).toBe(true)
  })

  test('false when the form was closed while the refresh was in flight', () => {
    expect(shouldRestoreCapturedForm({ id: 5 }, null)).toBe(false)
  })

  test('false when a different form is open now (user switched)', () => {
    expect(shouldRestoreCapturedForm({ id: 5 }, 7)).toBe(false)
  })
})
