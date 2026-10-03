import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as promptSnippetRepo from '../../src/db/promptSnippetRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

// create/getById/remove happy paths and 404s are exercised end-to-end via
// tests/api/promptsRoutes.test.ts; only the cases below add signal the route
// layer doesn't already cover — notably, the route's PATCH test only ever
// patches `title`, so it never exercises the `body` branch of update().

describe('promptSnippetRepo.listAll', () => {
  test('returns snippets ordered by creation', () => {
    promptSnippetRepo.create(db, { title: 'first', body: 'a' })
    promptSnippetRepo.create(db, { title: 'second', body: 'b' })
    const all = promptSnippetRepo.listAll(db)
    expect(all.length).toBe(2)
    expect(all[0]?.title).toBe('first')
    expect(all[1]?.title).toBe('second')
  })
})

describe('promptSnippetRepo.update', () => {
  test('updates title and body and sets updatedAt', () => {
    const snippet = promptSnippetRepo.create(db, { title: 'old', body: 'old body' })
    const updated = promptSnippetRepo.update(db, snippet.id, { title: 'new', body: 'new body' })
    expect(updated?.title).toBe('new')
    expect(updated?.body).toBe('new body')
    expect(updated?.updatedAt).not.toBeNull()
  })
})
