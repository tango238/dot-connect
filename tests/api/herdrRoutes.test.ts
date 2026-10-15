import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as todoRepo from '../../src/db/todoRepo'
import { installSkill } from '../../src/services/skillInstallService'
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

describe('POST /api/herdr/skill-session', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dot-connect-skill-session-api-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function skillApp(overrides: Parameters<typeof createTestApp>[0] = {}) {
    return createTestApp({ claudeSkillsDir: join(tmp, 'skills'), notesDir: join(tmp, 'notes'), ...overrides })
  }

  test('opens a claude session in the notes dir with /dot-connect typed but not sent', async () => {
    const { app, deps } = skillApp()
    installSkill(deps.claudeSkillsDir)

    const res = await app.request('/api/herdr/skill-session', { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data).toEqual({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    const herdr = deps.herdr as FakeHerdrClient
    expect(herdr.createWorkspaceCalls[0]).toMatchObject({ cwd: deps.notesDir })
    expect(herdr.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: 'claude' }])
    expect(herdr.sendTextCalls).toEqual([{ paneId: 'w1:p1', text: '/dot-connect ' }])
    expect(herdr.submitPromptCalls).toHaveLength(0)
    expect(herdr.focusTabCalls).toEqual(['w1:t1'])
  })

  test('returns 409 skill_not_installed when the skill is missing', async () => {
    const { app, deps } = skillApp()
    const res = await app.request('/api/herdr/skill-session', { method: 'POST' })
    const body = await readJson(res)
    expect(res.status).toBe(409)
    expect(body.code).toBe('skill_not_installed')
    expect((deps.herdr as FakeHerdrClient).createWorkspaceCalls).toHaveLength(0)
  })

  test('returns 400 outside macOS', async () => {
    const { app } = skillApp({ platform: 'linux' })
    const res = await app.request('/api/herdr/skill-session', { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toContain('macOS')
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
