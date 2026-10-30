import type { Database } from 'bun:sqlite'
import type { WeeklyGoal } from '../types'

// 週ごとの目標(週次レポート画面の自由入力)。週は週次レポートと同じく
// 月曜始まりの week_start で引く。空文字を保存すると「目標なし」と同じ扱い
// だが、行は残す(消した事実も updated_at に残る)。

interface WeeklyGoalRow {
  week_start: string
  body: string
  updated_at: string
}

function mapRow(row: WeeklyGoalRow): WeeklyGoal {
  return { weekStart: row.week_start, body: row.body, updatedAt: row.updated_at }
}

export function getByWeekStart(db: Database, weekStart: string): WeeklyGoal | null {
  const row = db.query(`SELECT * FROM weekly_goals WHERE week_start = ?`).get(weekStart) as WeeklyGoalRow | null
  return row ? mapRow(row) : null
}

export function upsert(db: Database, weekStart: string, body: string): WeeklyGoal {
  const row = db
    .query(
      `INSERT INTO weekly_goals (week_start, body, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(week_start) DO UPDATE SET body = excluded.body, updated_at = datetime('now')
       RETURNING *`
    )
    .get(weekStart, body) as WeeklyGoalRow
  return mapRow(row)
}
