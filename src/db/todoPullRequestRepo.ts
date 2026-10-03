import type { Database } from 'bun:sqlite'
import { ConflictError } from '../services/errors'
import type { PullRequestState, TodoPullRequest } from '../types'
import { touchTodo } from './todoTouch'

const DUPLICATE_URL_MESSAGE = 'このPRは既にこのTODOに登録されています'

interface TodoPullRequestRow {
  id: number
  todo_id: number
  url: string
  owner: string
  repo: string
  number: number
  title: string | null
  state: PullRequestState | null
  is_draft: number | null
  fetched_at: string | null
  fetch_error: string | null
  created_at: string
}

// Oldest first: PRs accumulate as work proceeds, so registration order is
// the order they happened in.
const ORDER_BY_REGISTRATION = 'ORDER BY id ASC'

function mapRow(row: TodoPullRequestRow): TodoPullRequest {
  return {
    id: row.id,
    todoId: row.todo_id,
    url: row.url,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    title: row.title,
    state: row.state,
    // SQLite has no boolean type; NULL stays NULL ("never fetched") rather
    // than collapsing into false.
    isDraft: row.is_draft === null ? null : row.is_draft === 1,
    fetchedAt: row.fetched_at,
    fetchError: row.fetch_error,
    createdAt: row.created_at,
  }
}

// bun:sqlite surfaces constraint violations as a plain Error carrying a
// driver-level `code`, so this is the only reliable way to tell "already
// registered" from any other failure (same approach as workspaceRepo.ts).
function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error && (err as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

export function listByTodoId(db: Database, todoId: number): TodoPullRequest[] {
  const rows = db
    .query(`SELECT * FROM todo_pull_requests WHERE todo_id = ? ${ORDER_BY_REGISTRATION}`)
    .all(todoId) as TodoPullRequestRow[]
  return rows.map(mapRow)
}

/**
 * Every PR link in the database, grouped by todo id. One query for the whole
 * list rather than one per todo — todoRepo.listAll() attaches these to every
 * todo it returns, which would otherwise be an N+1.
 */
export function groupAllByTodoId(db: Database): Map<number, TodoPullRequest[]> {
  const rows = db
    .query(`SELECT * FROM todo_pull_requests ${ORDER_BY_REGISTRATION}`)
    .all() as TodoPullRequestRow[]
  const grouped = new Map<number, TodoPullRequest[]>()
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

export function getById(db: Database, id: number): TodoPullRequest | null {
  const row = db
    .query('SELECT * FROM todo_pull_requests WHERE id = ?')
    .get(id) as TodoPullRequestRow | null
  return row ? mapRow(row) : null
}

export interface CreateTodoPullRequestInput {
  readonly todoId: number
  readonly url: string
  readonly owner: string
  readonly repo: string
  readonly number: number
}

export function create(db: Database, input: CreateTodoPullRequestInput): TodoPullRequest {
  let result: { id: number }
  try {
    result = db
      .query(
        `INSERT INTO todo_pull_requests (todo_id, url, owner, repo, number)
         VALUES (?, ?, ?, ?, ?) RETURNING id`
      )
      .get(input.todoId, input.url, input.owner, input.repo, input.number) as { id: number }
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(DUPLICATE_URL_MESSAGE)
    }
    throw err
  }
  const created = getById(db, result.id)
  if (!created) {
    throw new Error(`Failed to load pull request ${result.id} immediately after insert`)
  }
  // PRを紐付けるのは人の操作なので、親TODOの最終更新を動かす。下の
  // recordFetchSuccess/recordFetchError では、経路(定期の refresh-stale /
  // 登録直後の取得 / 更新ボタンの手動実行)を問わず動かさない —— 動いたのは
  // GitHub側のPRであってTODOではないため。定期実行で数えると、PRが付いた
  // 全TODOが中身の変化なしに更新順の先頭へ上がり続ける。
  touchTodo(db, input.todoId)
  return created
}

export interface PullRequestSnapshotInput {
  readonly title: string
  readonly state: PullRequestState
  readonly isDraft: boolean
}

/** Records a successful fetch, clearing any previously stored error. */
export function recordFetchSuccess(
  db: Database,
  id: number,
  snapshot: PullRequestSnapshotInput
): void {
  db.run(
    `UPDATE todo_pull_requests SET
       title = ?, state = ?, is_draft = ?, fetched_at = datetime('now'), fetch_error = NULL
     WHERE id = ?`,
    [snapshot.title, snapshot.state, snapshot.isDraft ? 1 : 0, id]
  )
}

/**
 * Records a failed fetch. title/state/fetched_at are deliberately left
 * untouched: a refresh that fails should leave the last known-good snapshot
 * on screen (annotated with the error) rather than blanking it out.
 */
export function recordFetchError(db: Database, id: number, error: string): void {
  db.run('UPDATE todo_pull_requests SET fetch_error = ? WHERE id = ?', [error, id])
}

export function remove(db: Database, id: number): boolean {
  // DELETE ... RETURNING で親idを取る。DELETE 後の行からは todo_id を読めない
  // が、先に SELECT を撃つと同じ行を2回読むことになる(呼び出し元の
  // findOwnedPullRequest が既に1回読んでいる)。該当行が無ければ null が返る
  // ので、それがそのまま「消せなかった」の判定になる。
  const row = db
    .query('DELETE FROM todo_pull_requests WHERE id = ? RETURNING todo_id')
    .get(id) as { todo_id: number } | null
  if (row === null) {
    return false
  }
  touchTodo(db, row.todo_id)
  return true
}

/**
 * 再取得すべき open PR (および state 不明の PR) を古い順に返す。閾値と件数は
 * ここでは決めない——呼び出し側(ルート)が定数として持ち、テストは固定値を
 * 渡せるようにする。
 *
 * state IS NULL も対象に含めるのは、gh が未導入/未認証のまま登録された PR は
 * state が永久に NULL のままになるため——後から gh を直しても、この条件が
 * 'open' だけだと二度と再取得の一覧に入らず回復しない。todoFilter.js の
 * isAwaitingReview() が state===NULL を「PRはあるが状態不明」として
 * pr-review バケットに数えるのと対になる扱い。
 *
 * fetched_at が NULL のものを先頭に置くのは、一度も取得できていない PR が
 * 最も情報が無いため。なお recordFetchError は fetched_at を更新しないので、
 * 一度でも成功して fetched_at が入った PR は、その後取得に失敗し続けても
 * 毎回この一覧に入り続ける(件数上限があるので gh を呼びすぎることはない)。
 */
export function listStaleOpen(db: Database, olderThan: string, limit: number): TodoPullRequest[] {
  const rows = db
    .query(
      `SELECT * FROM todo_pull_requests
       WHERE (state = 'open' OR state IS NULL) AND (fetched_at IS NULL OR fetched_at < ?)
       ORDER BY fetched_at IS NOT NULL, fetched_at ASC, id ASC
       LIMIT ?`
    )
    .all(olderThan, limit) as TodoPullRequestRow[]
  return rows.map(mapRow)
}
