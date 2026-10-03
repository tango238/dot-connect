import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as workspacePathHistoryRepo from '../../src/db/workspacePathHistoryRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

describe('workspacePathHistoryRepo', () => {
  test('lists nothing before anything has been dispatched', () => {
    expect(workspacePathHistoryRepo.listAll(db)).toEqual([])
  })

  test('lists most-recently-used first', () => {
    workspacePathHistoryRepo.recordUse(db, '/a')
    workspacePathHistoryRepo.recordUse(db, '/b')
    expect(workspacePathHistoryRepo.listAll(db).map((h) => h.path)).toEqual(['/b', '/a'])
  })

  // datetime('now') only has second resolution, so recency inside the same
  // second has to fall back to insertion order — which is exactly what the
  // dedup below relies on.
  test('re-using a path bumps it to the top instead of duplicating it', () => {
    workspacePathHistoryRepo.recordUse(db, '/a')
    workspacePathHistoryRepo.recordUse(db, '/b')
    workspacePathHistoryRepo.recordUse(db, '/a')
    expect(workspacePathHistoryRepo.listAll(db).map((h) => h.path)).toEqual(['/a', '/b'])
  })

  test('caps the stored history at 50 entries, evicting the oldest', () => {
    for (let i = 1; i <= 55; i++) {
      workspacePathHistoryRepo.recordUse(db, `/path/${i}`)
    }
    const stored = db.query('SELECT COUNT(*) AS count FROM workspace_path_history').get() as {
      count: number
    }
    expect(stored.count).toBe(50)
    const paths = workspacePathHistoryRepo.listAll(db).map((h) => h.path)
    expect(paths[0]).toBe('/path/55')
    expect(paths).not.toContain('/path/5')
  })

  test('removeAll reports how many entries it cleared', () => {
    workspacePathHistoryRepo.recordUse(db, '/a')
    workspacePathHistoryRepo.recordUse(db, '/b')
    expect(workspacePathHistoryRepo.removeAll(db)).toBe(2)
    expect(workspacePathHistoryRepo.listAll(db)).toEqual([])
  })

  // The two histories share an implementation (recencyHistory.ts) but must
  // stay separate tables — clearing one must not touch the other.
  test('is independent of the prompt history', async () => {
    const promptHistoryRepo = await import('../../src/db/promptHistoryRepo')
    promptHistoryRepo.recordUse(db, 'a prompt')
    workspacePathHistoryRepo.recordUse(db, '/a')
    workspacePathHistoryRepo.removeAll(db)
    expect(promptHistoryRepo.listAll(db).map((h) => h.body)).toEqual(['a prompt'])
  })
})
