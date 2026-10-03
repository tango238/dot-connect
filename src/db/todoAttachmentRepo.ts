import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import type { TodoAttachment } from '../types'
import { touchTodo } from './todoTouch'

interface TodoAttachmentRow {
  id: number
  todo_id: number
  stored_name: string
  original_name: string
  size_bytes: number
  created_at: string
}

// Oldest first: attachments accumulate as work proceeds, so registration
// order is the order they were added in (same as todo_pull_requests).
const ORDER_BY_REGISTRATION = 'ORDER BY id ASC'

// path は行から読むのではなく uploadDir と組み合わせて毎回作る。保存先フォル
// ダを設定で変えたときに古い絶対パスが行に残らないようにするため、これが
// uploadDir を全関数に引き回している理由でもある。
function mapRow(row: TodoAttachmentRow, uploadDir: string): TodoAttachment {
  return {
    id: row.id,
    todoId: row.todo_id,
    storedName: row.stored_name,
    originalName: row.original_name,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    path: join(uploadDir, row.stored_name),
  }
}

export function listByTodoId(db: Database, todoId: number, uploadDir: string): TodoAttachment[] {
  const rows = db
    .query(`SELECT * FROM todo_attachments WHERE todo_id = ? ${ORDER_BY_REGISTRATION}`)
    .all(todoId) as TodoAttachmentRow[]
  return rows.map((row) => mapRow(row, uploadDir))
}

/**
 * Every attachment in the database, grouped by todo id — one query for the
 * whole list rather than one per todo, for the same N+1 reason as
 * todoPullRequestRepo.groupAllByTodoId.
 */
export function groupAllByTodoId(db: Database, uploadDir: string): Map<number, TodoAttachment[]> {
  const rows = db
    .query(`SELECT * FROM todo_attachments ${ORDER_BY_REGISTRATION}`)
    .all() as TodoAttachmentRow[]
  const grouped = new Map<number, TodoAttachment[]>()
  for (const row of rows) {
    const existing = grouped.get(row.todo_id)
    if (existing) {
      existing.push(mapRow(row, uploadDir))
    } else {
      grouped.set(row.todo_id, [mapRow(row, uploadDir)])
    }
  }
  return grouped
}

export function getById(db: Database, id: number, uploadDir: string): TodoAttachment | null {
  const row = db
    .query('SELECT * FROM todo_attachments WHERE id = ?')
    .get(id) as TodoAttachmentRow | null
  return row ? mapRow(row, uploadDir) : null
}

/** 添付の件数だけが要る場面(上限チェック)向け — 行を読まずに数える。 */
export function countByTodoId(db: Database, todoId: number): number {
  const row = db
    .query('SELECT COUNT(*) AS count FROM todo_attachments WHERE todo_id = ?')
    .get(todoId) as { count: number }
  return row.count
}

export interface CreateTodoAttachmentInput {
  readonly todoId: number
  readonly storedName: string
  readonly originalName: string
  readonly sizeBytes: number
}

export function create(
  db: Database,
  input: CreateTodoAttachmentInput,
  uploadDir: string
): TodoAttachment {
  const result = db
    .query(
      `INSERT INTO todo_attachments (todo_id, stored_name, original_name, size_bytes)
       VALUES (?, ?, ?, ?) RETURNING id`
    )
    .get(input.todoId, input.storedName, input.originalName, input.sizeBytes) as { id: number }
  const created = getById(db, result.id, uploadDir)
  if (!created) {
    throw new Error(`Failed to load attachment ${result.id} immediately after insert`)
  }
  // 添付の付け外しは人の操作なので、親TODOの最終更新を動かす
  // (todoPullRequestRepo のリンク追加/削除と同じ扱い)。
  touchTodo(db, input.todoId)
  return created
}

export function remove(db: Database, id: number): boolean {
  // 親idの取得に uploadDir が要らないよう DELETE ... RETURNING で済ませる
  // (todoPullRequestRepo.remove と同じ形)。該当行が無ければ null が返るので、
  // それがそのまま「消せなかった」の判定になる。
  const row = db
    .query('DELETE FROM todo_attachments WHERE id = ? RETURNING todo_id')
    .get(id) as { todo_id: number } | null
  if (row === null) {
    return false
  }
  touchTodo(db, row.todo_id)
  return true
}
