import { describe, expect, test } from 'bun:test'
import * as appSettingsRepo from '../../src/db/appSettingsRepo'
import * as todoRepo from '../../src/db/todoRepo'
import { WIP_LIMIT_ENABLED_KEY, WIP_LIMIT_KEY } from '../../src/services/wipLimitService'
import { createTestApp, readJson, type FakeHerdrClient } from './testApp'

type Deps = ReturnType<typeof createTestApp>['deps']

function linkedTodo(deps: Deps, title: string, n: number) {
  const todo = todoRepo.create(deps.db, { title, workspacePath: '/tmp/proj' })
  todoRepo.markDispatched(deps.db, todo.id, {
    herdrWorkspaceId: `w${n}`,
    herdrTabId: `w${n}:t1`,
    herdrPaneId: `w${n}:p1`,
  })
  return todo
}

function enableWip(deps: Deps, limit: number) {
  appSettingsRepo.set(deps.db, WIP_LIMIT_ENABLED_KEY, '1')
  appSettingsRepo.set(deps.db, WIP_LIMIT_KEY, String(limit))
}

function patchSettings(app: ReturnType<typeof createTestApp>['app'], body: unknown) {
  return app.request('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('WIP制限の設定', () => {
  test('既定は無効・上限10', async () => {
    const { app } = createTestApp()
    const body = await readJson(await app.request('/api/settings'))
    expect(body.data.wipLimitEnabled).toBe(false)
    expect(body.data.wipLimit).toBe(10)
  })

  test('有効化と上限を保存できる', async () => {
    const { app } = createTestApp()
    const res = await patchSettings(app, { wipLimitEnabled: true, wipLimit: 30 })
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.data.wipLimitEnabled).toBe(true)
    expect(body.data.wipLimit).toBe(30)
  })

  test.each([0, 31, 2.5])('上限 %p は400', async (wipLimit) => {
    const { app } = createTestApp()
    expect((await patchSettings(app, { wipLimit })).status).toBe(400)
  })
})

describe('WIP制限と投入', () => {
  test('有効で上限に達していれば409、workspace は作らない', async () => {
    const { app, deps } = createTestApp()
    enableWip(deps, 2)
    linkedTodo(deps, 'a', 7)
    linkedTodo(deps, 'b', 8)
    const todo = todoRepo.create(deps.db, { title: 'c', workspacePath: '/tmp/proj' })

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(409)
    expect(body.code).toBe('wip_limit_reached')
    expect(body.wip).toEqual({ count: 2, limit: 2 })
    expect((deps.herdr as FakeHerdrClient).createWorkspaceCalls).toEqual([])
  })

  test('完了したTODOは枠を空ける', async () => {
    const { app, deps } = createTestApp()
    enableWip(deps, 1)
    const done = linkedTodo(deps, 'a', 7)
    todoRepo.complete(deps.db, done.id)
    const todo = todoRepo.create(deps.db, { title: 'c', workspacePath: '/tmp/proj' })

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('無効なら上限を超えても投入できる', async () => {
    const { app, deps } = createTestApp()
    appSettingsRepo.set(deps.db, WIP_LIMIT_KEY, '1')
    linkedTodo(deps, 'a', 7)
    const todo = todoRepo.create(deps.db, { title: 'c', workspacePath: '/tmp/proj' })

    const res = await app.request(`/api/todos/${todo.id}/dispatch`, { method: 'POST' })
    expect(res.status).toBe(200)
  })

  test('同時に走る投入も枠を使うものとして数える', async () => {
    const { app, deps } = createTestApp()
    enableWip(deps, 1)
    const a = todoRepo.create(deps.db, { title: 'a', workspacePath: '/tmp/proj' })
    const b = todoRepo.create(deps.db, { title: 'b', workspacePath: '/tmp/proj' })

    const [ra, rb] = await Promise.all([
      app.request(`/api/todos/${a.id}/dispatch`, { method: 'POST' }),
      app.request(`/api/todos/${b.id}/dispatch`, { method: 'POST' }),
    ])
    expect([ra.status, rb.status].sort()).toEqual([200, 409])
  })
})

describe('herdrセッションが残るTODOの削除', () => {
  function livePane(deps: Deps, paneId: string) {
    ;(deps.herdr as FakeHerdrClient).nextSnapshot = {
      panes: [{ paneId, tabId: 'w7:t1', workspaceId: 'w7', agentStatus: 'idle' }],
    }
  }

  test('ペインが生きていれば409で消さない', async () => {
    const { app, deps } = createTestApp()
    const todo = linkedTodo(deps, 'a', 7)
    livePane(deps, 'w7:p1')

    const res = await app.request(`/api/todos/${todo.id}`, { method: 'DELETE' })
    const body = await readJson(res)

    expect(res.status).toBe(409)
    expect(body.code).toBe('session_alive')
    expect(todoRepo.getById(deps.db, todo.id)).not.toBeNull()
  })

  test('完了済みでもペインが生きていれば消さない', async () => {
    const { app, deps } = createTestApp()
    const todo = linkedTodo(deps, 'a', 7)
    todoRepo.complete(deps.db, todo.id)
    livePane(deps, 'w7:p1')

    const res = await app.request(`/api/todos/${todo.id}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
  })

  test('ペインが既に無ければ古い紐付けを外して消せる', async () => {
    const { app, deps } = createTestApp()
    const todo = linkedTodo(deps, 'a', 7)
    livePane(deps, 'other:p1')

    const res = await app.request(`/api/todos/${todo.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(todoRepo.getById(deps.db, todo.id)).toBeNull()
  })

  test('herdr に聞けなければ消さない', async () => {
    const { app, deps } = createTestApp()
    const todo = linkedTodo(deps, 'a', 7)
    ;(deps.herdr as FakeHerdrClient).snapshotError = new Error('herdr down')

    const res = await app.request(`/api/todos/${todo.id}`, { method: 'DELETE' })
    const body = await readJson(res)
    expect(res.status).toBe(409)
    expect(body.code).toBe('session_unverified')
    expect(todoRepo.getById(deps.db, todo.id)).not.toBeNull()
  })

  test('セッションの無いTODOは herdr に聞かずに消せる', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    ;(deps.herdr as FakeHerdrClient).snapshotError = new Error('herdr down')

    const res = await app.request(`/api/todos/${todo.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })
})
