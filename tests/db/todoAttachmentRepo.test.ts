import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as appSettingsRepo from '../../src/db/appSettingsRepo'
import { createDatabase } from '../../src/db/database'
import * as todoAttachmentRepo from '../../src/db/todoAttachmentRepo'
import * as todoRepo from '../../src/db/todoRepo'
import { UPLOAD_DIR_KEY } from '../../src/db/uploadDirLocation'

const UPLOAD_DIR = '/tmp/dot-connect-test-attachments'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

function createTodo(title = 'a todo'): number {
  return todoRepo.create(db, { title }).id
}

function attach(todoId: number, storedName: string, originalName = 'report.pdf', sizeBytes = 12) {
  return todoAttachmentRepo.create(db, { todoId, storedName, originalName, sizeBytes }, UPLOAD_DIR)
}

describe('todoAttachmentRepo', () => {
  test('stores an attachment and lists it back', () => {
    const todoId = createTodo()
    const created = attach(todoId, 'aaa.pdf', 'report.pdf', 1234)
    expect(created).toMatchObject({
      todoId,
      storedName: 'aaa.pdf',
      originalName: 'report.pdf',
      sizeBytes: 1234,
    })
    expect(todoAttachmentRepo.listByTodoId(db, todoId, UPLOAD_DIR)).toEqual([created])
  })

  test('lists a todo’s attachments in registration order', () => {
    const todoId = createTodo()
    attach(todoId, 'b.pdf', 'second.pdf')
    attach(todoId, 'a.pdf', 'first.pdf')
    expect(
      todoAttachmentRepo.listByTodoId(db, todoId, UPLOAD_DIR).map((a) => a.originalName)
    ).toEqual(['second.pdf', 'first.pdf'])
  })

  // path はDBに保存せず読み出し時に組み立てる — あとで保存先フォルダを変えて
  // も、行に焼かれた古いパスが残らないようにするため。
  test('builds path under the given uploadDir rather than storing it', () => {
    const todoId = createTodo()
    const created = attach(todoId, 'aaa.pdf')
    expect(created.path).toBe(join(UPLOAD_DIR, 'aaa.pdf'))

    const moved = todoAttachmentRepo.getById(db, created.id, '/tmp/moved-elsewhere')
    expect(moved?.path).toBe('/tmp/moved-elsewhere/aaa.pdf')
  })

  test('countByTodoId counts only that todo’s attachments', () => {
    const first = createTodo('one')
    const second = createTodo('two')
    attach(first, 'a.pdf')
    attach(first, 'b.pdf')
    attach(second, 'c.pdf')
    expect(todoAttachmentRepo.countByTodoId(db, first)).toBe(2)
    expect(todoAttachmentRepo.countByTodoId(db, second)).toBe(1)
    expect(todoAttachmentRepo.countByTodoId(db, createTodo('none'))).toBe(0)
  })

  test('groups every attachment by todo id in one pass', () => {
    const first = createTodo('one')
    const second = createTodo('two')
    attach(first, 'a.pdf', 'a.pdf')
    attach(first, 'b.pdf', 'b.pdf')
    attach(second, 'c.pdf', 'c.pdf')
    const grouped = todoAttachmentRepo.groupAllByTodoId(db, UPLOAD_DIR)
    expect(grouped.get(first)?.map((a) => a.storedName)).toEqual(['a.pdf', 'b.pdf'])
    expect(grouped.get(second)?.map((a) => a.path)).toEqual([join(UPLOAD_DIR, 'c.pdf')])
  })

  test('remove reports whether anything was deleted', () => {
    const created = attach(createTodo(), 'a.pdf')
    expect(todoAttachmentRepo.remove(db, created.id)).toBe(true)
    expect(todoAttachmentRepo.getById(db, created.id, UPLOAD_DIR)).toBeNull()
    expect(todoAttachmentRepo.remove(db, created.id)).toBe(false)
  })

  test('deleting the todo deletes its attachments', () => {
    const todoId = createTodo()
    const created = attach(todoId, 'a.pdf')
    todoRepo.remove(db, todoId)
    expect(todoAttachmentRepo.getById(db, created.id, UPLOAD_DIR)).toBeNull()
  })
})

describe('todoRepo carries attachments on the todo', () => {
  beforeEach(() => {
    appSettingsRepo.set(db, UPLOAD_DIR_KEY, UPLOAD_DIR)
  })

  test('getById includes the attachments, with paths under the configured upload dir', () => {
    const todoId = createTodo()
    attach(todoId, 'a.pdf', 'report.pdf')
    expect(todoRepo.getById(db, todoId)?.attachments).toMatchObject([
      { originalName: 'report.pdf', path: join(UPLOAD_DIR, 'a.pdf') },
    ])
  })

  test('listAll includes them, and is empty (not undefined) for todos with none', () => {
    const withAttachment = createTodo('has one')
    createTodo('has none')
    attach(withAttachment, 'a.pdf')
    const todos = todoRepo.listAll(db)
    expect(todos.find((t) => t.id === withAttachment)?.attachments).toHaveLength(1)
    expect(todos.find((t) => t.title === 'has none')?.attachments).toEqual([])
  })
})

// todoRepo は uploadDir を引数で受け取らず、開いているDBハンドルのファイル位置
// (db.filename) から解決する。上のブロックは upload_dir を設定してしまうので
// resolveUploadDir が早期 return し、その仕組みが一度も動かない —— 設定が無い
// ときの既定の解決経路を、ここで実際のファイルDBに対して固定しておく。
describe('todoRepo resolves the upload dir from the database file it was opened with', () => {
  let tempDir: string
  let fileDb: Database

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dot-connect-attachments-'))
    fileDb = createDatabase(join(tempDir, 'dot-connect.db'))
  })

  afterEach(() => {
    fileDb.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('defaults to <db file の隣>/attachments when no upload dir is configured', () => {
    const todoId = todoRepo.create(fileDb, { title: 'a todo' }).id
    todoAttachmentRepo.create(
      fileDb,
      { todoId, storedName: 'a.pdf', originalName: 'report.pdf', sizeBytes: 12 },
      'ignored: todoRepo resolves its own'
    )
    const attachment = todoRepo.getById(fileDb, todoId)?.attachments[0]
    expect(attachment?.path).toBe(join(dirname(fileDb.filename), 'attachments', 'a.pdf'))
    expect(attachment?.path).toBe(join(tempDir, 'attachments', 'a.pdf'))
  })
})

// 添付の付け外しは人の操作なので、親TODOの「最終更新」を動かす
// (todoPullRequestRepo のリンク追加/削除と同じ扱い)。
describe('todoAttachmentRepo と親TODOの updated_at', () => {
  function updatedAtOf(todoId: number): string | null {
    return todoRepo.getById(db, todoId)?.updatedAt ?? null
  }

  test('添付の追加で親TODOの updated_at が入る', () => {
    const todoId = createTodo()
    expect(updatedAtOf(todoId)).toBeNull()
    attach(todoId, 'aaa.pdf')
    expect(updatedAtOf(todoId)).not.toBeNull()
  })

  test('添付の削除で親TODOの updated_at が入る', () => {
    const todoId = createTodo()
    const created = attach(todoId, 'aaa.pdf')
    db.run('UPDATE todos SET updated_at = NULL WHERE id = ?', [todoId])
    todoAttachmentRepo.remove(db, created.id)
    expect(updatedAtOf(todoId)).not.toBeNull()
  })
})
