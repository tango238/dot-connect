import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../../src/db/database'

describe('createDatabase', () => {
  test('creates missing parent directories before opening the DB file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dot-connect-parent-dir-test-'))
    const nestedPath = join(dir, 'nested', 'deeper', 'test.db')
    expect(existsSync(join(dir, 'nested'))).toBe(false)

    const db = createDatabase(nestedPath)
    expect(existsSync(nestedPath)).toBe(true)
    db.close()

    rmSync(dir, { recursive: true, force: true })
  })

  test('creates all required tables', () => {
    const db = createDatabase(':memory:')
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('milestones')
    expect(names).toContain('todos')
    expect(names).toContain('weekly_reports')
    expect(names).toContain('dispatch_events')
    expect(names).toContain('prompt_snippets')
    expect(names).toContain('prompt_history')
    db.close()
  })

  test('todos has a completed_milestone_id column', () => {
    const db = createDatabase(':memory:')
    const columns = db.query('PRAGMA table_info(todos)').all() as { name: string }[]
    expect(columns.some((c) => c.name === 'completed_milestone_id')).toBe(true)
    db.close()
  })

  test('weekly_reports has an llm_error column', () => {
    const db = createDatabase(':memory:')
    const columns = db.query('PRAGMA table_info(weekly_reports)').all() as { name: string }[]
    expect(columns.some((c) => c.name === 'llm_error')).toBe(true)
    db.close()
  })

  test('todos.description defaults to an empty string', () => {
    const db = createDatabase(':memory:')
    db.run(`INSERT INTO todos (title) VALUES ('x')`)
    const row = db.query('SELECT description FROM todos').get() as { description: string }
    expect(row.description).toBe('')
    db.close()
  })

  test('todos.description rejects NULL', () => {
    const db = createDatabase(':memory:')
    expect(() => {
      db.run(`INSERT INTO todos (title, description) VALUES ('x', NULL)`)
    }).toThrow()
    db.close()
  })

  test('dispatch_events.todo_id is nullable and survives todo deletion (ON DELETE SET NULL)', () => {
    const db = createDatabase(':memory:')
    db.run(`INSERT INTO todos (title) VALUES ('x')`)
    const todoId = (db.query('SELECT id FROM todos').get() as { id: number }).id
    db.run(`INSERT INTO dispatch_events (todo_id) VALUES (?)`, [todoId])

    db.run(`DELETE FROM todos WHERE id = ?`, [todoId])
    const row = db.query('SELECT todo_id FROM dispatch_events').get() as { todo_id: number | null }
    expect(row.todo_id).toBeNull()
    db.close()
  })

  test('completed_milestone_id has no foreign key (survives milestone deletion)', () => {
    const db = createDatabase(':memory:')
    const fks = db.query('PRAGMA foreign_key_list(todos)').all() as { from: string }[]
    expect(fks.some((fk) => fk.from === 'completed_milestone_id')).toBe(false)
    db.close()
  })

  test('enforces todos.status CHECK constraint', () => {
    const db = createDatabase(':memory:')
    expect(() => {
      db.run(
        `INSERT INTO todos (title, status) VALUES ('x', 'bogus')`
      )
    }).toThrow()
    db.close()
  })

  test('enforces milestones.status CHECK constraint', () => {
    const db = createDatabase(':memory:')
    expect(() => {
      db.run(
        `INSERT INTO milestones (title, start_date, target_date, status) VALUES ('x', '2026-01-01', '2026-02-01', 'bogus')`
      )
    }).toThrow()
    db.close()
  })

  test('allows session_state to be NULL', () => {
    const db = createDatabase(':memory:')
    expect(() => {
      db.run(`INSERT INTO todos (title, session_state) VALUES ('x', NULL)`)
    }).not.toThrow()
    db.close()
  })
})
