import { describe, expect, test } from 'bun:test'
import * as todoRepo from '../../src/db/todoRepo'
import * as milestoneRepo from '../../src/db/milestoneRepo'
import { createTestApp, readJson, type FakeHerdrClient } from './testApp'
import { herdrWorkspaceLabel } from '../../src/services/herdrWorkspaceLabel'

describe('GET /api/todos', () => {
  test('returns an empty array when there are no todos', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos')
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: [] })
  })

  test('includes joined milestone title/color', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'Launch',
      color: '#123456',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    todoRepo.create(deps.db, { title: 'Ship it', milestoneId: milestone.id })

    const res = await app.request('/api/todos')
    const body = await readJson(res)
    expect(body.data[0].milestoneTitle).toBe('Launch')
    expect(body.data[0].milestoneColor).toBe('#123456')
  })

  test('orders todos high -> low -> none, ties in existing (id) order', async () => {
    const { app, deps } = createTestApp()
    todoRepo.create(deps.db, { title: 'a-none' })
    todoRepo.create(deps.db, { title: 'b-high', priority: 'high' })
    todoRepo.create(deps.db, { title: 'c-low', priority: 'low' })
    todoRepo.create(deps.db, { title: 'd-high', priority: 'high' })

    const res = await app.request('/api/todos')
    const body = await readJson(res)
    expect(body.data.map((t: { title: string }) => t.title)).toEqual([
      'b-high',
      'd-high',
      'c-low',
      'a-none',
    ])
  })
})

describe('POST /api/todos', () => {
  test('creates a todo', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'New task' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.title).toBe('New task')
    expect(body.data.description).toBe('')
  })

  test('creates a todo with a description', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', description: '  Some detail  ' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.description).toBe('Some detail')
  })

  test('returns 400 when description exceeds 4000 characters', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', description: 'a'.repeat(4001) }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 for an empty title', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    })
    expect(res.status).toBe(400)
    const body = await readJson(res)
    expect(body.success).toBe(false)
  })

  test('returns 400 when title exceeds 200 characters', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a'.repeat(201) }),
    })
    expect(res.status).toBe(400)
  })

  test('accepts a title at exactly 200 characters', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a'.repeat(200) }),
    })
    expect(res.status).toBe(201)
  })

  test('returns 404 when milestoneId does not reference an existing milestone', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', milestoneId: 9999 }),
    })
    expect(res.status).toBe(404)
    const body = await readJson(res)
    expect(body.error).toContain('削除されています')
  })

  test('defaults priority to none when omitted', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    const body = await readJson(res)
    expect(body.data.priority).toBe('none')
  })

  test('creates a todo with an explicit priority', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', priority: 'high' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.priority).toBe('high')
  })

  test('returns 400 for an invalid priority value', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', priority: 'urgent' }),
    })
    expect(res.status).toBe(400)
  })

  test('creates a todo with a workspacePath, trimmed', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', workspacePath: '  /tmp/proj  ' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.workspacePath).toBe('/tmp/proj')
  })

  test('omitting workspacePath leaves it null', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    const body = await readJson(res)
    expect(body.data.workspacePath).toBeNull()
  })

  // A whitespace-only value is treated as "no path provided" (null) rather
  // than a 400: a blank form field shouldn't fail validation, and — more
  // importantly — a whitespace string must never be STORED verbatim, since
  // that would be non-null/non-empty enough to slip past dispatch's
  // "workspacePath must be set" check while still being useless as a cwd.
  test('a whitespace-only workspacePath is treated as null, not stored verbatim, and does not 400', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', workspacePath: '   ' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.workspacePath).toBeNull()
  })

  // F6: a TODO's workspacePath is now bounded/absolute the same way as a
  // registered workspace's path — this asymmetry (workspaces required an
  // absolute path + 500-char cap; TODOs had neither) was flagged in review.
  test('returns 400 for a relative workspacePath', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', workspacePath: 'relative/path' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(400)
    expect(body.error).toContain('絶対パス')
  })

  test('returns 400 for a workspacePath exceeding 500 characters', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', workspacePath: `/${'a'.repeat(500)}` }),
    })
    expect(res.status).toBe(400)
  })

  test('accepts an absolute workspacePath at exactly 500 characters', async () => {
    const { app } = createTestApp()
    const path = `/${'a'.repeat(499)}`
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', workspacePath: path }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.workspacePath).toBe(path)
  })

  test('creates a todo with a model', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', model: 'opus' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.model).toBe('opus')
  })

  test('omitting model leaves it null', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    const body = await readJson(res)
    expect(body.data.model).toBeNull()
  })

  test('returns 400 for a model not in the allowlist', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', model: 'gpt-4' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(400)
    expect(body.error).toContain('gpt-4')
  })

  test('an empty-string model is treated as null, not a 400', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', model: '' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.model).toBeNull()
  })
})

describe('PATCH /api/todos/:id', () => {
  test('updates fields on an existing todo', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'old' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.title).toBe('new')
  })

  // 最終更新は API まで出ていないと画面の「最近の更新」が並べ替えられない。
  // どのイベントで進むかの網羅は tests/db/todoRepo.test.ts 側。
  test('作成レスポンスの updatedAt は null、更新レスポンスでは非 null', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'old' })
    expect(todo.updatedAt).toBeNull()

    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new' }),
    })
    const body = await readJson(res)
    expect(body.data.updatedAt).not.toBeNull()
  })

  test('updates both title and description together', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'old', description: 'old desc' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new', description: 'new desc' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.title).toBe('new')
    expect(body.data.description).toBe('new desc')
  })

  test('can clear the description to an empty string', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', description: 'has detail' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '' }),
    })
    const body = await readJson(res)
    expect(body.data.description).toBe('')
  })

  test('can clear milestoneId with null', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const todo = todoRepo.create(deps.db, { title: 'x', milestoneId: milestone.id })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ milestoneId: null }),
    })
    const body = await readJson(res)
    expect(body.data.milestoneId).toBeNull()
  })

  test('sets workspacePath, trimmed', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: '  /tmp/new  ' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.workspacePath).toBe('/tmp/new')
  })

  test('can clear workspacePath with null', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/old' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: null }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.workspacePath).toBeNull()
    expect(todoRepo.getById(deps.db, todo.id)?.workspacePath).toBeNull()
  })

  test('can also clear workspacePath with an empty/whitespace-only string', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/old' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: '   ' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.workspacePath).toBeNull()
  })

  test('omitting workspacePath leaves an existing value untouched', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/kept' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    })
    const body = await readJson(res)
    expect(body.data.workspacePath).toBe('/tmp/kept')
  })

  // F6: same bound/absolute-path check as create, without disturbing a
  // pre-existing (possibly legacy relative) value already stored.
  test('returns 400 for a relative workspacePath, without persisting it', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/kept' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: 'relative/path' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(400)
    expect(body.error).toContain('絶対パス')
    expect(todoRepo.getById(deps.db, todo.id)?.workspacePath).toBe('/tmp/kept')
  })

  test('returns 400 for a workspacePath exceeding 500 characters', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: `/${'a'.repeat(500)}` }),
    })
    expect(res.status).toBe(400)
  })

  test('sets the model', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.model).toBe('sonnet')
  })

  test('can clear the model with null', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', model: 'opus' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: null }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.model).toBeNull()
    expect(todoRepo.getById(deps.db, todo.id)?.model).toBeNull()
  })

  test('omitting model leaves an existing value untouched', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', model: 'haiku' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    })
    const body = await readJson(res)
    expect(body.data.model).toBe('haiku')
  })

  test('returns 400 for a model not in the allowlist, without persisting it', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-real-model' }),
    })
    expect(res.status).toBe(400)
    expect(todoRepo.getById(deps.db, todo.id)?.model).toBeNull()
  })

  test('updates the priority', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.priority).toBe('high')
  })

  test('omitting priority leaves it at its current value', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', priority: 'low' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    })
    const body = await readJson(res)
    expect(body.data.priority).toBe('low')
  })

  test('returns 400 for an invalid priority value', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority: 'urgent' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 404 for a missing todo', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos/999', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  test('returns 404 when updating to a milestoneId that does not exist', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ milestoneId: 9999 }),
    })
    expect(res.status).toBe(404)
    const body = await readJson(res)
    expect(body.error).toContain('削除されています')
  })

  test('returns 400 when PATCHing title to exceed 200 characters', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a'.repeat(201) }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/todos/:id/complete と herdr セッションの後片付け', () => {
  // 条件と失敗時の扱いの網羅は tests/services/todoCompletionService.test.ts。
  // ここではルートがそのサービスを通っていることだけを見る。
  function dispatchedTodo(deps: ReturnType<typeof createTestApp>['deps'], title: string) {
    const todo = todoRepo.create(deps.db, { title, workspacePath: '/tmp/proj' })
    todoRepo.markDispatched(deps.db, todo.id, {
      herdrWorkspaceId: 'w7',
      herdrTabId: 'w7:t1',
      herdrPaneId: 'w7:p1',
    })
    return todo
  }

  // 閉じる/閉じないの判断は herdr に問い合わせた実状態で決まる(保存された
  // session_state ではない)ので、フェイクのスナップショットを差し替える。
  function livePane(deps: ReturnType<typeof createTestApp>['deps'], agentStatus: string) {
    ;(deps.herdr as FakeHerdrClient).nextSnapshot = {
      panes: [
        {
          paneId: 'w7:p1',
          tabId: 'w7:t1',
          workspaceId: 'w7',
          agentStatus: agentStatus as 'idle' | 'working' | 'blocked' | 'done' | 'unknown',
        },
      ],
    }
  }

  test('待機中のセッションは完了と同時に閉じ、紐付けも消える', async () => {
    const { app, deps } = createTestApp()
    const todo = dispatchedTodo(deps, 'finished')
    todoRepo.updateSessionState(deps.db, todo.id, 'idle')
    livePane(deps, 'idle')

    const res = await app.request(`/api/todos/${todo.id}/complete`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data.status).toBe('done')
    expect(body.data.herdrWorkspaceId).toBeNull()
    expect((deps.herdr as FakeHerdrClient).closeWorkspaceCalls).toEqual(['w7'])
  })

  test('実行中のセッションは閉じない', async () => {
    const { app, deps } = createTestApp()
    const todo = dispatchedTodo(deps, 'still running')
    livePane(deps, 'working')

    const res = await app.request(`/api/todos/${todo.id}/complete`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data.status).toBe('done')
    expect(body.data.herdrWorkspaceId).toBe('w7')
    expect((deps.herdr as FakeHerdrClient).closeWorkspaceCalls).toEqual([])
  })
})

describe('POST /api/todos/:id/complete and /reopen', () => {
  test('completes and reopens a todo', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })

    const completeRes = await app.request(`/api/todos/${todo.id}/complete`, { method: 'POST' })
    const completeBody = await readJson(completeRes)
    expect(completeRes.status).toBe(200)
    expect(completeBody.data.status).toBe('done')

    const reopenRes = await app.request(`/api/todos/${todo.id}/reopen`, { method: 'POST' })
    const reopenBody = await readJson(reopenRes)
    expect(reopenBody.data.status).toBe('open')
  })

  test('returns 404 when completing a missing todo', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos/999/complete', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/todos/:id', () => {
  test('deletes an existing todo', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(todoRepo.getById(deps.db, todo.id)).toBeNull()
  })

  test('returns 404 for a missing todo', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos/999', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/todos/:id/dispatch', () => {
  test('dispatches a todo via herdr and records session ids', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'Fix bug', workspacePath: '/tmp/proj' })

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data.sessionState).toBe('working')
    expect(body.data.herdrPaneId).toBe('w1:p1')
    expect(body.data.promptDelivered).toBe(true)
  })

  test('returns promptDelivered: false (still HTTP 200, no rollback) when delivery cannot be confirmed', async () => {
    const { app, deps } = createTestApp({
      dispatchDeliveryConfirmTimeoutMs: 5,
      dispatchPollIntervalMs: 1,
    })
    const todo = todoRepo.create(deps.db, { title: 'Fix bug', workspacePath: '/tmp/proj' })
    ;(deps.herdr as FakeHerdrClient).autoConfirmDelivery = false

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data.promptDelivered).toBe(false)
    expect(body.data.sessionState).toBe('working')
    expect((deps.herdr as FakeHerdrClient).closeWorkspaceCalls).toEqual([])

    const stored = todoRepo.getById(deps.db, todo.id)
    expect(stored?.sessionState).toBe('working')
    expect(stored?.herdrWorkspaceId).not.toBeNull()
  })

  test('returns 409 when the todo is already dispatched and working', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    todoRepo.markDispatched(deps.db, todo.id, {
      herdrWorkspaceId: 'w0',
      herdrTabId: 'w0:t1',
      herdrPaneId: 'w0:p1',
    })

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
    expect(res.status).toBe(409)
  })

  describe('workspacePath in the dispatch request body', () => {
    test('an override is used for the herdr workspace and persisted onto the todo', async () => {
      const { app, deps } = createTestApp()
      const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/old' })

      const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath: '/tmp/new' }),
      })
      const body = await readJson(res)

      expect(res.status).toBe(200)
      expect(body.data.workspacePath).toBe('/tmp/new')
      expect((deps.herdr as FakeHerdrClient).createWorkspaceCalls).toEqual([
        { cwd: '/tmp/new', label: herdrWorkspaceLabel(todo) },
      ])
      expect(todoRepo.getById(deps.db, todo.id)?.workspacePath).toBe('/tmp/new')
    })

    test('a todo created without a workspacePath can be dispatched by supplying one in the request body', async () => {
      const { app, deps } = createTestApp()
      const todo = todoRepo.create(deps.db, { title: 'no path yet' })

      const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath: '/tmp/assigned' }),
      })
      const body = await readJson(res)

      expect(res.status).toBe(200)
      expect(body.data.workspacePath).toBe('/tmp/assigned')
    })

    test('omitting workspacePath falls back to the value already stored on the todo', async () => {
      const { app, deps } = createTestApp()
      const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/stored' })

      const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
      const body = await readJson(res)

      expect(res.status).toBe(200)
      expect(body.data.workspacePath).toBe('/tmp/stored')
      expect((deps.herdr as FakeHerdrClient).createWorkspaceCalls).toEqual([
        { cwd: '/tmp/stored', label: herdrWorkspaceLabel(todo) },
      ])
    })

    test('returns 400 when neither the todo nor the request body has a workspacePath', async () => {
      const { app, deps } = createTestApp()
      const todo = todoRepo.create(deps.db, { title: 'no path anywhere' })

      const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
      const body = await readJson(res)

      expect(res.status).toBe(400)
      expect(body.error).toBe('workspacePath を設定してください')
    })

    test('returns 400 for a whitespace-only workspacePath override', async () => {
      const { app, deps } = createTestApp()
      const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/stored' })

      const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath: '   ' }),
      })

      expect(res.status).toBe(400)
      // Not persisted — validation failed before dispatchTodo was ever called.
      expect(todoRepo.getById(deps.db, todo.id)?.workspacePath).toBe('/tmp/stored')
    })

    // F6: dispatch's workspacePath override gets the same bound/absolute
    // check as create/update, so a relative or oversized override is
    // rejected before herdr is ever called (rather than herdr failing later
    // with an opaque 502 on a relative path).
    test('returns 400 for a relative workspacePath override, without calling herdr', async () => {
      const { app, deps } = createTestApp()
      const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/stored' })

      const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath: 'relative/path' }),
      })
      const body = await readJson(res)

      expect(res.status).toBe(400)
      expect(body.error).toContain('絶対パス')
      expect((deps.herdr as FakeHerdrClient).createWorkspaceCalls).toEqual([])
      expect(todoRepo.getById(deps.db, todo.id)?.workspacePath).toBe('/tmp/stored')
    })

  })

  describe('model in the dispatch request body', () => {
    test('an override starts claude with --model and is persisted onto the todo', async () => {
      const { app, deps } = createTestApp()
      const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp' })

      const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'opus' }),
      })
      const body = await readJson(res)

      expect(res.status).toBe(200)
      expect(body.data.model).toBe('opus')
      expect((deps.herdr as FakeHerdrClient).runInPaneCalls).toEqual([
        { paneId: 'w1:p1', command: 'claude --model opus' },
      ])
      expect(todoRepo.getById(deps.db, todo.id)?.model).toBe('opus')
    })

    test('omitting model falls back to the value already stored on the todo', async () => {
      const { app, deps } = createTestApp()
      const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp', model: 'sonnet' })

      const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
      const body = await readJson(res)

      expect(res.status).toBe(200)
      expect(body.data.model).toBe('sonnet')
      expect((deps.herdr as FakeHerdrClient).runInPaneCalls).toEqual([
        { paneId: 'w1:p1', command: 'claude --model sonnet' },
      ])
    })

    test('neither the todo nor the request having a model starts claude with no --model flag', async () => {
      const { app, deps } = createTestApp()
      const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp' })

      const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })

      expect(res.status).toBe(200)
      expect((deps.herdr as FakeHerdrClient).runInPaneCalls).toEqual([
        { paneId: 'w1:p1', command: 'claude' },
      ])
    })

    test('returns 400 for a model override not in the allowlist, without calling herdr', async () => {
      const { app, deps } = createTestApp()
      const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp' })

      const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4' }),
      })
      const body = await readJson(res)

      expect(res.status).toBe(400)
      expect(body.error).toContain('gpt-4')
      expect((deps.herdr as FakeHerdrClient).createWorkspaceCalls).toEqual([])
    })
  })

  test('returns 404 for a missing todo', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos/999/dispatch', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('returns 409 with a Japanese message when claude never reaches idle before the timeout', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/proj' })
    ;(deps.herdr as FakeHerdrClient).nextSnapshot = {
      panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'working' }],
    }

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(409)
    expect(body.error).toBe('Claude Code の起動を確認できませんでした')
  })

  test('accepts an optional prompt in the body and uses it instead of the title', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'Fix bug', workspacePath: '/tmp/proj' })

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Custom instructions here' }),
    })
    expect(res.status).toBe(200)

    const sentText = (deps.herdr as FakeHerdrClient).submitPromptCalls[0]?.text ?? ''
    expect(sentText).toContain('Custom instructions here')
  })

  test('substitutes {{title}}/{{description}} in a custom prompt, and records the raw template in history', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, {
      title: 'Fix login',
      description: 'SSO redirect loops forever',
      workspacePath: '/tmp/proj',
    })

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Title: {{title}}. Details: {{description}}.' }),
    })
    expect(res.status).toBe(200)

    const sentText = (deps.herdr as FakeHerdrClient).submitPromptCalls[0]?.text ?? ''
    expect(sentText).toContain('Title: Fix login. Details: SSO redirect loops forever.')

    const historyRes = await app.request('/api/prompts/history')
    const historyBody = await readJson(historyRes)
    expect(historyBody.data[0].body).toBe('Title: {{title}}. Details: {{description}}.')
  })

  test('returns 400 without calling herdr when placeholder expansion exceeds the length cap', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'a'.repeat(200), workspacePath: '/tmp/proj' })
    // 9-char template repeated 400x = 3600 chars (under the 4000-char raw
    // prompt limit), but expands to 200 * 400 = 80,000 chars.
    const explosivePrompt = '{{title}}'.repeat(400)

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: explosivePrompt }),
    })

    expect(res.status).toBe(400)
    expect((deps.herdr as FakeHerdrClient).createWorkspaceCalls).toEqual([])
  })

  test('records the custom prompt in history after a successful dispatch', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/proj' })

    await app.request(`/api/todos/${todo.id}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Remember me' }),
    })

    const historyRes = await app.request('/api/prompts/history')
    const historyBody = await readJson(historyRes)
    expect(historyBody.data).toHaveLength(1)
    expect(historyBody.data[0].body).toBe('Remember me')
  })

  test('does not add to history when dispatching without a prompt (title-only)', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/proj' })

    await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })

    const historyRes = await app.request('/api/prompts/history')
    const historyBody = await readJson(historyRes)
    expect(historyBody.data).toEqual([])
  })

  test('returns 400 for an empty (whitespace-only) prompt', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/proj' })

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when the prompt exceeds 4000 characters', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/proj' })

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a'.repeat(4001) }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/todos/:id/open-session', () => {
  test('focuses the tab for a dispatched todo', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    todoRepo.markDispatched(deps.db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })

    const res = await app.request(`/api/todos/${todo.id}/open-session`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((deps.herdr as FakeHerdrClient).focusTabCalls).toEqual(['w1:t1'])
  })

  test('returns 404 when the todo has no session', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request(`/api/todos/${todo.id}/open-session`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('非darwinプラットフォームでのガード', () => {
  test('dispatch は 400', async () => {
    const { app, deps } = createTestApp({ platform: 'win32' })
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp/w' })

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error).toContain('macOS')
  })

  test('open-session は 400', async () => {
    const { app, deps } = createTestApp({ platform: 'win32' })
    const todo = todoRepo.create(deps.db, { title: 'x' })
    todoRepo.markDispatched(deps.db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })

    const res = await app.request(`/api/todos/${todo.id}/open-session`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error).toContain('macOS')
  })
})

describe('CSRF enforcement on the real mounted app', () => {
  test('rejects a same-origin POST body sent as text/plain with 415', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757', 'content-type': 'text/plain' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(415)
  })

  test('allows a legitimate same-origin application/json POST through to normal validation', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'legit' }),
    })
    expect(res.status).toBe(201)
    const body = await readJson(res)
    expect(body.data.title).toBe('legit')
  })

  test('rejects a cross-origin POST with 403 even with a valid JSON body', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { origin: 'http://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('todo dueDate', () => {
  test('作成時に dueDate を設定できる', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'with due', dueDate: '2026-09-30' }),
    })
    expect(res.status).toBe(201)
    expect((await readJson(res)).data.dueDate).toBe('2026-09-30')
  })

  test('省略時は null', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'no due' }),
    })
    expect((await readJson(res)).data.dueDate).toBeNull()
  })

  test('実在しない日付は 400', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'bad', dueDate: '2026-02-30' }),
    })
    expect(res.status).toBe(400)
  })

  test('形式違いは 400', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'bad', dueDate: '2026/09/30' }),
    })
    expect(res.status).toBe(400)
  })

  test('PATCH で更新でき、null でクリアできる', async () => {
    const { app } = createTestApp()
    const created = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', dueDate: '2026-09-30' }),
    })
    const { data } = await readJson(created)

    const updated = await app.request(`/api/todos/${data.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dueDate: '2026-10-01' }),
    })
    expect((await readJson(updated)).data.dueDate).toBe('2026-10-01')

    const cleared = await app.request(`/api/todos/${data.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dueDate: null }),
    })
    expect((await readJson(cleared)).data.dueDate).toBeNull()
  })
})
