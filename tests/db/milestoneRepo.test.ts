import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as labelRepo from '../../src/db/labelRepo'
import * as milestoneRepo from '../../src/db/milestoneRepo'
import * as todoRepo from '../../src/db/todoRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

function makeMilestone(overrides: Partial<Parameters<typeof milestoneRepo.create>[1]> = {}) {
  return milestoneRepo.create(db, {
    title: 'M',
    description: '',
    color: '#6ca4f8',
    startDate: '2026-01-01',
    targetDate: '2026-02-01',
    ...overrides,
  })
}

// Progress-count aggregation, label-join on create/getById/listAll, and
// simple 404s are exercised end-to-end via tests/api/milestonesRoutes.test.ts;
// only the cases below add signal the route layer doesn't already cover.

describe('milestoneRepo.create', () => {
  test('creates with defaults for description/color', () => {
    const m = milestoneRepo.create(db, {
      title: 'X',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    expect(m.description).toBe('')
    expect(m.color).toBe('#6ca4f8')
    expect(m.status).toBe('active')
  })
})

describe('milestoneRepo.update', () => {
  test('updates provided fields only', () => {
    const m = makeMilestone()
    const updated = milestoneRepo.update(db, m.id, { title: 'renamed' })
    expect(updated?.title).toBe('renamed')
    expect(updated?.color).toBe(m.color)
  })

  test('omitting labelId leaves the existing label untouched', () => {
    const label = labelRepo.create(db, { name: 'Ops' })
    const m = makeMilestone({ labelId: label.id })
    const updated = milestoneRepo.update(db, m.id, { title: 'renamed only' })
    expect(updated?.labelId).toBe(label.id)
    expect(updated?.title).toBe('renamed only')
  })

  // The route handler pre-checks existence via getById() and 404s before
  // ever calling update(), so update()'s own null-return guard is otherwise
  // unreachable from the route layer.
  test('returns null for missing milestone', () => {
    expect(milestoneRepo.update(db, 404, { title: 'x' })).toBeNull()
  })
})

describe('milestoneRepo.countOpenTodos', () => {
  test('counts only non-done todos linked to the milestone', () => {
    const m = makeMilestone()
    todoRepo.create(db, { title: 'open1', milestoneId: m.id })
    const t2 = todoRepo.create(db, { title: 'done1', milestoneId: m.id })
    todoRepo.complete(db, t2.id)
    expect(milestoneRepo.countOpenTodos(db, m.id)).toBe(1)
  })
})

describe('milestoneRepo.complete / reopen', () => {
  test('complete sets status done and doneAt', () => {
    const m = makeMilestone()
    const completed = milestoneRepo.complete(db, m.id)
    expect(completed?.status).toBe('done')
    expect(completed?.doneAt).not.toBeNull()
  })

  test('reopen clears doneAt and sets status active', () => {
    const m = makeMilestone()
    milestoneRepo.complete(db, m.id)
    const reopened = milestoneRepo.reopen(db, m.id)
    expect(reopened?.status).toBe('active')
    expect(reopened?.doneAt).toBeNull()
  })
})

// マイルストーンを消すと、紐付いていたTODOは FK の ON DELETE SET NULL で
// milestone_id が NULL になる —— 画面のマイルストーンチップが消える、目に
// 見える編集なので「最終更新」に数える。カスケードはSQLite側で起きるため
// 何もしないと updated_at だけ取り残される。
describe('milestoneRepo.remove と紐付いていたTODOの updated_at', () => {
  test('紐付け解除されたTODOの updated_at が入る', () => {
    const milestone = makeMilestone()
    const linked = todoRepo.create(db, { title: 'linked', milestoneId: milestone.id })
    const unrelated = todoRepo.create(db, { title: 'unrelated' })
    expect(linked.updatedAt).toBeNull()

    const result = milestoneRepo.remove(db, milestone.id)
    expect(result).toEqual({ removed: true, unlinkedCount: 1 })

    const after = todoRepo.getById(db, linked.id)
    expect(after?.milestoneId).toBeNull()
    expect(after?.updatedAt).not.toBeNull()
    // 巻き添えで無関係なTODOまで更新しない
    expect(todoRepo.getById(db, unrelated.id)?.updatedAt).toBeNull()
  })

  test('完了時に紐付いていたTODOも紐付け解除されれば数える', () => {
    // completed_milestone_id は FK を持たない歴史スナップショットなので
    // カスケードされない。動くのは milestone_id だけ。
    const milestone = makeMilestone()
    const todo = todoRepo.create(db, { title: 'done one', milestoneId: milestone.id })
    todoRepo.complete(db, todo.id)
    db.run('UPDATE todos SET updated_at = NULL WHERE id = ?', [todo.id])

    milestoneRepo.remove(db, milestone.id)

    const after = todoRepo.getById(db, todo.id)
    expect(after?.completedMilestoneId).toBe(milestone.id)
    expect(after?.updatedAt).not.toBeNull()
  })

  test('存在しないマイルストーンの削除では何も更新しない', () => {
    const todo = todoRepo.create(db, { title: 'untouched' })
    expect(milestoneRepo.remove(db, 9999)).toEqual({ removed: false, unlinkedCount: 0 })
    expect(todoRepo.getById(db, todo.id)?.updatedAt).toBeNull()
  })
})
