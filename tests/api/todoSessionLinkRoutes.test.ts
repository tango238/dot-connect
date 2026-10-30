import { describe, expect, test } from 'bun:test'
import * as todoRepo from '../../src/db/todoRepo'
import { createFakeHerdrClient, createTestApp, readJson } from './testApp'
import { HerdrCommandError } from '../../src/herdr/herdrClient'

// POST/DELETE /api/todos/:id/session: herdr セッション側からの紐づけ。
// 判定の細部は tests/services/sessionService.test.ts にあり、ここは HTTP の
// 形(ステータス・バリデーション・エラーの通し方)だけを見る。

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('POST /api/todos/:id/session', () => {
  test('links the todo to a live pane and returns the updated todo', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })

    const res = await app.request(`/api/todos/${todo.id}/session`, json({ paneId: 'w1:p1' }))
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data.herdrPaneId).toBe('w1:p1')
    expect(body.data.herdrTabId).toBe('w1:t1')
    expect(body.data.herdrWorkspaceId).toBe('w1')
    expect(body.data.sessionState).toBe('idle')
  })

  test('accepts matching tabId/workspaceId and rejects mismatching ones with 400', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })

    const okRes = await app.request(
      `/api/todos/${todo.id}/session`,
      json({ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1' })
    )
    expect(okRes.status).toBe(200)

    const badRes = await app.request(
      `/api/todos/${todo.id}/session`,
      json({ paneId: 'w1:p1', tabId: 'w1:t9' })
    )
    expect(badRes.status).toBe(400)
  })

  test('400 on a missing or blank paneId', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    expect((await app.request(`/api/todos/${todo.id}/session`, json({}))).status).toBe(400)
    expect((await app.request(`/api/todos/${todo.id}/session`, json({ paneId: '  ' }))).status).toBe(400)
  })

  test('404 for an unknown todo and for a pane herdr does not list', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    expect((await app.request('/api/todos/999/session', json({ paneId: 'w1:p1' }))).status).toBe(404)
    expect((await app.request(`/api/todos/${todo.id}/session`, json({ paneId: 'zz' }))).status).toBe(404)
  })

  test('409 with the owning todo when the pane is already linked elsewhere', async () => {
    const { app, deps } = createTestApp()
    const owner = todoRepo.create(deps.db, { title: 'owner' })
    todoRepo.markDispatched(deps.db, owner.id, { herdrWorkspaceId: 'w1', herdrTabId: 'w1:t1', herdrPaneId: 'w1:p1' })
    const todo = todoRepo.create(deps.db, { title: 'x' })

    const res = await app.request(`/api/todos/${todo.id}/session`, json({ paneId: 'w1:p1' }))
    const body = await readJson(res)

    expect(res.status).toBe(409)
    expect(body.code).toBe('pane_in_use')
    expect(body.todoId).toBe(owner.id)
  })

  test('502 when herdr cannot be reached', async () => {
    const herdr = createFakeHerdrClient()
    const { app, deps } = createTestApp({ herdr })
    const todo = todoRepo.create(deps.db, { title: 'x' })
    herdr.snapshotError = new HerdrCommandError('socket gone')

    const res = await app.request(`/api/todos/${todo.id}/session`, json({ paneId: 'w1:p1' }))
    expect(res.status).toBe(502)
    expect(todoRepo.getById(deps.db, todo.id)?.herdrPaneId).toBeNull()
  })

  test('is not platform-gated: works when the server is not on darwin', async () => {
    const { app, deps } = createTestApp({ platform: 'linux' })
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}/session`, json({ paneId: 'w1:p1' }))
    expect(res.status).toBe(200)
  })
})

describe('DELETE /api/todos/:id/session', () => {
  test('clears the linkage without closing the herdr workspace', async () => {
    const herdr = createFakeHerdrClient()
    const { app, deps } = createTestApp({ herdr })
    const todo = todoRepo.create(deps.db, { title: 'x' })
    todoRepo.markDispatched(deps.db, todo.id, { herdrWorkspaceId: 'w1', herdrTabId: 'w1:t1', herdrPaneId: 'w1:p1' })

    const res = await app.request(`/api/todos/${todo.id}/session`, { method: 'DELETE' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data.herdrPaneId).toBeNull()
    expect(body.data.sessionState).toBeNull()
    expect(herdr.closeWorkspaceCalls).toEqual([])
  })

  test('404 for an unknown todo', async () => {
    const { app } = createTestApp()
    expect((await app.request('/api/todos/999/session', { method: 'DELETE' })).status).toBe(404)
  })
})
