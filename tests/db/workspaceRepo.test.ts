import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as workspaceRepo from '../../src/db/workspaceRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

// create/getById/remove happy paths, duplicate-name conflicts, ordering, and
// the "removing a workspace doesn't touch a todo's copied path" behavior are
// all exercised end-to-end via tests/api/workspacesRoutes.test.ts (which has
// its own copy of that last case verbatim); only the case below — partial
// update leaving the other field untouched — isn't already covered there.

describe('workspaceRepo.update', () => {
  test('partial update leaves the other field untouched', () => {
    const workspace = workspaceRepo.create(db, { name: 'keep', path: '/keep' })
    const updated = workspaceRepo.update(db, workspace.id, { name: 'renamed' })
    expect(updated?.name).toBe('renamed')
    expect(updated?.path).toBe('/keep')
  })
})
