import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { backfillHistoricalData, ensureColumn, rebuildLegacyTables } from './migrations'

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#8b96a5',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    color TEXT DEFAULT '#6ca4f8',
    start_date TEXT NOT NULL,
    target_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done')),
    done_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
    workspace_path TEXT,
    herdr_workspace_id TEXT,
    herdr_tab_id TEXT,
    herdr_pane_id TEXT,
    session_state TEXT CHECK(session_state IN ('working','blocked','done','idle') OR session_state IS NULL),
    dispatched_at TEXT,
    completed_at TEXT,
    -- Historical snapshot of milestone_id at completion time: deliberately
    -- no FK, so it survives the milestone later being deleted (see
    -- migrations.ts for the rebuild that fixes installs that had one).
    completed_milestone_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS weekly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL UNIQUE,
    week_end TEXT NOT NULL,
    completed_count INTEGER NOT NULL,
    milestone_linked_count INTEGER NOT NULL,
    unplanned_count INTEGER NOT NULL,
    dispatch_count INTEGER NOT NULL DEFAULT 0,
    llm_analysis TEXT,
    llm_error TEXT,
    generated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS dispatch_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Nullable + ON DELETE SET NULL: an append-only dispatch log that must
    -- survive the todo itself being deleted later.
    todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
    dispatched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS prompt_snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS prompt_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    used_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Registered working directories offered as input assistance when setting
  // a TODO's workspace_path. Deliberately NOT referenced by any FK from
  // todos — workspace_path stays a plain string copy (see workspaceRepo.ts).
  `CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  )`,
  // Recently-used workspace paths, recorded on successful dispatch only (so
  // a path that was merely typed into a form and never actually run in
  // never pollutes the list). Same shape and semantics as prompt_history —
  // both are driven by the shared helper in recencyHistory.ts.
  `CREATE TABLE IF NOT EXISTS workspace_path_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    used_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // GitHub Pull Requests linked to a TODO.
  //
  // ON DELETE CASCADE (unlike dispatch_events, which deliberately survives
  // its todo): a PR link is descriptive metadata belonging to the todo, not
  // an audit record, so it has no meaning once the todo is gone.
  //
  // UNIQUE(todo_id, url) works only because url is stored canonicalized —
  // see pullRequestUrl.ts. state/title/is_draft are a nullable snapshot: a
  // URL registers successfully even when `gh` can't be reached, in which
  // case fetch_error holds why (same "keep the record, note the failure"
  // approach as weekly_reports.llm_error).
  `CREATE TABLE IF NOT EXISTS todo_pull_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT,
    state TEXT CHECK(state IN ('open','closed','merged') OR state IS NULL),
    is_draft INTEGER,
    fetched_at TEXT,
    fetch_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(todo_id, url)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_todo_pull_requests_todo_id ON todo_pull_requests(todo_id)`,
  // Files attached to a TODO. Same CASCADE reasoning as todo_pull_requests:
  // an attachment belongs to its todo and has no meaning once it is gone.
  //
  // stored_name と original_name を分けているのは、保存先フォルダの中では名前
  // が必ず一意でなければならない(同じ `report.pdf` を複数のTODOに付けられる)
  // 一方で、画面に出す名前は人が付けた元の名前でなければ意味が無いため。
  // stored_name は attachmentStorage.ts が UUID から作る。
  //
  // 絶対パスは保存しない: `<uploadDir>/<stored_name>` として読み出し時に組み
  // 立てる(todoAttachmentRepo.ts)。保存先フォルダを設定で変えたときに、行に
  // 焼かれた古いパスが取り残されないようにするため。
  `CREATE TABLE IF NOT EXISTS todo_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    stored_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_todo_attachments_todo_id ON todo_attachments(todo_id)`,
  // 作業ログ: TODOに人が書き足すコメント。追記専用(編集なし・削除あり)で、
  // 古い順に読む。CASCADE の理由は todo_pull_requests と同じ —— TODOが消え
  // れば、そのTODOの作業ログにも意味は無い。
  `CREATE TABLE IF NOT EXISTS todo_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_todo_comments_todo_id ON todo_comments(todo_id)`,
  // Generic key/value settings store, so later settings can land here too
  // without a new table each time — the meaning of each value belongs to
  // the service reading it (e.g. uploadDirService.ts), not to this table.
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
]

const ADDITIVE_COLUMNS: readonly { table: string; column: string; definition: string }[] = [
  { table: 'todos', column: 'completed_milestone_id', definition: 'INTEGER' },
  { table: 'weekly_reports', column: 'llm_error', definition: 'TEXT' },
  { table: 'todos', column: 'description', definition: "TEXT NOT NULL DEFAULT ''" },
  {
    table: 'milestones',
    column: 'label_id',
    definition: 'INTEGER REFERENCES labels(id) ON DELETE SET NULL',
  },
  {
    table: 'todos',
    column: 'priority',
    definition: "TEXT NOT NULL DEFAULT 'none' CHECK(priority IN ('none','low','high'))",
  },
  // NULL means "use claude's own default model" (no --model flag on
  // dispatch) — see modelValidation.ts for the allowlist checked before this
  // value is ever used to build a command.
  { table: 'todos', column: 'model', definition: 'TEXT' },
  // 日付のみ(YYYY-MM-DD)。NULL は「期限なし」。時刻もタイムゾーンも持た
  // ないので、比較はローカル日付との文字列比較で行う(todayIso 参照)。
  { table: 'todos', column: 'due_date', definition: 'TEXT' },
  // 最終更新時刻。labels/workspaces/prompt_snippets と同じ「作成直後は NULL、
  // 初回更新で初めて値が入る」規約で、読む側は updated_at ?? created_at を
  // 最終更新として扱う(todoTouch.ts と lastActivityAt を参照)。
  //
  // NOT NULL DEFAULT (datetime('now')) にできないのは SQLite の制約:
  // ALTER TABLE ADD COLUMN の DEFAULT は定数でなければならず、既存DBへ後から
  // 足せなくなる。バックフィルするより NULL のままにして読み出し側で
  // created_at に落とす方が、「一度も触っていない」を正直に残せる。
  { table: 'todos', column: 'updated_at', definition: 'TEXT' },
]

// bun:sqlite's { create: true } creates the DB *file* but not missing parent
// directories, so a fresh checkout without data/ yet would fail to start.
function ensureParentDirectory(path: string): void {
  if (path === ':memory:') {
    return
  }
  mkdirSync(dirname(path), { recursive: true })
}

export function createDatabase(path: string): Database {
  ensureParentDirectory(path)
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  for (const migration of MIGRATIONS) {
    db.exec(migration)
  }
  for (const { table, column, definition } of ADDITIVE_COLUMNS) {
    ensureColumn(db, table, column, definition)
  }
  rebuildLegacyTables(db)
  backfillHistoricalData(db)
  return db
}
