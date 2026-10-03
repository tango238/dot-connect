import { describe, expect, test } from 'bun:test'
import { modelBadge } from '../../public/js/lib/modelBadge.js'

describe('modelBadge', () => {
  test('returns null for the default/unspecified model', () => {
    expect(modelBadge(null)).toBeNull()
    expect(modelBadge(undefined)).toBeNull()
    expect(modelBadge('')).toBeNull()
  })

  test('returns a badge for an explicit model override', () => {
    expect(modelBadge('opus')).toEqual({ label: 'opus' })
  })
})
