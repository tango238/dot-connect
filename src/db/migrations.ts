import type { Database } from 'bun:sqlite'

interface ForeignKeyRow {
  table: string
  from: string
  to: string
  on_delete: string
}

interface ColumnRow {
  name: string
  notnull: number
}

function foreignKeysOf(db: Database, table: string): ForeignKeyRow[] {
  return db.query(`PRAGMA foreign_key_list(${table})`).all() as ForeignKeyRow[]
}

function columnsOf(db: Database, table: string): ColumnRow[] {
  return db.query(`PRAGMA table_info(${table})`).all() as ColumnRow[]
}

// Additive columns for installs created before they existed. CREATE TABLE IF
// NOT EXISTS alone only helps fresh databases; existing ones need an ALTER
// TABLE, which SQLite has no "IF NOT EXISTS" form for.
export function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  if (!columnsOf(db, table).some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

// completed_milestone_id is a historical snapshot: it must survive the
// referenced milestone being deleted, so it must NOT carry a foreign key. An
// earlier version of this schema mistakenly gave it one (with ON DELETE SET
// NULL), which silently erased the history it was meant to preserve. SQLite
// can't drop a column-level FK via ALTER TABLE, so a table found with that FK
// is rebuilt in place: new table, copy rows, drop the old one.
function todosNeedsRebuild(db: Database): boolean {
  return foreignKeysOf(db, 'todos').some((fk) => fk.from === 'completed_milestone_id')
}

function rebuildTodosTable(db: Database): void {
  // PRAGMA foreign_keys has no effect while a transaction is open, so it must
  // be toggled outside the transaction; the RENAME/CREATE/COPY/DROP sequence
  // itself runs atomically so a crash mid-rebuild can't leave both an old and
  // a new table (or neither) behind.
  db.exec('PRAGMA foreign_keys = OFF')
  const rebuild = db.transaction(() => {
    db.exec('ALTER TABLE todos RENAME TO todos_old')
    db.exec(`CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
      priority TEXT NOT NULL DEFAULT 'none' CHECK(priority IN ('none','low','high')),
      workspace_path TEXT,
      herdr_workspace_id TEXT,
      herdr_tab_id TEXT,
      herdr_pane_id TEXT,
      session_state TEXT CHECK(session_state IN ('working','blocked','done','idle') OR session_state IS NULL),
      dispatched_at TEXT,
      completed_at TEXT,
      completed_milestone_id INTEGER,
      model TEXT,
      due_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      grill_dir TEXT
    )`)
    // todos_old already has description, priority, model, AND grill_dir at this point:
    // ensureColumn() for the additive columns always runs before
    // rebuildLegacyTables() in createDatabase(), regardless of which table
    // needed the rebuild. Both CREATE and INSERT column lists here must
    // carry every additive column through explicitly — a column present on
    // todos_old but missing from either list here is silently dropped by
    // the rebuild (this exact mistake happened with `description` before;
    // see tests/db/migrations.test.ts for the regression coverage).
    db.exec(`INSERT INTO todos (
      id, title, description, milestone_id, status, priority, workspace_path,
      herdr_workspace_id, herdr_tab_id, herdr_pane_id,
      session_state, dispatched_at, completed_at, completed_milestone_id, model, due_date, created_at, updated_at, grill_dir
    ) SELECT
      id, title, description, milestone_id, status, priority, workspace_path,
      herdr_workspace_id, herdr_tab_id, herdr_pane_id,
      session_state, dispatched_at, completed_at, completed_milestone_id, model, due_date, created_at, updated_at, grill_dir
    FROM todos_old`)
    db.exec('DROP TABLE todos_old')
  })
  rebuild()
  db.exec('PRAGMA foreign_keys = ON')
}

// dispatch_events is an append-only log: it must also survive todo deletion
// (a todo being deleted shouldn't erase the fact that it was once
// dispatched), so todo_id must be nullable with ON DELETE SET NULL rather
// than NOT NULL + ON DELETE CASCADE.
function dispatchEventsNeedsRebuild(db: Database): boolean {
  const todoIdColumn = columnsOf(db, 'dispatch_events').find((c) => c.name === 'todo_id')
  if (todoIdColumn?.notnull === 1) {
    return true
  }
  const fk = foreignKeysOf(db, 'dispatch_events').find((f) => f.from === 'todo_id')
  return fk !== undefined && fk.on_delete !== 'SET NULL'
}

function rebuildDispatchEventsTable(db: Database): void {
  db.exec('PRAGMA foreign_keys = OFF')
  const rebuild = db.transaction(() => {
    db.exec('ALTER TABLE dispatch_events RENAME TO dispatch_events_old')
    db.exec(`CREATE TABLE dispatch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER REFERENCES todos(id) ON DELETE SET NULL,
      dispatched_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    db.exec(
      `INSERT INTO dispatch_events (id, todo_id, dispatched_at)
       SELECT id, todo_id, dispatched_at FROM dispatch_events_old`
    )
    db.exec('DROP TABLE dispatch_events_old')
  })
  rebuild()
  db.exec('PRAGMA foreign_keys = ON')
}

// Rebuilds any table found in an older, incompatible shape. Safe to call on
// every startup: a no-op once the schema is already up to date.
export function rebuildLegacyTables(db: Database): void {
  if (todosNeedsRebuild(db)) {
    rebuildTodosTable(db)
  }
  if (dispatchEventsNeedsRebuild(db)) {
    rebuildDispatchEventsTable(db)
  }
}

// Idempotent, safe to run on every startup: fills in data that pre-dates a
// column/table. completed_milestone_id didn't exist (or wasn't backfilled)
// for todos that were already completed before it was introduced;
// dispatch_events didn't exist before dispatch tracking was added, so older
// installs only have todos.dispatched_at to reconstruct from.
export function backfillHistoricalData(db: Database): void {
  db.exec(`
    UPDATE todos SET completed_milestone_id = milestone_id
    WHERE status = 'done' AND completed_at IS NOT NULL AND completed_milestone_id IS NULL
  `)

  const dispatchEventsCount = db.query('SELECT COUNT(*) AS count FROM dispatch_events').get() as {
    count: number
  }
  if (dispatchEventsCount.count === 0) {
    db.exec(`
      INSERT INTO dispatch_events (todo_id, dispatched_at)
      SELECT id, dispatched_at FROM todos WHERE dispatched_at IS NOT NULL
    `)
  }
}
