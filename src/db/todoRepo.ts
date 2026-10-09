import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type {
  SessionState,
  Todo,
  TodoAttachment,
  TodoComment,
  TodoPriority,
  TodoPullRequest,
  TodoStatus,
} from '../types'
import * as todoAttachmentRepo from './todoAttachmentRepo'
import * as todoCommentRepo from './todoCommentRepo'
import * as todoPullRequestRepo from './todoPullRequestRepo'
import { resolveUploadDirFor } from './uploadDirLocation'

interface TodoRow {
  id: number
  title: string
  description: string
  milestone_id: number | null
  milestone_title: string | null
  milestone_color: string | null
  status: TodoStatus
  priority: TodoPriority
  due_date: string | null
  workspace_path: string | null
  herdr_workspace_id: string | null
  herdr_tab_id: string | null
  herdr_pane_id: string | null
  session_state: SessionState
  dispatched_at: string | null
  completed_at: string | null
  completed_milestone_id: number | null
  model: string | null
  created_at: string
  updated_at: string | null
  grill_dir: string | null
}

const SELECT_WITH_MILESTONE = `
  SELECT
    t.id, t.title, t.description, t.milestone_id,
    m.title AS milestone_title, m.color AS milestone_color,
    t.status, t.priority, t.workspace_path,
    t.herdr_workspace_id, t.herdr_tab_id, t.herdr_pane_id,
    t.session_state, t.dispatched_at, t.completed_at, t.completed_milestone_id, t.model, t.due_date,
    t.created_at, t.updated_at, t.grill_dir
  FROM todos t
  LEFT JOIN milestones m ON m.id = t.milestone_id
`

// 何を updated_at の「更新」に数えるかの方針は todoTouch.ts に一箇所で書いて
// ある。このファイルは todos への UPDATE を自前で持っているので touchTodo() を
// 呼ばず SET 句に畳んでいるだけで、線引きの根拠はあちらを見ること。

// 期限ありが先(期限の昇順 — 過期が自然に最上部に来る)、期限なしはその後ろ
// で優先度順。同順位は id 昇順で安定させる。完了状態はここでは考慮しない
// ——完了のグループ分けはフロントの責務(renderTodoList)。
const ORDER_BY_DUE_THEN_PRIORITY = `
  ORDER BY
    CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
    t.due_date ASC,
    CASE t.priority WHEN 'high' THEN 0 WHEN 'low' THEN 1 ELSE 2 END,
    t.id ASC
`

function mapRow(
  row: TodoRow,
  pullRequests: TodoPullRequest[] = [],
  attachments: TodoAttachment[] = [],
  comments: TodoComment[] = []
): Todo {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    milestoneId: row.milestone_id,
    milestoneTitle: row.milestone_title,
    milestoneColor: row.milestone_color,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    workspacePath: row.workspace_path,
    herdrWorkspaceId: row.herdr_workspace_id,
    herdrTabId: row.herdr_tab_id,
    herdrPaneId: row.herdr_pane_id,
    sessionState: row.session_state,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
    completedMilestoneId: row.completed_milestone_id,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    grillDir: row.grill_dir,
    pullRequests,
    attachments,
    comments,
  }
}

export function listAll(db: Database): Todo[] {
  const rows = db.query(`${SELECT_WITH_MILESTONE} ${ORDER_BY_DUE_THEN_PRIORITY}`).all() as TodoRow[]
  // One extra query for every todo's PR links, not one per todo — see
  // groupAllByTodoId's comment in todoPullRequestRepo.ts. Attachments are
  // read the same way.
  const pullRequestsByTodoId = todoPullRequestRepo.groupAllByTodoId(db)
  const attachmentsByTodoId = todoAttachmentRepo.groupAllByTodoId(db, resolveUploadDirFor(db))
  const commentsByTodoId = todoCommentRepo.groupAllByTodoId(db)
  return rows.map((row) =>
    mapRow(
      row,
      pullRequestsByTodoId.get(row.id) ?? [],
      attachmentsByTodoId.get(row.id) ?? [],
      commentsByTodoId.get(row.id) ?? []
    )
  )
}

export function getById(db: Database, id: number): Todo | null {
  const row = db
    .query(`${SELECT_WITH_MILESTONE} WHERE t.id = ?`)
    .get(id) as TodoRow | null
  return row
    ? mapRow(
        row,
        todoPullRequestRepo.listByTodoId(db, id),
        todoAttachmentRepo.listByTodoId(db, id, resolveUploadDirFor(db)),
        todoCommentRepo.listByTodoId(db, id)
      )
    : null
}

export interface CreateTodoInput {
  readonly title: string
  readonly description?: string
  readonly milestoneId?: number | null
  readonly priority?: TodoPriority
  readonly dueDate?: string | null
  readonly workspacePath?: string | null
  readonly model?: string | null
}

export function create(db: Database, input: CreateTodoInput): Todo {
  const result = db
    .query(
      `INSERT INTO todos (title, description, milestone_id, priority, workspace_path, model, due_date) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      input.title,
      input.description ?? '',
      input.milestoneId ?? null,
      input.priority ?? 'none',
      input.workspacePath ?? null,
      input.model ?? null,
      input.dueDate ?? null
    ) as { id: number }
  const created = getById(db, result.id)
  if (!created) {
    throw new Error(`Failed to load todo ${result.id} immediately after insert`)
  }
  return created
}

export interface UpdateTodoInput {
  readonly title?: string
  readonly description?: string
  readonly milestoneId?: number | null
  readonly priority?: TodoPriority
  // Same undefined/null convention as workspacePath/model below: undefined
  // leaves the stored due date untouched, null explicitly clears it.
  readonly dueDate?: string | null
  // undefined leaves the stored path untouched; null explicitly clears it
  // (same convention as milestoneId).
  readonly workspacePath?: string | null
  // Same undefined/null convention as workspacePath: undefined leaves the
  // stored model untouched, null clears it back to "use claude's default".
  readonly model?: string | null
}

export function update(db: Database, id: number, input: UpdateTodoInput): Todo | null {
  if (getById(db, id) === null) {
    return null
  }

  const sets: string[] = []
  const values: SQLQueryBindings[] = []

  if (input.title !== undefined) {
    sets.push('title = ?')
    values.push(input.title)
  }
  if (input.description !== undefined) {
    sets.push('description = ?')
    values.push(input.description)
  }
  if (input.milestoneId !== undefined) {
    sets.push('milestone_id = ?')
    values.push(input.milestoneId)
  }
  if (input.priority !== undefined) {
    sets.push('priority = ?')
    values.push(input.priority)
  }
  if (input.dueDate !== undefined) {
    sets.push('due_date = ?')
    values.push(input.dueDate)
  }
  if (input.workspacePath !== undefined) {
    sets.push('workspace_path = ?')
    values.push(input.workspacePath)
  }
  if (input.model !== undefined) {
    sets.push('model = ?')
    values.push(input.model)
  }

  // sets が空なら SQL 自体を撃たない(既存の挙動)。updated_at もその中に置く
  // ので、何も変えない PATCH で最終更新だけが進むことはない。
  if (sets.length > 0) {
    sets.push(`updated_at = datetime('now')`)
    values.push(id)
    db.run(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`, values)
  }

  return getById(db, id)
}

export function complete(db: Database, id: number): Todo | null {
  const existing = getById(db, id)
  if (existing === null) {
    return null
  }
  const nextSessionState = existing.sessionState !== null ? 'idle' : null
  db.run(
    `UPDATE todos SET
       status = 'done', completed_at = datetime('now'), session_state = ?,
       completed_milestone_id = milestone_id, updated_at = datetime('now')
     WHERE id = ?`,
    [nextSessionState, id]
  )
  return getById(db, id)
}

export function reopen(db: Database, id: number): Todo | null {
  if (getById(db, id) === null) {
    return null
  }
  db.run(
    `UPDATE todos SET
       status = 'open', completed_at = NULL, completed_milestone_id = NULL,
       updated_at = datetime('now')
     WHERE id = ?`,
    [id]
  )
  return getById(db, id)
}

export function remove(db: Database, id: number): boolean {
  const result = db.run(`DELETE FROM todos WHERE id = ?`, [id])
  return result.changes > 0
}

export interface DispatchInfo {
  readonly herdrWorkspaceId: string
  readonly herdrTabId: string
  readonly herdrPaneId: string
}

export function markDispatched(db: Database, id: number, info: DispatchInfo): Todo {
  db.run(
    `UPDATE todos SET
       herdr_workspace_id = ?, herdr_tab_id = ?, herdr_pane_id = ?,
       session_state = 'working', dispatched_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
    [info.herdrWorkspaceId, info.herdrTabId, info.herdrPaneId, id]
  )
  const todo = getById(db, id)
  if (!todo) {
    throw new Error(`Failed to load todo ${id} after marking dispatched`)
  }
  return todo
}

export function updateSessionState(db: Database, id: number, state: SessionState): void {
  // statusSync は状態が実際に変わったときしかここを呼ばないので、最終更新に
  // 数えても背景同期のたびに並びが揺れることはない。
  db.run(`UPDATE todos SET session_state = ?, updated_at = datetime('now') WHERE id = ?`, [state, id])
}

// Clears a todo's herdr session linkage entirely: used when a dispatch fails
// after the workspace was already recorded (roll back to "never dispatched"),
// and when statusSync finds the recorded pane no longer exists in herdr at
// all (the workspace was closed outside of dot-connect).
// 完了時の後片付け: 閉じたペインへの参照だけを外す。
//
// clearDispatch と違って dispatched_at は残す —— あちらは「投入を無かった
// ことにする」ロールバックだが、こちらでは投入は実際に起きている。消すと
// 詳細ダイアログの「投入」行(todoDetail.js)が復元不能に空になる。
//
// expected と一致するときだけ消すのは、閉じる操作(最大10秒ブロックしうる)の
// 最中に reopen → 再dispatch が走る可能性があるため。無条件に消すと新しい
// 紐付けを潰してワークスペースを孤児にする。条件を SQL 側に置いて、読んでから
// 書くまでの隙間を無くす。
export function clearSessionIfWorkspace(db: Database, id: number, expected: string): void {
  db.run(
    `UPDATE todos SET
       herdr_workspace_id = NULL, herdr_tab_id = NULL, herdr_pane_id = NULL,
       session_state = NULL, updated_at = datetime('now')
     WHERE id = ? AND herdr_workspace_id = ?`,
    [id, expected]
  )
}

export function clearDispatch(db: Database, id: number): void {
  db.run(
    `UPDATE todos SET
       herdr_workspace_id = NULL, herdr_tab_id = NULL, herdr_pane_id = NULL,
       session_state = NULL, dispatched_at = NULL, updated_at = datetime('now')
     WHERE id = ?`,
    [id]
  )
}

// Grill の作業ディレクトリを記録する(null で外す)。ディレクトリそのものの
// 作成・削除は grillService.ts の責務で、ここは列を書くだけ。
export function setGrillDir(db: Database, id: number, dir: string | null): void {
  db.run(`UPDATE todos SET grill_dir = ?, updated_at = datetime('now') WHERE id = ?`, [dir, id])
}
