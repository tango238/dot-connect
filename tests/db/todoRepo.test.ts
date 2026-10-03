import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import * as milestoneRepo from '../../src/db/milestoneRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

// Field-by-field create/get/update coverage (priority, description, model,
// workspacePath, milestone join), CRUD 404s, and the priority-ordering rule
// are all exercised end-to-end via tests/api/todosRoutes.test.ts; only the
// cases below add signal the route layer doesn't already cover.

describe('todoRepo.create', () => {
  test('creates a todo with defaults', () => {
    const todo = todoRepo.create(db, { title: 'Write tests' })
    expect(todo.title).toBe('Write tests')
    expect(todo.status).toBe('open')
    expect(todo.milestoneId).toBeNull()
    expect(todo.sessionState).toBeNull()
    expect(todo.description).toBe('')
    expect(todo.priority).toBe('none')
  })
})

describe('todoRepo.listAll priority ordering', () => {
  test('does not factor completion status into the ordering (repository layer is priority-only)', () => {
    // Neither todo has a due date, so this exercises the priority-then-id
    // ordering that applies among due-date-less todos.
    const doneHigh = todoRepo.create(db, { title: 'done-high', priority: 'high' })
    todoRepo.complete(db, doneHigh.id)
    todoRepo.create(db, { title: 'open-none' })

    const all = todoRepo.listAll(db)
    // The done-but-high-priority todo still sorts before the open-but-
    // unprioritized one: grouping completed todos separately is the
    // frontend's job, not this repository's.
    expect(all[0]?.id).toBe(doneHigh.id)
  })
})

describe('todoRepo.listAll due date ordering', () => {
  test('期限ありが先、期限の昇順、期限なしは後ろで優先度順', () => {
    const db = createDatabase(':memory:')
    // 期限なし・高優先度(期限ありより後ろに来るはず)
    todoRepo.create(db, { title: 'no-due-high', priority: 'high' })
    // 期限あり・優先度なし(先頭側に来るはず)
    todoRepo.create(db, { title: 'due-late', priority: 'none', dueDate: '2026-12-31' })
    todoRepo.create(db, { title: 'due-early', priority: 'none', dueDate: '2026-01-01' })
    todoRepo.create(db, { title: 'no-due-low', priority: 'low' })

    expect(todoRepo.listAll(db).map((t) => t.title)).toEqual([
      'due-early',
      'due-late',
      'no-due-high',
      'no-due-low',
    ])
  })

  test('同じ期限なら優先度、さらに同じなら id 昇順', () => {
    const db = createDatabase(':memory:')
    todoRepo.create(db, { title: 'same-low', priority: 'low', dueDate: '2026-05-05' })
    todoRepo.create(db, { title: 'same-high', priority: 'high', dueDate: '2026-05-05' })
    todoRepo.create(db, { title: 'same-high-2', priority: 'high', dueDate: '2026-05-05' })

    expect(todoRepo.listAll(db).map((t) => t.title)).toEqual(['same-high', 'same-high-2', 'same-low'])
  })
})

describe('todoRepo due date create/update', () => {
  test('既定は null', () => {
    const db = createDatabase(':memory:')
    expect(todoRepo.create(db, { title: 'x' }).dueDate).toBeNull()
  })

  test('作成時に設定でき、更新で変更・null クリアできる', () => {
    const db = createDatabase(':memory:')
    const created = todoRepo.create(db, { title: 'x', dueDate: '2026-03-03' })
    expect(created.dueDate).toBe('2026-03-03')

    expect(todoRepo.update(db, created.id, { dueDate: '2026-04-04' })?.dueDate).toBe('2026-04-04')
    expect(todoRepo.update(db, created.id, { dueDate: null })?.dueDate).toBeNull()
  })

  test('dueDate 省略時は既存値を変更しない', () => {
    const db = createDatabase(':memory:')
    const created = todoRepo.create(db, { title: 'x', dueDate: '2026-03-03' })
    expect(todoRepo.update(db, created.id, { title: 'y' })?.dueDate).toBe('2026-03-03')
  })
})

describe('todoRepo.update', () => {
  test('updates title, milestoneId, workspacePath', () => {
    const milestone = milestoneRepo.create(db, {
      title: 'M',
      description: '',
      color: '#fff',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const todo = todoRepo.create(db, { title: 'old' })
    const updated = todoRepo.update(db, todo.id, {
      title: 'new',
      milestoneId: milestone.id,
      workspacePath: '/path',
    })
    expect(updated?.title).toBe('new')
    expect(updated?.milestoneId).toBe(milestone.id)
    expect(updated?.workspacePath).toBe('/path')
  })
})

describe('todoRepo.complete / reopen', () => {
  test('complete sets status done, completedAt, and idles sessionState if present', () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 't1',
      herdrPaneId: 'p1',
    })
    const completed = todoRepo.complete(db, todo.id)
    expect(completed?.status).toBe('done')
    expect(completed?.completedAt).not.toBeNull()
    expect(completed?.sessionState).toBe('idle')
  })

  test('complete on a todo with no session_state leaves it null', () => {
    const todo = todoRepo.create(db, { title: 'x' })
    const completed = todoRepo.complete(db, todo.id)
    expect(completed?.sessionState).toBeNull()
  })

  test('reopen sets status open and clears completedAt', () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.complete(db, todo.id)
    const reopened = todoRepo.reopen(db, todo.id)
    expect(reopened?.status).toBe('open')
    expect(reopened?.completedAt).toBeNull()
  })

  test('complete snapshots milestoneId into completedMilestoneId', () => {
    const milestone = milestoneRepo.create(db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const todo = todoRepo.create(db, { title: 'x', milestoneId: milestone.id })
    const completed = todoRepo.complete(db, todo.id)
    expect(completed?.completedMilestoneId).toBe(milestone.id)
  })

  test('complete on an unlinked todo leaves completedMilestoneId null', () => {
    const todo = todoRepo.create(db, { title: 'x' })
    const completed = todoRepo.complete(db, todo.id)
    expect(completed?.completedMilestoneId).toBeNull()
  })

  test('reopen clears completedMilestoneId', () => {
    const milestone = milestoneRepo.create(db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const todo = todoRepo.create(db, { title: 'x', milestoneId: milestone.id })
    todoRepo.complete(db, todo.id)
    const reopened = todoRepo.reopen(db, todo.id)
    expect(reopened?.completedMilestoneId).toBeNull()
  })

  test('completedMilestoneId survives the milestone later being unlinked from the todo', () => {
    const milestone = milestoneRepo.create(db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const todo = todoRepo.create(db, { title: 'x', milestoneId: milestone.id })
    todoRepo.complete(db, todo.id)
    todoRepo.update(db, todo.id, { milestoneId: null })
    expect(todoRepo.getById(db, todo.id)?.completedMilestoneId).toBe(milestone.id)
  })
})

describe('todoRepo.updateSessionState', () => {
  test('updates the session_state column directly', () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.updateSessionState(db, todo.id, 'blocked')
    expect(todoRepo.getById(db, todo.id)?.sessionState).toBe('blocked')
  })
})

describe('todoRepo milestone deletion cascade', () => {
  test('deleting the milestone nulls out milestone_id on todos (ON DELETE SET NULL)', () => {
    const milestone = milestoneRepo.create(db, {
      title: 'M',
      description: '',
      color: '#fff',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const todo = todoRepo.create(db, { title: 'x', milestoneId: milestone.id })
    milestoneRepo.remove(db, milestone.id)
    expect(todoRepo.getById(db, todo.id)?.milestoneId).toBeNull()
  })
})

// 最終更新時刻。作成直後は NULL のままで(labels/workspaces と同じ規約)、
// 何かが起きて初めて値が入る。datetime('now') は秒精度なので「進んだ」こと
// を時刻比較で確かめるのは不安定 —— NULL/非NULL の遷移だけを見る。
describe('todoRepo updated_at', () => {
  test('作成直後は null', () => {
    expect(todoRepo.create(db, { title: 't' }).updatedAt).toBeNull()
  })

  test('update で値が入る', () => {
    const todo = todoRepo.create(db, { title: 't' })
    expect(todoRepo.update(db, todo.id, { title: 'renamed' })?.updatedAt).not.toBeNull()
  })

  test('変更するフィールドが1つも無い update では値が入らない', () => {
    // sets が空なら SQL 自体を撃たない既存の挙動に合わせる。空の PATCH で
    // 一覧の先頭に躍り出るのは「更新された」とは呼べない。
    const todo = todoRepo.create(db, { title: 't' })
    expect(todoRepo.update(db, todo.id, {})?.updatedAt).toBeNull()
  })

  test('complete と reopen で値が入る', () => {
    const completed = todoRepo.create(db, { title: 't' })
    expect(todoRepo.complete(db, completed.id)?.updatedAt).not.toBeNull()

    const reopened = todoRepo.create(db, { title: 'u' })
    todoRepo.complete(db, reopened.id)
    db.run('UPDATE todos SET updated_at = NULL WHERE id = ?', [reopened.id])
    expect(todoRepo.reopen(db, reopened.id)?.updatedAt).not.toBeNull()
  })

  test('markDispatched で値が入る', () => {
    const todo = todoRepo.create(db, { title: 't' })
    const dispatched = todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w',
      herdrTabId: 't',
      herdrPaneId: 'p',
    })
    expect(dispatched.updatedAt).not.toBeNull()
  })

  test('clearDispatch で値が入る', () => {
    const todo = todoRepo.create(db, { title: 't' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w',
      herdrTabId: 't',
      herdrPaneId: 'p',
    })
    db.run('UPDATE todos SET updated_at = NULL WHERE id = ?', [todo.id])
    todoRepo.clearDispatch(db, todo.id)
    expect(todoRepo.getById(db, todo.id)?.updatedAt).not.toBeNull()
  })

  test('updateSessionState で値が入る(statusSync 経由の状態変化も更新に数える)', () => {
    const todo = todoRepo.create(db, { title: 't' })
    todoRepo.updateSessionState(db, todo.id, 'blocked')
    expect(todoRepo.getById(db, todo.id)?.updatedAt).not.toBeNull()
  })
})
