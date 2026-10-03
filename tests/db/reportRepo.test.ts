import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as reportRepo from '../../src/db/reportRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

const baseInput = {
  weekStart: '2026-07-20',
  weekEnd: '2026-07-26',
  completedCount: 5,
  milestoneLinkedCount: 3,
  unplannedCount: 2,
  dispatchCount: 4,
  llmAnalysis: { summary: 'good week', warnings: [], suggestions: ['keep going'] },
}

describe('reportRepo.upsert / getByWeekStart', () => {
  test('inserts a new report and round-trips llmAnalysis as an object', () => {
    const created = reportRepo.upsert(db, baseInput)
    expect(created.completedCount).toBe(5)
    expect(created.llmAnalysis).toEqual(baseInput.llmAnalysis)

    const found = reportRepo.getByWeekStart(db, '2026-07-20')
    expect(found?.weekStart).toBe('2026-07-20')
    expect(found?.llmAnalysis?.summary).toBe('good week')
  })

  test('upsert on the same weekStart overwrites the existing row', () => {
    reportRepo.upsert(db, baseInput)
    const updated = reportRepo.upsert(db, { ...baseInput, completedCount: 9 })
    expect(updated.completedCount).toBe(9)

    const all = db.query('SELECT COUNT(*) AS count FROM weekly_reports').get() as {
      count: number
    }
    expect(all.count).toBe(1)
  })

  test('handles a null llmAnalysis', () => {
    const created = reportRepo.upsert(db, { ...baseInput, llmAnalysis: null })
    expect(created.llmAnalysis).toBeNull()
  })

  test('stores and round-trips an llmError, defaulting to null when omitted', () => {
    const withError = reportRepo.upsert(db, {
      ...baseInput,
      weekStart: '2026-07-13',
      llmAnalysis: null,
      llmError: 'claude -p timed out',
    })
    expect(withError.llmError).toBe('claude -p timed out')

    const withoutError = reportRepo.upsert(db, baseInput)
    expect(withoutError.llmError).toBeNull()
  })
})

describe('reportRepo.getLatest', () => {
  test('returns the report with the most recent weekStart', () => {
    reportRepo.upsert(db, { ...baseInput, weekStart: '2026-07-06', weekEnd: '2026-07-12' })
    reportRepo.upsert(db, { ...baseInput, weekStart: '2026-07-20', weekEnd: '2026-07-26' })
    reportRepo.upsert(db, { ...baseInput, weekStart: '2026-07-13', weekEnd: '2026-07-19' })

    expect(reportRepo.getLatest(db)?.weekStart).toBe('2026-07-20')
  })
})
