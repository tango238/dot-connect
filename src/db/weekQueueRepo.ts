import type { Database } from 'bun:sqlite'

// 「今週終わらせるタスク」の並び(week_queue)。週(月曜の week_start)ごとに
// TODO の id を実行順で持つだけで、TODO 自体の状態は todos を見る。TODO が
// 消えれば CASCADE で一緒に消える。
//
// 目標の生成(weeklyGoalDraftService)が期限・優先度から拾った TODO を末尾に
// 足し、画面からは手で足す・外す・並べ替える。自動投入(autoRun)はこの
// 順に上から候補を選ぶ。

interface QueueRow {
  todo_id: number
  position: number
  dispatch: number
}

export interface QueueEntry {
  readonly todoId: number
  // herdr に投入する対象か(自動投入の候補・手動の「投入」)。false は自分で
  // やるタスクで、一覧には並ぶが投入しない。
  readonly dispatch: boolean
}

export function listEntries(db: Database, weekStart: string): QueueEntry[] {
  const rows = db
    .query(`SELECT todo_id, position, dispatch FROM week_queue WHERE week_start = ? ORDER BY position ASC, id ASC`)
    .all(weekStart) as QueueRow[]
  return rows.map((r) => ({ todoId: r.todo_id, dispatch: r.dispatch === 1 }))
}

export function listTodoIds(db: Database, weekStart: string): number[] {
  return listEntries(db, weekStart).map((e) => e.todoId)
}

export function setDispatch(db: Database, weekStart: string, todoId: number, dispatch: boolean): boolean {
  if (!has(db, weekStart, todoId)) return false
  db.run(`UPDATE week_queue SET dispatch = ? WHERE week_start = ? AND todo_id = ?`, [dispatch ? 1 : 0, weekStart, todoId])
  return true
}

/**
 * その TODO が入っている週の行をすべて同じ印(herdr か自分か)にそろえる。
 * herdr か自分かは TODO 側で決まる(weekQueueService.ts の queueDispatchFor)
 * ので、TODO の指定・作業ディレクトリ・Grilled が変わったときに呼ぶ。
 * @returns 変えた行数
 */
export function setDispatchForTodo(db: Database, todoId: number, dispatch: boolean): number {
  const value = dispatch ? 1 : 0
  return db.run(`UPDATE week_queue SET dispatch = ? WHERE todo_id = ? AND dispatch <> ?`, [value, todoId, value]).changes
}

export function has(db: Database, weekStart: string, todoId: number): boolean {
  const row = db.query(`SELECT 1 AS x FROM week_queue WHERE week_start = ? AND todo_id = ?`).get(weekStart, todoId)
  return row !== null
}

/** 末尾に足す。既にあれば何もしない(false)。dispatch は herdr に投入する対象か。 */
export function add(db: Database, weekStart: string, todoId: number, dispatch = true): boolean {
  if (has(db, weekStart, todoId)) return false
  const { next } = db
    .query(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM week_queue WHERE week_start = ?`)
    .get(weekStart) as { next: number }
  db.run(`INSERT INTO week_queue (week_start, todo_id, position, dispatch) VALUES (?, ?, ?, ?)`, [weekStart, todoId, next, dispatch ? 1 : 0])
  return true
}

export function remove(db: Database, weekStart: string, todoId: number): boolean {
  if (!has(db, weekStart, todoId)) return false
  db.run(`DELETE FROM week_queue WHERE week_start = ? AND todo_id = ?`, [weekStart, todoId])
  return true
}

/**
 * 並びを与えられた順に置き換える。列挙されなかった既存の id は、元の相対順
 * のまま末尾へ。知らない id(その週に無い)は無視する。
 */
export function reorder(db: Database, weekStart: string, todoIds: readonly number[]): number[] {
  const current = listTodoIds(db, weekStart)
  const known = new Set(current)
  const ordered: number[] = []
  for (const id of todoIds) {
    if (known.has(id) && !ordered.includes(id)) ordered.push(id)
  }
  for (const id of current) {
    if (!ordered.includes(id)) ordered.push(id)
  }
  db.transaction(() => {
    ordered.forEach((id, position) => {
      db.run(`UPDATE week_queue SET position = ? WHERE week_start = ? AND todo_id = ?`, [position, weekStart, id])
    })
  })()
  return ordered
}
