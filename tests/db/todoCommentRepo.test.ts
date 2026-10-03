import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as todoCommentRepo from '../../src/db/todoCommentRepo'
import * as todoRepo from '../../src/db/todoRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

function createTodo(title = 'a todo'): number {
  return todoRepo.create(db, { title }).id
}

function comment(todoId: number, body = '進捗メモ') {
  return todoCommentRepo.create(db, { todoId, body })
}

describe('todoCommentRepo', () => {
  test('stores a comment and lists it back', () => {
    const todoId = createTodo()
    const created = comment(todoId, '調査開始')
    expect(created).toMatchObject({ todoId, body: '調査開始' })
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(todoCommentRepo.listByTodoId(db, todoId)).toEqual([created])
  })

  // 作業ログは時系列で読むものなので、登録順(= 古い順)で返す。
  test('lists a todo’s comments oldest first', () => {
    const todoId = createTodo()
    comment(todoId, 'first')
    comment(todoId, 'second')
    comment(todoId, 'third')
    expect(todoCommentRepo.listByTodoId(db, todoId).map((c) => c.body)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  test('keeps the body verbatim, including newlines', () => {
    const todoId = createTodo()
    const created = comment(todoId, '1行目\n2行目\n\n4行目')
    expect(todoCommentRepo.getById(db, created.id)?.body).toBe('1行目\n2行目\n\n4行目')
  })

  test('groups every comment by todo id in one pass', () => {
    const first = createTodo('one')
    const second = createTodo('two')
    const none = createTodo('none')
    comment(first, 'a')
    comment(first, 'b')
    comment(second, 'c')
    const grouped = todoCommentRepo.groupAllByTodoId(db)
    expect(grouped.get(first)?.map((c) => c.body)).toEqual(['a', 'b'])
    expect(grouped.get(second)?.map((c) => c.body)).toEqual(['c'])
    // A commentless todo gets no entry; todoRepo turns that into [] itself.
    expect(grouped.has(none)).toBe(false)
  })

  test('getById returns null for an unknown id', () => {
    expect(todoCommentRepo.getById(db, 9999)).toBeNull()
  })

  test('remove reports whether anything was deleted', () => {
    const created = comment(createTodo())
    expect(todoCommentRepo.remove(db, created.id)).toBe(true)
    expect(todoCommentRepo.getById(db, created.id)).toBeNull()
    expect(todoCommentRepo.remove(db, created.id)).toBe(false)
  })

  test('deleting the todo deletes its comments', () => {
    const todoId = createTodo()
    const created = comment(todoId)
    todoRepo.remove(db, todoId)
    expect(todoCommentRepo.getById(db, created.id)).toBeNull()
  })
})

describe('todoRepo carries comments on the todo', () => {
  test('getById includes the comments oldest first', () => {
    const todoId = createTodo()
    comment(todoId, 'a')
    comment(todoId, 'b')
    expect(todoRepo.getById(db, todoId)?.comments.map((c) => c.body)).toEqual(['a', 'b'])
  })

  test('listAll includes them, and is empty (not undefined) for todos with none', () => {
    const withComment = createTodo('has one')
    createTodo('has none')
    comment(withComment)
    const todos = todoRepo.listAll(db)
    expect(todos.find((t) => t.id === withComment)?.comments).toHaveLength(1)
    expect(todos.find((t) => t.title === 'has none')?.comments).toEqual([])
  })
})

// コメントの追記・削除は人の操作なので、親TODOの「最終更新」を動かす
// (PRリンクや添付の付け外しと同じ扱い)。
describe('todoCommentRepo と親TODOの updated_at', () => {
  function updatedAtOf(todoId: number): string | null {
    return todoRepo.getById(db, todoId)?.updatedAt ?? null
  }

  test('コメントの追記で親TODOの updated_at が入る', () => {
    const todoId = createTodo()
    expect(updatedAtOf(todoId)).toBeNull()
    comment(todoId)
    expect(updatedAtOf(todoId)).not.toBeNull()
  })

  test('コメントの削除で親TODOの updated_at が入る', () => {
    const todoId = createTodo()
    const created = comment(todoId)
    db.run('UPDATE todos SET updated_at = NULL WHERE id = ?', [todoId])
    todoCommentRepo.remove(db, created.id)
    expect(updatedAtOf(todoId)).not.toBeNull()
  })
})
