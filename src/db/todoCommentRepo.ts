import type { Database } from 'bun:sqlite'
import type { TodoComment } from '../types'
import { touchTodo } from './todoTouch'

interface TodoCommentRow {
  id: number
  todo_id: number
  body: string
  created_at: string
}

// 作業ログは時系列で読むものなので古い順。id の昇順 = 登録順で、同じ秒に
// 2件書いても created_at の同値で順が揺れない(PRリンク・添付と同じ並べ方)。
const ORDER_BY_REGISTRATION = 'ORDER BY id ASC'

function mapRow(row: TodoCommentRow): TodoComment {
  return {
    id: row.id,
    todoId: row.todo_id,
    body: row.body,
    createdAt: row.created_at,
  }
}

export function listByTodoId(db: Database, todoId: number): TodoComment[] {
  const rows = db
    .query(`SELECT * FROM todo_comments WHERE todo_id = ? ${ORDER_BY_REGISTRATION}`)
    .all(todoId) as TodoCommentRow[]
  return rows.map(mapRow)
}

/**
 * Every comment in the database, grouped by todo id — one query for the
 * whole list rather than one per todo, for the same N+1 reason as
 * todoPullRequestRepo.groupAllByTodoId.
 */
export function groupAllByTodoId(db: Database): Map<number, TodoComment[]> {
  const rows = db
    .query(`SELECT * FROM todo_comments ${ORDER_BY_REGISTRATION}`)
    .all() as TodoCommentRow[]
  const grouped = new Map<number, TodoComment[]>()
  for (const row of rows) {
    const existing = grouped.get(row.todo_id)
    if (existing) {
      existing.push(mapRow(row))
    } else {
      grouped.set(row.todo_id, [mapRow(row)])
    }
  }
  return grouped
}

export function getById(db: Database, id: number): TodoComment | null {
  const row = db.query('SELECT * FROM todo_comments WHERE id = ?').get(id) as TodoCommentRow | null
  return row ? mapRow(row) : null
}

export interface CreateTodoCommentInput {
  readonly todoId: number
  readonly body: string
}

export function create(db: Database, input: CreateTodoCommentInput): TodoComment {
  const result = db
    .query('INSERT INTO todo_comments (todo_id, body) VALUES (?, ?) RETURNING id')
    .get(input.todoId, input.body) as { id: number }
  const created = getById(db, result.id)
  if (!created) {
    throw new Error(`Failed to load comment ${result.id} immediately after insert`)
  }
  // 作業ログの追記は人の操作なので、親TODOの最終更新を動かす
  // (todoAttachmentRepo と同じ扱い)。
  touchTodo(db, input.todoId)
  return created
}

export function remove(db: Database, id: number): boolean {
  // DELETE ... RETURNING で親idを取り、無ければ「消せなかった」
  // (todoAttachmentRepo.remove と同じ形)。
  const row = db
    .query('DELETE FROM todo_comments WHERE id = ? RETURNING todo_id')
    .get(id) as { todo_id: number } | null
  if (row === null) {
    return false
  }
  touchTodo(db, row.todo_id)
  return true
}
