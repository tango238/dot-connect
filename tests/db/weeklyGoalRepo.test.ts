import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as weeklyGoalRepo from '../../src/db/weeklyGoalRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

describe('weeklyGoalRepo', () => {
  test('returns null for a week without a goal', () => {
    expect(weeklyGoalRepo.getByWeekStart(db, '2026-07-20')).toBeNull()
  })

  test('upsert creates, then replaces, the goal for a week and stamps updated_at', () => {
    const first = weeklyGoalRepo.upsert(db, '2026-07-20', '- 検索を出す')
    expect(first).toMatchObject({ weekStart: '2026-07-20', body: '- 検索を出す' })
    expect(first.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    db.run(`UPDATE weekly_goals SET updated_at = '2020-01-01 00:00:00'`)
    const second = weeklyGoalRepo.upsert(db, '2026-07-20', '- 検索を出す\n- CI を速く')
    expect(second.body).toBe('- 検索を出す\n- CI を速く')
    expect(second.updatedAt).not.toBe('2020-01-01 00:00:00')
    expect(weeklyGoalRepo.getByWeekStart(db, '2026-07-20')?.body).toBe(second.body)
    expect(db.query(`SELECT COUNT(*) AS n FROM weekly_goals`).get()).toEqual({ n: 1 })
  })

  test('weeks are independent and an empty body is kept as a row', () => {
    weeklyGoalRepo.upsert(db, '2026-07-20', 'a')
    weeklyGoalRepo.upsert(db, '2026-07-27', '')
    expect(weeklyGoalRepo.getByWeekStart(db, '2026-07-20')?.body).toBe('a')
    expect(weeklyGoalRepo.getByWeekStart(db, '2026-07-27')?.body).toBe('')
  })
})
