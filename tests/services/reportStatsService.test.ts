import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as milestoneRepo from '../../src/db/milestoneRepo'
import * as todoRepo from '../../src/db/todoRepo'
import {
  computeWeeklyStats,
  DELETED_MILESTONE_TITLE,
  median,
  UNPLANNED_MILESTONE_TITLE,
} from '../../src/services/reportStatsService'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

// Timestamps are written straight into the table as SQLite UTC strings. The
// week under test (2026-07-20 … 2026-07-26) sits mid-month at midday so the
// localtime conversion can't push anything across a day boundary in any
// timezone the tests might run in.
function todo(title: string, createdAt: string, completedAt: string | null, extra: Partial<Parameters<typeof todoRepo.create>[1]> = {}) {
  const created = todoRepo.create(db, { title, ...extra })
  db.run(`UPDATE todos SET created_at = ? WHERE id = ?`, [createdAt, created.id])
  if (completedAt !== null) {
    todoRepo.complete(db, created.id)
    db.run(`UPDATE todos SET completed_at = ? WHERE id = ?`, [completedAt, created.id])
  }
  return created
}

describe('median', () => {
  test('empty → null, odd → middle, even → mean of the two middles', () => {
    expect(median([])).toBeNull()
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('computeWeeklyStats', () => {
  test('counts created and completed within the week, daily, with the previous week for comparison', () => {
    todo('created and completed this week', '2026-07-21 10:00:00', '2026-07-21 12:00:00')
    todo('created last week, completed this week', '2026-07-15 10:00:00', '2026-07-23 12:00:00')
    todo('created this week, still open', '2026-07-25 10:00:00', null)
    todo('last week only', '2026-07-14 10:00:00', '2026-07-16 12:00:00')
    todo('long ago', '2026-01-01 10:00:00', '2026-01-02 12:00:00')

    const stats = computeWeeklyStats(db, '2026-07-20', '2026-07-30')

    expect(stats.weekStart).toBe('2026-07-20')
    expect(stats.weekEnd).toBe('2026-07-26')
    expect(stats.completedCount).toBe(2)
    expect(stats.createdCount).toBe(2)
    expect(stats.previous).toEqual({ completedCount: 1, createdCount: 2, dispatchCount: 0 })
    expect(stats.daily).toHaveLength(7)
    expect(stats.daily.map((d) => d.date)).toEqual([
      '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26',
    ])
    expect(stats.daily[1]).toEqual({ date: '2026-07-21', created: 1, completed: 1 })
    expect(stats.daily[3]).toEqual({ date: '2026-07-23', created: 0, completed: 1 })
    expect(stats.daily[5]).toEqual({ date: '2026-07-25', created: 1, completed: 0 })
  })

  test('fastest lists up to five completions ordered by lead time, with lead minutes', () => {
    for (let i = 1; i <= 7; i++) {
      // i hours from creation to completion → the first five are 1h…5h.
      todo(`t${i}`, '2026-07-21 10:00:00', `2026-07-21 ${String(10 + i).padStart(2, '0')}:00:00`)
    }
    const stats = computeWeeklyStats(db, '2026-07-20', '2026-07-30')
    expect(stats.fastest.map((t) => t.title)).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect(stats.fastest.map((t) => t.leadMinutes)).toEqual([60, 120, 180, 240, 300])
    expect(stats.fastest[0]).toMatchObject({
      priority: 'none',
      milestoneTitle: null,
      createdAt: '2026-07-21 10:00:00',
      completedAt: '2026-07-21 11:00:00',
    })
    expect(stats.leadTime).toEqual({ averageMinutes: 240, medianMinutes: 240 })
  })

  test('fastest shows the milestone the TODO was completed under, and a negative lead is clamped to 0', () => {
    const milestone = milestoneRepo.create(db, { title: 'M', startDate: '2026-01-01', targetDate: '2026-12-01' })
    const t = todo('fast', '2026-07-21 10:00:00', '2026-07-21 10:30:00', { milestoneId: milestone.id })
    todoRepo.update(db, t.id, { milestoneId: null }) // unlinking later must not change history
    todo('clock skew', '2026-07-21 12:00:00', '2026-07-21 11:00:00')

    const stats = computeWeeklyStats(db, '2026-07-20', '2026-07-30')
    expect(stats.fastest.map((t) => [t.title, t.leadMinutes, t.milestoneTitle])).toEqual([
      ['clock skew', 0, null],
      ['fast', 30, 'M'],
    ])
  })

  test('onTime counts only completions that had a due date, and whether they met it', () => {
    todo('on time', '2026-07-20 10:00:00', '2026-07-21 12:00:00', { dueDate: '2026-07-21' })
    todo('early', '2026-07-20 10:00:00', '2026-07-21 12:00:00', { dueDate: '2026-07-30' })
    todo('late', '2026-07-20 10:00:00', '2026-07-23 12:00:00', { dueDate: '2026-07-22' })
    todo('no due', '2026-07-20 10:00:00', '2026-07-23 12:00:00')
    const stats = computeWeeklyStats(db, '2026-07-20', '2026-07-30')
    expect(stats.onTime).toEqual({ withDueCount: 3, onTimeCount: 2 })
  })

  test('byPriority always carries all three keys', () => {
    todo('h', '2026-07-20 10:00:00', '2026-07-21 12:00:00', { priority: 'high' })
    todo('h2', '2026-07-20 10:00:00', '2026-07-21 12:00:00', { priority: 'high' })
    todo('n', '2026-07-20 10:00:00', '2026-07-21 12:00:00')
    expect(computeWeeklyStats(db, '2026-07-20', '2026-07-30').byPriority).toEqual({ high: 2, low: 0, none: 1 })
  })

  test('byMilestone groups by the milestone at completion time, naming unlinked and deleted ones', () => {
    const a = milestoneRepo.create(db, { title: 'A', startDate: '2026-01-01', targetDate: '2026-12-01' })
    const gone = milestoneRepo.create(db, { title: 'Gone', startDate: '2026-01-01', targetDate: '2026-12-01' })
    todo('a1', '2026-07-20 10:00:00', '2026-07-21 12:00:00', { milestoneId: a.id })
    todo('a2', '2026-07-20 10:00:00', '2026-07-21 12:00:00', { milestoneId: a.id })
    todo('g', '2026-07-20 10:00:00', '2026-07-21 12:00:00', { milestoneId: gone.id })
    todo('none', '2026-07-20 10:00:00', '2026-07-21 12:00:00')
    milestoneRepo.remove(db, gone.id)

    const stats = computeWeeklyStats(db, '2026-07-20', '2026-07-30')
    expect(stats.byMilestone.map((m) => [m.title, m.count])).toEqual([
      ['A', 2],
      [UNPLANNED_MILESTONE_TITLE, 1],
      [DELETED_MILESTONE_TITLE, 1],
    ])
    expect(stats.byMilestone[0]?.milestoneId).toBe(a.id)
    expect(stats.milestoneLinkedCount).toBe(3)
    expect(stats.unplannedCount).toBe(1)
  })

  test('backlog describes the open TODOs as of today, not the week', () => {
    todo('overdue', '2026-07-01 10:00:00', null, { dueDate: '2026-07-28' })
    // Due inside the week being viewed and already past today: counted in
    // both dueThisWeek and overdue.
    todo('due this week', '2026-07-01 10:00:00', null, { dueDate: '2026-07-24' })
    todo('due later', '2026-07-01 10:00:00', null, { dueDate: '2026-08-10' })
    todo('no due', '2026-07-01 10:00:00', null)
    todo('done', '2026-07-01 10:00:00', '2026-07-02 10:00:00', { dueDate: '2026-07-01' })
    const stats = computeWeeklyStats(db, '2026-07-20', '2026-07-30')
    expect(stats.backlog).toEqual({ openCount: 4, overdueCount: 2, dueThisWeekCount: 1 })
    // Viewed on a day before any due date, nothing is overdue yet.
    expect(computeWeeklyStats(db, '2026-07-20', '2026-07-20').backlog.overdueCount).toBe(0)
  })

  test('an empty database yields zeros and nulls rather than throwing', () => {
    const stats = computeWeeklyStats(db, '2026-07-20', '2026-07-30')
    expect(stats.completedCount).toBe(0)
    expect(stats.createdCount).toBe(0)
    expect(stats.fastest).toEqual([])
    expect(stats.leadTime).toEqual({ averageMinutes: null, medianMinutes: null })
    expect(stats.onTime).toEqual({ withDueCount: 0, onTimeCount: 0 })
    expect(stats.byMilestone).toEqual([])
    expect(stats.daily.every((d) => d.created === 0 && d.completed === 0)).toBe(true)
  })
})
