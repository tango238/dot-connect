import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { parseOrThrow, ValidationError } from '../../src/api/validation'

describe('parseOrThrow', () => {
  test('returns the parsed value on success', () => {
    const schema = z.object({ title: z.string() })
    expect(parseOrThrow(schema, { title: 'x' })).toEqual({ title: 'x' })
  })

  test('formats each issue as "path: message"', () => {
    const schema = z.object({ title: z.string().min(1) })
    try {
      parseOrThrow(schema, { title: '' })
      throw new Error('expected parseOrThrow to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as Error).message).toMatch(/^title: /)
    }
  })

  test('joins multiple issues with ", "', () => {
    const schema = z.object({ a: z.string().min(1), b: z.string().min(1) })
    try {
      parseOrThrow(schema, { a: '', b: '' })
      throw new Error('expected parseOrThrow to throw')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('a: ')
      expect(message).toContain('b: ')
      expect(message).toContain(', ')
    }
  })

  test('uses an empty path prefix for object-level (refine) issues', () => {
    const schema = z
      .object({ startDate: z.string(), targetDate: z.string() })
      .refine((d) => d.targetDate >= d.startDate, {
        message: 'targetDate must be on or after startDate',
        path: ['targetDate'],
      })
    try {
      parseOrThrow(schema, { startDate: '2026-02-01', targetDate: '2026-01-01' })
      throw new Error('expected parseOrThrow to throw')
    } catch (err) {
      expect((err as Error).message).toBe('targetDate: targetDate must be on or after startDate')
    }
  })
})
