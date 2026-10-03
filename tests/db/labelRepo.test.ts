import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as labelRepo from '../../src/db/labelRepo'
import * as milestoneRepo from '../../src/db/milestoneRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

// create/listAll defaults, duplicate-name conflict, and name ordering are
// exercised end-to-end via tests/api/labelsRoutes.test.ts; only the cases
// below add signal the route layer doesn't already cover.

describe('labelRepo.update', () => {
  test('updates provided fields only', () => {
    const label = labelRepo.create(db, { name: 'Backend', color: '#111111' })
    const updated = labelRepo.update(db, label.id, { name: 'Server' })
    expect(updated?.name).toBe('Server')
    expect(updated?.color).toBe('#111111')
    expect(updated?.updatedAt).not.toBeNull()
  })

  test('renaming a label to its own current name does not throw', () => {
    const label = labelRepo.create(db, { name: 'Backend' })
    expect(() => labelRepo.update(db, label.id, { name: 'Backend', color: '#222222' })).not.toThrow()
  })
})

describe('labelRepo.remove', () => {
  test('deletes the label and unlinks milestones, returning the unlinked count', () => {
    const label = labelRepo.create(db, { name: 'Backend' })
    milestoneRepo.create(db, {
      title: 'M1',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
      labelId: label.id,
    })
    milestoneRepo.create(db, {
      title: 'M2',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
      labelId: label.id,
    })
    milestoneRepo.create(db, {
      title: 'M3 unlabeled',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })

    const result = labelRepo.remove(db, label.id)
    expect(result.removed).toBe(true)
    expect(result.unlinkedMilestones).toBe(2)
    expect(labelRepo.getById(db, label.id)).toBeNull()

    const milestones = milestoneRepo.listAll(db)
    expect(milestones.every((m) => m.labelId === null)).toBe(true)
  })

  test('returns unlinkedMilestones=0 when no milestone used the label', () => {
    const label = labelRepo.create(db, { name: 'Unused' })
    const result = labelRepo.remove(db, label.id)
    expect(result.removed).toBe(true)
    expect(result.unlinkedMilestones).toBe(0)
  })
})
