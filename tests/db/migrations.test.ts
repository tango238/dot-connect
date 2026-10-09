import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../../src/db/database'
import * as labelRepo from '../../src/db/labelRepo'
import * as milestoneRepo from '../../src/db/milestoneRepo'
import * as todoPullRequestRepo from '../../src/db/todoPullRequestRepo'
import * as todoRepo from '../../src/db/todoRepo'
import * as workspacePathHistoryRepo from '../../src/db/workspacePathHistoryRepo'
import * as workspaceRepo from '../../src/db/workspaceRepo'
import * as dispatchEventRepo from '../../src/db/dispatchEventRepo'
import * as reportService from '../../src/services/reportService'

// These migration/rebuild paths only matter for a database file that already
// exists on disk in an older shape — :memory: databases are always created
// fresh, so a real temp file is required to exercise them.
let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dot-connect-migration-test-'))
  dbPath = join(dir, 'test.db')
})

afterEach(() => {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createLegacySchema(): void {
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`CREATE TABLE milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    color TEXT DEFAULT '#6ca4f8',
    start_date TEXT NOT NULL,
    target_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done')),
    done_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE TABLE todos (
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
    completed_milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE TABLE weekly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL UNIQUE,
    week_end TEXT NOT NULL,
    completed_count INTEGER NOT NULL,
    milestone_linked_count INTEGER NOT NULL,
    unplanned_count INTEGER NOT NULL,
    dispatch_count INTEGER NOT NULL DEFAULT 0,
    llm_analysis TEXT,
    generated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE TABLE dispatch_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    dispatched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  db.close()
}

describe('legacy schema rebuild', () => {
  test('drops the FK on completed_milestone_id, preserving data and history through milestone deletion', () => {
    createLegacySchema()

    const seed = new Database(dbPath)
    seed.exec('PRAGMA foreign_keys = ON')
    seed.run(
      `INSERT INTO milestones (title, start_date, target_date) VALUES ('M', '2026-01-01', '2026-02-01')`
    )
    const milestoneId = (seed.query('SELECT id FROM milestones').get() as { id: number }).id
    seed.run(
      `INSERT INTO todos (title, milestone_id, status, completed_at, completed_milestone_id) VALUES ('t1', ?, 'done', datetime('now'), ?)`,
      [milestoneId, milestoneId]
    )
    seed.close()

    // Re-opening through createDatabase() must detect and fix the legacy FK.
    const db = createDatabase(dbPath)
    const fks = db.query('PRAGMA foreign_key_list(todos)').all() as { from: string }[]
    expect(fks.some((fk) => fk.from === 'completed_milestone_id')).toBe(false)

    const todoBefore = todoRepo.listAll(db)[0]
    expect(todoBefore?.completedMilestoneId).toBe(milestoneId)

    milestoneRepo.remove(db, milestoneId)

    const todoAfter = todoRepo.listAll(db)[0]
    expect(todoAfter?.milestoneId).toBeNull() // still FK'd, still cleared
    expect(todoAfter?.completedMilestoneId).toBe(milestoneId) // history preserved
    db.close()
  })

  // todo_pull_requests is created by MIGRATIONS *before* rebuildLegacyTables
  // runs, so on a legacy database its FK is already pointing at a `todos`
  // table that the rebuild then renames away and recreates. SQLite rewrites
  // other tables' REFERENCES clauses during a RENAME only when foreign keys
  // are enabled — the rebuild deliberately turns them off, which is what
  // keeps the clause pointing at `todos`. This asserts that outcome directly
  // rather than trusting that detail of SQLite's behavior.
  test('rebuild leaves todo_pull_requests referencing todos, with CASCADE intact', () => {
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.run(`INSERT INTO todos (title) VALUES ('t1')`)
    seed.close()

    const db = createDatabase(dbPath)
    const fk = (db.query('PRAGMA foreign_key_list(todo_pull_requests)').all() as {
      table: string
      from: string
      on_delete: string
    }[]).find((f) => f.from === 'todo_id')
    expect(fk?.table).toBe('todos')
    expect(fk?.on_delete).toBe('CASCADE')

    const todoId = todoRepo.listAll(db)[0]!.id
    todoPullRequestRepo.create(db, {
      todoId,
      url: 'https://github.com/o/r/pull/1',
      owner: 'o',
      repo: 'r',
      number: 1,
    })
    todoRepo.remove(db, todoId)
    expect(db.query('SELECT COUNT(*) AS c FROM todo_pull_requests').get()).toEqual({ c: 0 })
    db.close()
  })

  test('adds the workspace_path_history table on a legacy database that pre-dates it', () => {
    createLegacySchema()
    const db = createDatabase(dbPath)
    workspacePathHistoryRepo.recordUse(db, '/tmp/proj')
    expect(workspacePathHistoryRepo.listAll(db).map((h) => h.path)).toEqual(['/tmp/proj'])
    db.close()
  })

  test('rebuild preserves an in-progress (non-done) todo untouched', () => {
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.run(`INSERT INTO todos (title, workspace_path) VALUES ('open todo', '/tmp/x')`)
    seed.close()

    const db = createDatabase(dbPath)
    const todo = todoRepo.listAll(db)[0]
    expect(todo?.title).toBe('open todo')
    expect(todo?.workspacePath).toBe('/tmp/x')
    expect(todo?.status).toBe('open')
    db.close()
  })

  test('rebuild does not drop the description column added by ensureColumn just before it', () => {
    // createLegacySchema()'s todos table pre-dates `description` entirely.
    // ensureColumn() adds it (defaulting existing rows to '') before the FK
    // rebuild runs — the rebuild's own CREATE/INSERT column lists must carry
    // it through, not silently drop it.
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.exec('PRAGMA foreign_keys = ON')
    seed.run(
      `INSERT INTO milestones (title, start_date, target_date) VALUES ('M', '2026-01-01', '2026-02-01')`
    )
    const milestoneId = (seed.query('SELECT id FROM milestones').get() as { id: number }).id
    seed.run(
      `INSERT INTO todos (title, milestone_id, status, completed_at, completed_milestone_id) VALUES ('t1', ?, 'done', datetime('now'), ?)`,
      [milestoneId, milestoneId]
    )
    seed.close()

    const db = createDatabase(dbPath)
    const todo = todoRepo.listAll(db)[0]
    expect(todo?.description).toBe('')

    const updated = todoRepo.update(db, todo!.id, { description: 'added after rebuild' })
    expect(updated?.description).toBe('added after rebuild')
    db.close()
  })

  test('rebuild does not drop the priority column added by ensureColumn just before it', () => {
    // Same trap as description before it: createLegacySchema()'s todos table
    // pre-dates `priority` entirely. ensureColumn() adds it (defaulting
    // existing rows to 'none') before the FK rebuild runs — the rebuild's
    // own CREATE/INSERT column lists must carry it through, not silently
    // drop it.
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.exec('PRAGMA foreign_keys = ON')
    seed.run(
      `INSERT INTO milestones (title, start_date, target_date) VALUES ('M', '2026-01-01', '2026-02-01')`
    )
    const milestoneId = (seed.query('SELECT id FROM milestones').get() as { id: number }).id
    seed.run(
      `INSERT INTO todos (title, milestone_id, status, completed_at, completed_milestone_id) VALUES ('t1', ?, 'done', datetime('now'), ?)`,
      [milestoneId, milestoneId]
    )
    seed.close()

    const db = createDatabase(dbPath)
    const todo = todoRepo.listAll(db)[0]
    // Preexisting rows default to 'none', and other fields survive the
    // rebuild alongside it (this is the same rebuild call as the FK-drop
    // test above, exercised here specifically for the priority column).
    expect(todo?.priority).toBe('none')
    expect(todo?.title).toBe('t1')
    expect(todo?.milestoneId).toBe(milestoneId)
    expect(todo?.completedMilestoneId).toBe(milestoneId)

    const updated = todoRepo.update(db, todo!.id, { priority: 'high' })
    expect(updated?.priority).toBe('high')
    db.close()
  })

  test('rebuild does not drop the model column added by ensureColumn just before it', () => {
    // Same trap as description/priority before it: createLegacySchema()'s
    // todos table pre-dates `model` entirely. ensureColumn() adds it
    // (defaulting existing rows to NULL) before the FK rebuild runs — the
    // rebuild's own CREATE/INSERT column lists must carry it through, not
    // silently drop it.
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.exec('PRAGMA foreign_keys = ON')
    seed.run(
      `INSERT INTO milestones (title, start_date, target_date) VALUES ('M', '2026-01-01', '2026-02-01')`
    )
    const milestoneId = (seed.query('SELECT id FROM milestones').get() as { id: number }).id
    seed.run(
      `INSERT INTO todos (title, milestone_id, status, completed_at, completed_milestone_id) VALUES ('t1', ?, 'done', datetime('now'), ?)`,
      [milestoneId, milestoneId]
    )
    seed.close()

    const db = createDatabase(dbPath)
    const todo = todoRepo.listAll(db)[0]
    expect(todo?.model).toBeNull()

    const updated = todoRepo.update(db, todo!.id, { model: 'opus' })
    expect(updated?.model).toBe('opus')
    db.close()
  })

  test('rebuild does not drop the due_date column added by ensureColumn just before it', () => {
    // Same trap as description/priority/model before it: createLegacySchema()'s
    // todos table pre-dates `due_date` entirely. ensureColumn() adds it
    // (defaulting existing rows to NULL) before the FK rebuild runs — the
    // rebuild's own CREATE/INSERT/SELECT column lists must carry it through,
    // not silently drop it. due_date isn't mapped by todoRepo yet (a later
    // task), so this reads it back with a raw query instead.
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.exec('PRAGMA foreign_keys = ON')
    seed.run(
      `INSERT INTO milestones (title, start_date, target_date) VALUES ('M', '2026-01-01', '2026-02-01')`
    )
    const milestoneId = (seed.query('SELECT id FROM milestones').get() as { id: number }).id
    seed.run(
      `INSERT INTO todos (title, milestone_id, status, completed_at, completed_milestone_id) VALUES ('t1', ?, 'done', datetime('now'), ?)`,
      [milestoneId, milestoneId]
    )
    seed.close()

    const db = createDatabase(dbPath)
    const todoId = (db.query('SELECT id FROM todos').get() as { id: number }).id
    expect(
      (db.query('SELECT due_date FROM todos WHERE id = ?').get(todoId) as { due_date: string | null })
        .due_date
    ).toBeNull()

    db.run('UPDATE todos SET due_date = ? WHERE id = ?', ['2026-09-01', todoId])
    expect(
      (db.query('SELECT due_date FROM todos WHERE id = ?').get(todoId) as { due_date: string | null })
        .due_date
    ).toBe('2026-09-01')
    db.close()
  })

  test('rebuild does not drop the updated_at column added by ensureColumn just before it', () => {
    // Same trap as description/priority/model/due_date before it:
    // createLegacySchema()'s todos table pre-dates `updated_at` entirely.
    // ensureColumn() adds it (defaulting existing rows to NULL) before the FK
    // rebuild runs — the rebuild's own CREATE/INSERT/SELECT column lists must
    // carry it through, not silently drop it. An existing row keeps NULL:
    // "never touched since this upgrade" is the honest answer, and readers
    // fall back to created_at for it (see lastActivityAt in todoOrder.js).
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.exec('PRAGMA foreign_keys = ON')
    seed.run(
      `INSERT INTO milestones (title, start_date, target_date) VALUES ('M', '2026-01-01', '2026-02-01')`
    )
    const milestoneId = (seed.query('SELECT id FROM milestones').get() as { id: number }).id
    seed.run(
      `INSERT INTO todos (title, milestone_id, status, completed_at, completed_milestone_id) VALUES ('t1', ?, 'done', datetime('now'), ?)`,
      [milestoneId, milestoneId]
    )
    seed.close()

    const db = createDatabase(dbPath)
    const todoId = (db.query('SELECT id FROM todos').get() as { id: number }).id
    expect(todoRepo.getById(db, todoId)?.updatedAt).toBeNull()

    // ...and a write after the upgrade stamps it, proving the column really
    // survived the rebuild rather than merely existing on paper.
    expect(todoRepo.update(db, todoId, { title: 't1 renamed' })?.updatedAt).not.toBeNull()
    db.close()
  })

  test('rebuild does not drop the grill_dir column added by ensureColumn just before it', () => {
    // Same trap again: grill_dir is added by ensureColumn() before the FK
    // rebuild, so the rebuild's column lists must carry it through.
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.run(`ALTER TABLE todos ADD COLUMN grill_dir TEXT`)
    seed.run(`INSERT INTO todos (title, grill_dir) VALUES ('t1', '/data/grill/todo-1')`)
    seed.close()

    const db = createDatabase(dbPath)
    const todoId = (db.query('SELECT id FROM todos').get() as { id: number }).id
    expect(todoRepo.getById(db, todoId)?.grillDir).toBe('/data/grill/todo-1')
    todoRepo.setGrillDir(db, todoId, null)
    expect(todoRepo.getById(db, todoId)?.grillDir).toBeNull()
    db.close()
  })

  test('adds the labels table and milestones.label_id, preserving existing milestones with label_id NULL', () => {
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.run(
      `INSERT INTO milestones (title, start_date, target_date) VALUES ('Pre-label milestone', '2026-01-01', '2026-02-01')`
    )
    seed.close()

    const db = createDatabase(dbPath)

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]
    expect(tables.some((t) => t.name === 'labels')).toBe(true)

    const milestone = milestoneRepo.listAll(db)[0]
    expect(milestone?.title).toBe('Pre-label milestone')
    expect(milestone?.labelId).toBeNull()
    expect(milestone?.labelName).toBeNull()

    // The additive column must also be usable going forward, not just present.
    const label = labelRepo.create(db, { name: 'Backend' })
    const updated = milestoneRepo.update(db, milestone!.id, { labelId: label.id })
    expect(updated?.labelId).toBe(label.id)
    db.close()
  })

  test('adds the workspaces table on a legacy database that pre-dates it', () => {
    createLegacySchema()
    const db = createDatabase(dbPath)

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]
    expect(tables.some((t) => t.name === 'workspaces')).toBe(true)

    const workspace = workspaceRepo.create(db, { name: 'my-app', path: '/tmp/my-app' })
    expect(workspaceRepo.getById(db, workspace.id)?.path).toBe('/tmp/my-app')
    db.close()
  })

  test('converts dispatch_events.todo_id from NOT NULL+CASCADE to nullable+SET NULL, preserving history', () => {
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.exec('PRAGMA foreign_keys = ON')
    seed.run(`INSERT INTO todos (title) VALUES ('x')`)
    const todoId = (seed.query('SELECT id FROM todos').get() as { id: number }).id
    seed.run(`INSERT INTO dispatch_events (todo_id, dispatched_at) VALUES (?, '2026-07-21 10:00:00')`, [
      todoId,
    ])
    seed.close()

    const db = createDatabase(dbPath)
    const column = (db.query('PRAGMA table_info(dispatch_events)').all() as {
      name: string
      notnull: number
    }[]).find((c) => c.name === 'todo_id')
    expect(column?.notnull).toBe(0)

    todoRepo.remove(db, todoId)

    const row = db.query('SELECT todo_id, dispatched_at FROM dispatch_events').get() as {
      todo_id: number | null
      dispatched_at: string
    }
    expect(row.todo_id).toBeNull()
    expect(row.dispatched_at).toBe('2026-07-21 10:00:00')
    expect(dispatchEventRepo.countInRange(db, '2026-07-20', '2026-07-26')).toBe(1)
    db.close()
  })
})

describe('backfill', () => {
  test('backfills completed_milestone_id for todos completed before the column existed', () => {
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.run(
      `INSERT INTO milestones (title, start_date, target_date) VALUES ('M', '2026-01-01', '2026-02-01')`
    )
    const milestoneId = (seed.query('SELECT id FROM milestones').get() as { id: number }).id
    // Simulates a todo completed before completed_milestone_id was backfilled: the
    // FK-era column exists but was left NULL.
    seed.run(
      `INSERT INTO todos (title, milestone_id, status, completed_at) VALUES ('t1', ?, 'done', '2026-07-21 12:00:00')`,
      [milestoneId]
    )
    seed.close()

    const db = createDatabase(dbPath)
    const todo = todoRepo.listAll(db)[0]
    expect(todo?.completedMilestoneId).toBe(milestoneId)
    db.close()
  })

  test('does not overwrite an already-set completed_milestone_id', () => {
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.run(
      `INSERT INTO milestones (title, start_date, target_date) VALUES ('M1', '2026-01-01', '2026-02-01')`
    )
    seed.run(
      `INSERT INTO milestones (title, start_date, target_date) VALUES ('M2', '2026-01-01', '2026-02-01')`
    )
    const [m1, m2] = seed.query('SELECT id FROM milestones ORDER BY id').all() as { id: number }[]
    seed.run(
      `INSERT INTO todos (title, milestone_id, status, completed_at, completed_milestone_id) VALUES ('t1', ?, 'done', '2026-07-21 12:00:00', ?)`,
      [m2!.id, m1!.id]
    )
    seed.close()

    const db = createDatabase(dbPath)
    const todo = todoRepo.listAll(db)[0]
    expect(todo?.completedMilestoneId).toBe(m1!.id)
    db.close()
  })

  test('backfills dispatch_events from todos.dispatched_at when the table is empty, and weekly aggregation reflects it', () => {
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.run(
      `INSERT INTO todos (title, dispatched_at, herdr_workspace_id, herdr_tab_id, herdr_pane_id, session_state)
       VALUES ('t1', '2026-07-21 10:00:00', 'w1', 't1', 'p1', 'working')`
    )
    seed.run(`INSERT INTO todos (title) VALUES ('never dispatched')`)
    seed.close()

    const db = createDatabase(dbPath)
    expect(dispatchEventRepo.countInRange(db, '2026-07-20', '2026-07-26')).toBe(1)

    const counts = reportService.aggregateWeek(db, '2026-07-20', '2026-07-26')
    expect(counts.dispatchCount).toBe(1)
    db.close()
  })

  test('does not duplicate dispatch_events on a second createDatabase call', () => {
    createLegacySchema()
    const seed = new Database(dbPath)
    seed.run(`INSERT INTO todos (title, dispatched_at) VALUES ('t1', '2026-07-21 10:00:00')`)
    seed.close()

    const db1 = createDatabase(dbPath)
    db1.close()
    const db2 = createDatabase(dbPath)
    expect(dispatchEventRepo.countInRange(db2, '2026-07-20', '2026-07-26')).toBe(1)
    db2.close()
  })
})

describe('rebuild atomicity (interruption simulation)', () => {
  // rebuildTodosTable/rebuildDispatchEventsTable follow the same
  // RENAME -> CREATE -> COPY -> DROP shape, wrapped in db.transaction() so a
  // failure partway through can't leave the database with both an old and a
  // new table (or neither). This exercises that same shape directly against
  // a real database to confirm bun:sqlite actually rolls it all back.
  test('a failure partway through a RENAME/CREATE/COPY/DROP transaction leaves the original table intact', () => {
    const db = createDatabase(':memory:')
    todoRepo.create(db, { title: 'untouched' })

    const attemptRebuild = db.transaction(() => {
      db.exec('ALTER TABLE todos RENAME TO todos_old')
      db.exec('CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
      // Simulate a failure partway through the copy step (e.g. a bad column).
      db.exec('INSERT INTO todos (id, title) SELECT id, nonexistent_column FROM todos_old')
      db.exec('DROP TABLE todos_old')
    })

    expect(() => attemptRebuild()).toThrow()

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]
    expect(tables.some((t) => t.name === 'todos')).toBe(true)
    expect(tables.some((t) => t.name === 'todos_old')).toBe(false)
    expect(todoRepo.listAll(db)).toHaveLength(1)
    expect(todoRepo.listAll(db)[0]?.title).toBe('untouched')
    db.close()
  })
})
