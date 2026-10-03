import { describe, expect, test } from 'bun:test'
import { hasOpenForm } from '../../public/js/lib/formGuard.js'

describe('hasOpenForm', () => {
  test('false when every marker is null (no forms open)', () => {
    expect(hasOpenForm(null, null, null, null)).toBe(false)
  })

  test('true when a single marker is non-null', () => {
    expect(hasOpenForm(5, null, null, null)).toBe(true)
    expect(hasOpenForm(null, 5, null, null)).toBe(true)
  })

  test('true when multiple markers are open at once', () => {
    expect(hasOpenForm(1, null, 2, null)).toBe(true)
  })

  test('is vacuously false with zero markers', () => {
    expect(hasOpenForm()).toBe(false)
  })

  test('treats id 0 as open — must compare against null, not use a truthiness check', () => {
    expect(hasOpenForm(0, null, null, null)).toBe(true)
  })

  test('treats undefined as closed, same as null — guards against a future marker that is not yet initialized permanently blocking the poll', () => {
    expect(hasOpenForm(undefined, null, null, null)).toBe(false)
    expect(hasOpenForm(undefined)).toBe(false)
  })
})
