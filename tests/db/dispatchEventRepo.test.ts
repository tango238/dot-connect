import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as dispatchEventRepo from '../../src/db/dispatchEventRepo'
import * as todoRepo from '../../src/db/todoRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

describe('dispatchEventRepo.recordDispatch', () => {
  test('inserts a row for the given todo with a dispatchedAt timestamp', () => {
    const todo = todoRepo.create(db, { title: 'x' })
    dispatchEventRepo.recordDispatch(db, todo.id)

    const row = db
      .query('SELECT todo_id, dispatched_at FROM dispatch_events WHERE todo_id = ?')
      .get(todo.id) as { todo_id: number; dispatched_at: string }
    expect(row.todo_id).toBe(todo.id)
    expect(row.dispatched_at).not.toBeNull()
  })

  test('allows multiple dispatch events for the same todo (re-dispatch)', () => {
    const todo = todoRepo.create(db, { title: 'x' })
    dispatchEventRepo.recordDispatch(db, todo.id)
    dispatchEventRepo.recordDispatch(db, todo.id)

    const count = db
      .query('SELECT COUNT(*) AS count FROM dispatch_events WHERE todo_id = ?')
      .get(todo.id) as { count: number }
    expect(count.count).toBe(2)
  })
})

describe('dispatchEventRepo.countInRange', () => {
  test('counts dispatch events whose local date falls within the range', () => {
    const todo = todoRepo.create(db, { title: 'x' })
    dispatchEventRepo.recordDispatch(db, todo.id)
    db.run(`UPDATE dispatch_events SET dispatched_at = '2026-07-21 10:00:00' WHERE todo_id = ?`, [
      todo.id,
    ])

    dispatchEventRepo.recordDispatch(db, todo.id)
    db.run(
      `UPDATE dispatch_events SET dispatched_at = '2026-06-01 10:00:00'
       WHERE todo_id = ? AND dispatched_at != '2026-07-21 10:00:00'`,
      [todo.id]
    )

    expect(dispatchEventRepo.countInRange(db, '2026-07-20', '2026-07-26')).toBe(1)
  })

  test('returns 0 when there are no matching events', () => {
    expect(dispatchEventRepo.countInRange(db, '2026-07-20', '2026-07-26')).toBe(0)
  })
})
