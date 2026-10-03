import { describe, expect, test } from 'bun:test'
import * as todoCommentRepo from '../../src/db/todoCommentRepo'
import * as todoRepo from '../../src/db/todoRepo'
import { type TestApp, createTestApp, readJson } from './testApp'

const MAX_BODY_LENGTH = 4000

function appWithTodo() {
  const ctx = createTestApp()
  const todo = todoRepo.create(ctx.deps.db, { title: 'a todo' })
  return { ...ctx, todoId: todo.id }
}

function post(app: TestApp, path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function del(app: TestApp, path: string) {
  return app.request(path, { method: 'DELETE' })
}

describe('POST /api/todos/:id/comments', () => {
  test('コメントを追記し、更新後のTODOを201で返す', async () => {
    const { app, todoId } = appWithTodo()
    const res = await post(app, `/api/todos/${todoId}/comments`, { body: '調査を開始した' })
    const body = await readJson(res)

    expect(res.status).toBe(201)
    expect(body.data.id).toBe(todoId)
    expect(body.data.comments).toHaveLength(1)
    expect(body.data.comments[0]).toMatchObject({ todoId, body: '調査を開始した' })
    expect(typeof body.data.comments[0].createdAt).toBe('string')
  })

  test('追記のたびに末尾に増え、古い順で返る', async () => {
    const { app, todoId } = appWithTodo()
    await post(app, `/api/todos/${todoId}/comments`, { body: 'first' })
    await post(app, `/api/todos/${todoId}/comments`, { body: 'second' })
    const res = await post(app, `/api/todos/${todoId}/comments`, { body: 'third' })
    const body = await readJson(res)
    expect(body.data.comments.map((c: { body: string }) => c.body)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  test('前後の空白は落として保存する', async () => {
    const { app, todoId } = appWithTodo()
    const res = await post(app, `/api/todos/${todoId}/comments`, { body: '  メモ  \n' })
    expect((await readJson(res)).data.comments[0].body).toBe('メモ')
  })

  test('本文中の改行は保つ', async () => {
    const { app, todoId } = appWithTodo()
    const res = await post(app, `/api/todos/${todoId}/comments`, { body: '1行目\n2行目' })
    expect((await readJson(res)).data.comments[0].body).toBe('1行目\n2行目')
  })

  test('空文字や空白だけの本文は400', async () => {
    const { app, deps, todoId } = appWithTodo()
    for (const body of ['', '   ', '\n\t']) {
      const res = await post(app, `/api/todos/${todoId}/comments`, { body })
      expect(res.status).toBe(400)
    }
    expect(todoRepo.getById(deps.db, todoId)?.comments).toHaveLength(0)
  })

  test('本文が無いリクエストは400', async () => {
    const { app, todoId } = appWithTodo()
    expect((await post(app, `/api/todos/${todoId}/comments`, {})).status).toBe(400)
  })

  test(`本文が${MAX_BODY_LENGTH}文字を超えると400`, async () => {
    const { app, todoId } = appWithTodo()
    const okRes = await post(app, `/api/todos/${todoId}/comments`, {
      body: 'x'.repeat(MAX_BODY_LENGTH),
    })
    expect(okRes.status).toBe(201)
    const tooLong = await post(app, `/api/todos/${todoId}/comments`, {
      body: 'x'.repeat(MAX_BODY_LENGTH + 1),
    })
    expect(tooLong.status).toBe(400)
  })

  test('存在しないTODOには404', async () => {
    const { app } = appWithTodo()
    const res = await post(app, '/api/todos/9999/comments', { body: 'メモ' })
    expect(res.status).toBe(404)
  })

  test('追記で親TODOの updatedAt が入る', async () => {
    const { app, deps, todoId } = appWithTodo()
    expect(todoRepo.getById(deps.db, todoId)?.updatedAt).toBeNull()
    await post(app, `/api/todos/${todoId}/comments`, { body: 'メモ' })
    expect(todoRepo.getById(deps.db, todoId)?.updatedAt).not.toBeNull()
  })
})

describe('DELETE /api/todos/:id/comments/:commentId', () => {
  test('コメントを消し、更新後のTODOを返す', async () => {
    const { app, deps, todoId } = appWithTodo()
    const keep = todoCommentRepo.create(deps.db, { todoId, body: 'keep' })
    const gone = todoCommentRepo.create(deps.db, { todoId, body: 'gone' })

    const res = await del(app, `/api/todos/${todoId}/comments/${gone.id}`)
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data.id).toBe(todoId)
    expect(body.data.comments.map((c: { id: number }) => c.id)).toEqual([keep.id])
    expect(todoCommentRepo.getById(deps.db, gone.id)).toBeNull()
  })

  test('存在しないコメントは404', async () => {
    const { app, todoId } = appWithTodo()
    expect((await del(app, `/api/todos/${todoId}/comments/9999`)).status).toBe(404)
  })

  // 別のTODOに属するコメントのidを渡しても消さない: 実在するidでも、パスの
  // TODOのものでなければ「無い」扱いにする(PRリンク・添付と同じ)。
  test('別のTODOのコメントは404で、消えない', async () => {
    const { app, deps, todoId } = appWithTodo()
    const other = todoRepo.create(deps.db, { title: 'other' })
    const foreign = todoCommentRepo.create(deps.db, { todoId: other.id, body: 'theirs' })

    const res = await del(app, `/api/todos/${todoId}/comments/${foreign.id}`)

    expect(res.status).toBe(404)
    expect(todoCommentRepo.getById(deps.db, foreign.id)).not.toBeNull()
  })

  test('不正なidは400', async () => {
    const { app, todoId } = appWithTodo()
    expect((await del(app, `/api/todos/${todoId}/comments/abc`)).status).toBe(400)
  })
})

describe('GET /api/todos carries comments', () => {
  test('一覧の各TODOに comments が常に付く', async () => {
    const { app, deps, todoId } = appWithTodo()
    todoRepo.create(deps.db, { title: 'no comments' })
    todoCommentRepo.create(deps.db, { todoId, body: 'メモ' })

    const res = await app.request('/api/todos')
    const body = await readJson(res)
    const withComment = body.data.find((t: { id: number }) => t.id === todoId)
    const without = body.data.find((t: { title: string }) => t.title === 'no comments')

    expect(withComment.comments).toHaveLength(1)
    expect(without.comments).toEqual([])
  })
})
