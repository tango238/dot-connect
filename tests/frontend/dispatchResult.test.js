import { describe, expect, test } from 'bun:test'
import { shouldWarnAboutDelivery } from '../../public/js/lib/dispatchResult.js'

describe('shouldWarnAboutDelivery', () => {
  test('warns when promptDelivered is explicitly false', () => {
    expect(shouldWarnAboutDelivery({ promptDelivered: false })).toBe(true)
  })

  test('does not warn when promptDelivered is true', () => {
    expect(shouldWarnAboutDelivery({ promptDelivered: true })).toBe(false)
  })

  test('does not warn when promptDelivered is missing (older/unrelated response shape)', () => {
    expect(shouldWarnAboutDelivery({})).toBe(false)
  })

  test('does not warn for a null or undefined result', () => {
    expect(shouldWarnAboutDelivery(null)).toBe(false)
    expect(shouldWarnAboutDelivery(undefined)).toBe(false)
  })
})
