import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as todoRepo from '../../src/db/todoRepo'
import { grillDirFor } from '../../src/services/grillService'
import { createTestApp, readJson, type FakeHerdrClient } from './testApp'

let tmp: string
let grillRoot: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dot-connect-grill-api-'))
  grillRoot = join(tmp, 'grill')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function grillApp(overrides: Parameters<typeof createTestApp>[0] = {}) {
  return createTestApp({ grillRoot, ...overrides })
}

async function startGrilling(ctx: ReturnType<typeof grillApp>, title = 'Fix login') {
  const todo = todoRepo.create(ctx.deps.db, { title, description: 'It breaks' })
  const res = await ctx.app.request(`/api/todos/${todo.id}/grill`, { method: 'POST' })
  expect(res.status).toBe(200)
  return { todo, dir: grillDirFor(grillRoot, todo.id) }
}

describe('POST /api/todos/:id/grill', () => {
  test('starts a grill session and returns the todo with grillDir and the session set', async () => {
    const ctx = grillApp()
    const todo = todoRepo.create(ctx.deps.db, { title: 'Fix login' })

    const res = await ctx.app.request(`/api/todos/${todo.id}/grill`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.grillDir).toBe(grillDirFor(grillRoot, todo.id))
    expect(body.data.sessionState).toBe('working')
    expect(body.data.herdrWorkspaceId).toBe('w1')
    expect(body.data.dispatchedAt).not.toBeNull()
    expect(existsSync(join(body.data.grillDir, 'GRILL.md'))).toBe(true)
    const herdr = ctx.deps.herdr as FakeHerdrClient
    expect(herdr.runInPaneCalls[0]?.command).toBe('claude --permission-mode acceptEdits')
  })

  test('returns 400 outside macOS', async () => {
    const ctx = grillApp({ platform: 'linux' })
    const todo = todoRepo.create(ctx.deps.db, { title: 't' })
    const res = await ctx.app.request(`/api/todos/${todo.id}/grill`, { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toContain('macOS')
  })

  test('returns 404 for an unknown todo', async () => {
    const res = await grillApp().app.request('/api/todos/999/grill', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('returns 409 when the todo is already grilling or has a session', async () => {
    const ctx = grillApp()
    const { todo } = await startGrilling(ctx)
    const again = await ctx.app.request(`/api/todos/${todo.id}/grill`, { method: 'POST' })
    expect(again.status).toBe(409)

    const dispatched = await ctx.app.request(`/api/todos/${todo.id}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: '/tmp' }),
    })
    expect(dispatched.status).toBe(409)
  })
})

describe('POST /api/todos/:id/grilled', () => {
  test('applies GRILLED.md and clears the grill', async () => {
    const ctx = grillApp()
    const { todo, dir } = await startGrilling(ctx)
    writeFileSync(join(dir, 'GRILLED.md'), '# Fix the login timeout\n\n## やること\n- extend\n')

    const res = await ctx.app.request(`/api/todos/${todo.id}/grilled`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data.title).toBe('Fix the login timeout')
    expect(body.data.description).toBe('## やること\n- extend')
    expect(body.data.grillDir).toBeNull()
    expect(body.data.sessionState).toBeNull()
    expect(body.data.herdrWorkspaceId).toBeNull()
    expect((ctx.deps.herdr as FakeHerdrClient).closeWorkspaceCalls).toEqual(['w1'])
    expect(existsSync(dir)).toBe(false)
  })

  test('returns 409 grill_result_pending while the session is alive without a result', async () => {
    const ctx = grillApp()
    const { todo, dir } = await startGrilling(ctx)

    const res = await ctx.app.request(`/api/todos/${todo.id}/grilled`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(409)
    expect(body.code).toBe('grill_result_pending')
    expect(todoRepo.getById(ctx.deps.db, todo.id)!.grillDir).toBe(dir)
  })

  test('returns 409 grill_cancelled and cancels when the session is gone without a result', async () => {
    const ctx = grillApp()
    const { todo, dir } = await startGrilling(ctx)
    ;(ctx.deps.herdr as FakeHerdrClient).nextSnapshot = { panes: [] }

    const res = await ctx.app.request(`/api/todos/${todo.id}/grilled`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(409)
    expect(body.code).toBe('grill_cancelled')
    const after = todoRepo.getById(ctx.deps.db, todo.id)!
    expect(after.grillDir).toBeNull()
    expect(after.sessionState).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  test('returns 400 for a malformed GRILLED.md and keeps the grill', async () => {
    const ctx = grillApp()
    const { todo, dir } = await startGrilling(ctx)
    writeFileSync(join(dir, 'GRILLED.md'), 'no heading\n')

    const res = await ctx.app.request(`/api/todos/${todo.id}/grilled`, { method: 'POST' })

    expect(res.status).toBe(400)
    expect(todoRepo.getById(ctx.deps.db, todo.id)!.grillDir).toBe(dir)
  })

  test('returns 404 for an unknown todo', async () => {
    const res = await grillApp().app.request('/api/todos/999/grilled', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('grill cleanup on complete and delete', () => {
  test('completing a grilling todo removes the grill dir', async () => {
    const ctx = grillApp()
    const { todo, dir } = await startGrilling(ctx)

    const res = await ctx.app.request(`/api/todos/${todo.id}/complete`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data.grillDir).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  test('completing removes the grill dir even when the workspace is left open', async () => {
    const ctx = grillApp()
    const { todo, dir } = await startGrilling(ctx)
    ;(ctx.deps.herdr as FakeHerdrClient).snapshotError = new Error('herdr down')

    const res = await ctx.app.request(`/api/todos/${todo.id}/complete`, { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data.grillDir).toBeNull()
    expect(body.data.herdrWorkspaceId).toBe('w1')
    expect(existsSync(dir)).toBe(false)
  })

  test('deleting a todo whose grill session has ended removes the grill dir', async () => {
    const ctx = grillApp()
    const { todo, dir } = await startGrilling(ctx)
    ;(ctx.deps.herdr as FakeHerdrClient).nextSnapshot = { panes: [] }

    const res = await ctx.app.request(`/api/todos/${todo.id}`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(existsSync(dir)).toBe(false)
  })

  test('deleting a todo with a live grill session is refused and keeps the dir', async () => {
    const ctx = grillApp()
    const { todo, dir } = await startGrilling(ctx)

    const res = await ctx.app.request(`/api/todos/${todo.id}`, { method: 'DELETE' })

    expect(res.status).toBe(409)
    expect(existsSync(dir)).toBe(true)
  })
})
