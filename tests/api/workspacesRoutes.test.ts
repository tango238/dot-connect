import { describe, expect, test } from 'bun:test'
import * as workspacePathHistoryRepo from '../../src/db/workspacePathHistoryRepo'
import * as workspaceRepo from '../../src/db/workspaceRepo'
import * as todoRepo from '../../src/db/todoRepo'
import { createTestApp, readJson } from './testApp'

describe('GET /api/workspaces', () => {
  test('returns an empty array when there are none', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/workspaces')
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
  })

  test('returns workspaces ordered by name ascending', async () => {
    const { app, deps } = createTestApp()
    workspaceRepo.create(deps.db, { name: 'Zeta', path: '/z' })
    workspaceRepo.create(deps.db, { name: 'Alpha', path: '/a' })
    const res = await app.request('/api/workspaces')
    const body = await readJson(res)
    expect(body.data.map((w: { name: string }) => w.name)).toEqual(['Alpha', 'Zeta'])
  })
})

describe('POST /api/workspaces', () => {
  test('creates a workspace', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-app', path: '/Users/you/projects/my-app' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.name).toBe('my-app')
    expect(body.data.path).toBe('/Users/you/projects/my-app')
  })

  test('trims name and path before validating', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Spaced  ', path: '  /tmp/x  ' }),
    })
    const body = await readJson(res)
    expect(body.data.name).toBe('Spaced')
    expect(body.data.path).toBe('/tmp/x')
  })

  test('returns 400 for an empty (whitespace-only) name', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ', path: '/tmp/x' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when name exceeds 100 characters', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a'.repeat(101), path: '/tmp/x' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 for a relative path', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', path: 'relative/path' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(400)
    expect(body.error).toContain('絶対パス')
  })

  test('returns 400 for a missing path', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 409 for a duplicate name', async () => {
    const { app, deps } = createTestApp()
    workspaceRepo.create(deps.db, { name: 'my-app', path: '/a' })
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-app', path: '/b' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(409)
    expect(body.error).toBe('同じ名前の作業ディレクトリが既にあります')
  })
})

describe('PATCH /api/workspaces/:id', () => {
  test('updates name and path', async () => {
    const { app, deps } = createTestApp()
    const workspace = workspaceRepo.create(deps.db, { name: 'old', path: '/old' })
    const res = await app.request(`/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new', path: '/new' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.name).toBe('new')
    expect(body.data.path).toBe('/new')
    expect(body.data.updatedAt).not.toBeNull()
  })

  test('returns 404 for a missing workspace', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/workspaces/999', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  test('returns 409 when renaming to a name already used by another workspace', async () => {
    const { app, deps } = createTestApp()
    workspaceRepo.create(deps.db, { name: 'my-app', path: '/a' })
    const other = workspaceRepo.create(deps.db, { name: 'spotly', path: '/b' })
    const res = await app.request(`/api/workspaces/${other.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-app' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(409)
    expect(body.error).toBe('同じ名前の作業ディレクトリが既にあります')
  })

  test('returns 400 for a relative path', async () => {
    const { app, deps } = createTestApp()
    const workspace = workspaceRepo.create(deps.db, { name: 'x', path: '/x' })
    const res = await app.request(`/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'relative' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/workspaces/:id', () => {
  test('deletes a workspace', async () => {
    const { app, deps } = createTestApp()
    const workspace = workspaceRepo.create(deps.db, { name: 'my-app', path: '/a' })
    const res = await app.request(`/api/workspaces/${workspace.id}`, { method: 'DELETE' })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ removed: true })
    expect(workspaceRepo.getById(deps.db, workspace.id)).toBeNull()
  })

  test('returns 404 for a missing workspace', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/workspaces/999', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  // workspace_path on todos is a plain string copy, not an FK — deleting the
  // registered workspace must not touch any todo that already used its path.
  test('does not affect a todo that already copied the workspace path', async () => {
    const { app, deps } = createTestApp()
    const workspace = workspaceRepo.create(deps.db, { name: 'my-app', path: '/a/my-app' })
    const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: workspace.path })

    const res = await app.request(`/api/workspaces/${workspace.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    expect(todoRepo.getById(deps.db, todo.id)?.workspacePath).toBe('/a/my-app')
  })
})

describe('workspace path history', () => {
  test('GET /api/workspaces/history is empty before any dispatch', async () => {
    const { app } = createTestApp()
    const body = await readJson(await app.request('/api/workspaces/history'))
    expect(body.data).toEqual([])
  })

  test('GET /api/workspaces/history lists recorded paths, newest first', async () => {
    const { app, deps } = createTestApp()
    workspacePathHistoryRepo.recordUse(deps.db, '/a')
    workspacePathHistoryRepo.recordUse(deps.db, '/b')
    const body = await readJson(await app.request('/api/workspaces/history'))
    expect(body.data.map((h: { path: string }) => h.path)).toEqual(['/b', '/a'])
  })

  test('DELETE /api/workspaces/history clears it and reports the count', async () => {
    const { app, deps } = createTestApp()
    workspacePathHistoryRepo.recordUse(deps.db, '/a')
    workspacePathHistoryRepo.recordUse(deps.db, '/b')
    const res = await app.request('/api/workspaces/history', { method: 'DELETE' })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.removed).toBe(2)
    expect(workspacePathHistoryRepo.listAll(deps.db)).toEqual([])
  })

  // '/history' is registered before '/:id'; without that ordering "history"
  // would be coerced as a workspace id and rejected as invalid.
  test('does not shadow, or get shadowed by, the /:id routes', async () => {
    const { app, deps } = createTestApp()
    const created = workspaceRepo.create(deps.db, { name: 'my-app', path: '/r' })
    workspacePathHistoryRepo.recordUse(deps.db, '/r')
    expect((await app.request('/api/workspaces/history')).status).toBe(200)
    const del = await app.request(`/api/workspaces/${created.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    // Deleting the registered entry leaves the history untouched.
    expect(workspacePathHistoryRepo.listAll(deps.db).map((h) => h.path)).toEqual(['/r'])
  })
})
