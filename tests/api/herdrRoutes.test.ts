import { describe, expect, test } from 'bun:test'
import * as todoRepo from '../../src/db/todoRepo'
import { createTestApp, readJson, type FakeHerdrClient } from './testApp'

describe('POST /api/herdr/sync', () => {
  test('returns the number of todos whose session_state was updated', async () => {
    const { app, deps } = createTestApp()
    const todo = todoRepo.create(deps.db, { title: 'x' })
    todoRepo.markDispatched(deps.db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })
    ;(deps.herdr as FakeHerdrClient).nextSnapshot = {
      panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'blocked' }],
    }

    const res = await app.request('/api/herdr/sync', { method: 'POST' })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ updatedCount: 1, connected: true })
    expect(todoRepo.getById(deps.db, todo.id)?.sessionState).toBe('blocked')
  })

  test('degrades to updatedCount 0 / connected false when herdr is unreachable', async () => {
    const { app, deps } = createTestApp()
    ;(deps.herdr as FakeHerdrClient).snapshotError = new Error('no server')

    const res = await app.request('/api/herdr/sync', { method: 'POST' })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ updatedCount: 0, connected: false })
  })
})

describe('GET /api/herdr/status', () => {
  test('reports connected with the total pane count when herdr responds', async () => {
    const { app, deps } = createTestApp()
    ;(deps.herdr as FakeHerdrClient).nextSnapshot = {
      panes: [
        { paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'working' },
        { paneId: 'w2:p1', tabId: 'w2:t1', workspaceId: 'w2', agentStatus: 'idle' },
      ],
    }
    const res = await app.request('/api/herdr/status')
    const body = await readJson(res)
    expect(body.data).toEqual({ connected: true, totalPanes: 2 })
  })

  test('reports disconnected when herdr snapshot throws', async () => {
    const { app, deps } = createTestApp()
    ;(deps.herdr as FakeHerdrClient).snapshotError = new Error('no server')
    const res = await app.request('/api/herdr/status')
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ connected: false, totalPanes: 0 })
  })
})
