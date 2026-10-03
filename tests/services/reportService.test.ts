import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import * as milestoneRepo from '../../src/db/milestoneRepo'
import type { ClaudeRunner, WeeklyAggregate } from '../../src/services/claudeRunner'
import {
  aggregateWeek,
  generateWeeklyReport,
  mostRecentMonday,
} from '../../src/services/reportService'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

function fakeRunner(analysis = { summary: 's', warnings: [] as string[], suggestions: [] as string[] }): {
  runner: ClaudeRunner
  calls: WeeklyAggregate[]
} {
  const calls: WeeklyAggregate[] = []
  return {
    calls,
    runner: {
      analyze: async (aggregate) => {
        calls.push(aggregate)
        return analysis
      },
    },
  }
}

function failingRunner(message: string): ClaudeRunner {
  return {
    analyze: async () => {
      throw new Error(message)
    },
  }
}

// mostRecentMonday operates in local calendar time (matching SQLite's
// date(x, 'localtime') used elsewhere), so dates here are constructed with
// the local Date constructor rather than UTC ISO strings.
describe('mostRecentMonday', () => {
  test('returns the same date when today is Monday', () => {
    // 2026-07-27 is a Monday
    expect(mostRecentMonday(new Date(2026, 6, 27, 12, 0, 0))).toBe('2026-07-27')
  })

  test('returns the previous Monday for a mid-week date', () => {
    // 2026-07-30 is a Thursday
    expect(mostRecentMonday(new Date(2026, 6, 30, 12, 0, 0))).toBe('2026-07-27')
  })

  test('returns the previous Monday for a Sunday', () => {
    // 2026-08-02 is a Sunday
    expect(mostRecentMonday(new Date(2026, 7, 2, 12, 0, 0))).toBe('2026-07-27')
  })

  test('boundary: Sunday 23:59:59 still belongs to the prior week', () => {
    expect(mostRecentMonday(new Date(2026, 6, 26, 23, 59, 59))).toBe('2026-07-20')
  })

  test('boundary: Monday 00:00:01 already belongs to the new week', () => {
    expect(mostRecentMonday(new Date(2026, 6, 27, 0, 0, 1))).toBe('2026-07-27')
  })
})

describe('aggregateWeek', () => {
  test('counts completed, milestone-linked, unplanned, and dispatched activity within range', () => {
    const milestone = milestoneRepo.create(db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })

    const t1 = todoRepo.create(db, { title: 'linked', milestoneId: milestone.id })
    db.run(`INSERT INTO dispatch_events (todo_id, dispatched_at) VALUES (?, '2026-07-21 10:00:00')`, [
      t1.id,
    ])
    todoRepo.complete(db, t1.id)
    db.run(`UPDATE todos SET completed_at = '2026-07-21 12:00:00' WHERE id = ?`, [t1.id])

    const t2 = todoRepo.create(db, { title: 'unplanned' })
    todoRepo.complete(db, t2.id)
    db.run(`UPDATE todos SET completed_at = '2026-07-25 09:00:00' WHERE id = ?`, [t2.id])

    // Outside the week range — should not be counted.
    const t3 = todoRepo.create(db, { title: 'old completion' })
    todoRepo.complete(db, t3.id)
    db.run(`UPDATE todos SET completed_at = '2026-06-01 09:00:00' WHERE id = ?`, [t3.id])
    db.run(`INSERT INTO dispatch_events (todo_id, dispatched_at) VALUES (?, '2026-06-01 09:00:00')`, [
      t3.id,
    ])

    const result = aggregateWeek(db, '2026-07-20', '2026-07-26')
    expect(result).toEqual({
      completedCount: 2,
      milestoneLinkedCount: 1,
      unplannedCount: 1,
      dispatchCount: 1,
    })
  })

  test('milestone_linked_count is based on completedMilestoneId, not the current milestone_id', () => {
    const milestone = milestoneRepo.create(db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const t1 = todoRepo.create(db, { title: 'x', milestoneId: milestone.id })
    todoRepo.complete(db, t1.id)
    db.run(`UPDATE todos SET completed_at = '2026-07-21 12:00:00' WHERE id = ?`, [t1.id])
    // Unlinking after completion must not change the historical count.
    todoRepo.update(db, t1.id, { milestoneId: null })

    const result = aggregateWeek(db, '2026-07-20', '2026-07-26')
    expect(result.milestoneLinkedCount).toBe(1)
    expect(result.unplannedCount).toBe(0)
  })

  test('returns all zeros when there is no activity in range', () => {
    expect(aggregateWeek(db, '2026-07-20', '2026-07-26')).toEqual({
      completedCount: 0,
      milestoneLinkedCount: 0,
      unplannedCount: 0,
      dispatchCount: 0,
    })
  })
})

describe('generateWeeklyReport', () => {
  test('uses the explicit weekStart when provided and stores the LLM analysis', async () => {
    const { runner, calls } = fakeRunner({
      summary: 'great',
      warnings: ['w1'],
      suggestions: ['s1'],
    })

    const report = await generateWeeklyReport(db, runner, { weekStart: '2026-07-20' })

    expect(report.weekStart).toBe('2026-07-20')
    expect(report.weekEnd).toBe('2026-07-26')
    expect(report.llmAnalysis).toEqual({ summary: 'great', warnings: ['w1'], suggestions: ['s1'] })
    expect(report.llmError).toBeNull()
    expect(calls[0]?.weekStart).toBe('2026-07-20')
  })

  test('defaults to the most recent Monday when weekStart is omitted', async () => {
    const { runner } = fakeRunner()
    const report = await generateWeeklyReport(db, runner, {
      now: new Date(2026, 6, 30, 12, 0, 0),
    })
    expect(report.weekStart).toBe('2026-07-27')
    expect(report.weekEnd).toBe('2026-08-02')
  })

  test('persists the report so it can be read back by weekStart', async () => {
    const { runner } = fakeRunner()
    await generateWeeklyReport(db, runner, { weekStart: '2026-07-20' })
    const reportRepo = await import('../../src/db/reportRepo')
    expect(reportRepo.getByWeekStart(db, '2026-07-20')).not.toBeNull()
  })

  test('still saves the numeric counts, with llmError set, when the LLM analysis fails', async () => {
    const runner = failingRunner('claude -p timed out')
    todoRepo.create(db, { title: 'x' })

    const report = await generateWeeklyReport(db, runner, { weekStart: '2026-07-20' })

    expect(report.llmAnalysis).toBeNull()
    expect(report.llmError).toBe('claude -p timed out')
    expect(report.completedCount).toBe(0)

    const reportRepo = await import('../../src/db/reportRepo')
    expect(reportRepo.getByWeekStart(db, '2026-07-20')).not.toBeNull()
  })
})
