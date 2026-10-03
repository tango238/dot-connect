import type { Database } from 'bun:sqlite'

export function recordDispatch(db: Database, todoId: number): void {
  db.run(`INSERT INTO dispatch_events (todo_id, dispatched_at) VALUES (?, datetime('now'))`, [
    todoId,
  ])
}

// weekStart/weekEnd are local calendar dates (YYYY-MM-DD); dispatched_at is
// stored in UTC, so the comparison converts it to local time first (see F7).
export function countInRange(db: Database, weekStart: string, weekEnd: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count FROM dispatch_events
       WHERE date(dispatched_at, 'localtime') BETWEEN ? AND ?`
    )
    .get(weekStart, weekEnd) as { count: number }
  return row.count
}
