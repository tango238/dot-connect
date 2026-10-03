import { describe, expect, test } from 'bun:test'
import * as todoRepo from '../../src/db/todoRepo'
import { createTestApp, readJson } from './testApp'

const TOKEN = 'test-secret-token'

describe('API token auth end-to-end against the real route table', () => {
  test('a valid token can list/create/update/complete/reopen/delete todos', async () => {
    const { app, deps } = createTestApp({ apiToken: TOKEN })
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

    const createRes = await app.request('/api/todos', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Via API token' }),
    })
    expect(createRes.status).toBe(201)
    const created = (await readJson(createRes)).data

    const listRes = await app.request('/api/todos', { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(listRes.status).toBe(200)

    const updateRes = await app.request(`/api/todos/${created.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: 'Renamed via token' }),
    })
    expect(updateRes.status).toBe(200)

    const completeRes = await app.request(`/api/todos/${created.id}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(completeRes.status).toBe(200)

    const reopenRes = await app.request(`/api/todos/${created.id}/reopen`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(reopenRes.status).toBe(200)

    const deleteRes = await app.request(`/api/todos/${created.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(deleteRes.status).toBe(200)
    expect(todoRepo.getById(deps.db, created.id)).toBeNull()
  })

  test('a valid token can perform milestones and labels CRUD', async () => {
    const { app } = createTestApp({ apiToken: TOKEN })
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

    const labelRes = await app.request('/api/labels', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Backend' }),
    })
    expect(labelRes.status).toBe(201)
    const label = (await readJson(labelRes)).data

    const milestoneRes = await app.request('/api/milestones', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Q3',
        startDate: '2026-07-01',
        targetDate: '2026-09-30',
        labelId: label.id,
      }),
    })
    expect(milestoneRes.status).toBe(201)
    const milestone = (await readJson(milestoneRes)).data
    expect(milestone.labelId).toBe(label.id)

    const listMilestonesRes = await app.request('/api/milestones', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(listMilestonesRes.status).toBe(200)

    const patchLabelRes = await app.request(`/api/labels/${label.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(patchLabelRes.status).toBe(200)

    const deleteMilestoneRes = await app.request(`/api/milestones/${milestone.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(deleteMilestoneRes.status).toBe(200)

    const deleteLabelRes = await app.request(`/api/labels/${label.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(deleteLabelRes.status).toBe(200)
  })

  test('a valid token can perform workspaces CRUD and read /api/models', async () => {
    const { app } = createTestApp({ apiToken: TOKEN })
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

    const createRes = await app.request('/api/workspaces', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'my-app', path: '/Users/you/projects/my-app' }),
    })
    expect(createRes.status).toBe(201)
    const workspace = (await readJson(createRes)).data

    const listRes = await app.request('/api/workspaces', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(listRes.status).toBe(200)

    const patchRes = await app.request(`/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'renamed' }),
    })
    expect(patchRes.status).toBe(200)

    const modelsRes = await app.request('/api/models', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(modelsRes.status).toBe(200)
    expect((await readJson(modelsRes)).data).toEqual(['opus', 'sonnet', 'haiku', 'fable', 'codex'])

    const deleteRes = await app.request(`/api/workspaces/${workspace.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(deleteRes.status).toBe(200)
  })

  describe('blocked endpoints even with a valid token', () => {
    test('POST /api/todos/:id/dispatch -> 403', async () => {
      const { app, deps } = createTestApp({ apiToken: TOKEN })
      const todo = todoRepo.create(deps.db, { title: 'x', workspacePath: '/tmp' })
      const res = await app.request(`/api/todos/${todo.id}/dispatch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(403)
    })

    test('POST /api/todos/:id/open-session -> 403', async () => {
      const { app, deps } = createTestApp({ apiToken: TOKEN })
      const todo = todoRepo.create(deps.db, { title: 'x' })
      const res = await app.request(`/api/todos/${todo.id}/open-session`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(403)
    })

    test('POST /api/reports/weekly/generate -> 403', async () => {
      const { app } = createTestApp({ apiToken: TOKEN })
      const res = await app.request('/api/reports/weekly/generate', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(403)
    })

    test('POST /api/herdr/sync -> 403', async () => {
      const { app } = createTestApp({ apiToken: TOKEN })
      const res = await app.request('/api/herdr/sync', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(res.status).toBe(403)
    })
  })

  test('an invalid token returns 401 even for an otherwise-allowed endpoint', async () => {
    const { app } = createTestApp({ apiToken: TOKEN })
    const res = await app.request('/api/todos', {
      headers: { authorization: 'Bearer not-the-real-token' },
    })
    expect(res.status).toBe(401)
  })

  test('a bad Origin with a valid token still succeeds (token bypasses CSRF)', async () => {
    const { app } = createTestApp({ apiToken: TOKEN })
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: 'http://evil.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(201)
  })

  test('a bad Origin with an invalid token returns 401, not 403', async () => {
    const { app } = createTestApp({ apiToken: TOKEN })
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { authorization: 'Bearer nope', origin: 'http://evil.example.com' },
    })
    expect(res.status).toBe(401)
  })

  test('a bad Origin with no token at all still gets the legacy 403', async () => {
    const { app } = createTestApp({ apiToken: TOKEN })
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { origin: 'http://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  test('browser same-origin access (no token at all) still reaches every endpoint as before', async () => {
    const { app, deps } = createTestApp({ apiToken: TOKEN })
    const todo = todoRepo.create(deps.db, { title: 'x' })
    // createTestApp's default same-origin header is injected automatically
    // for mutating requests with no explicit Origin/Sec-Fetch-Site.
    const res = await app.request(`/api/todos/${todo.id}/open-session`, { method: 'POST' })
    expect(res.status).not.toBe(403)
  })
})

// F50 regression coverage against the REAL route table (not just the bare
// middleware unit tests in apiTokenAuth.test.ts): on a non-loopback bind,
// "no token" must never reach a route handler, on any method.
describe('F50: non-loopback bind requires a token on every request', () => {
  test('GET with no Authorization header -> 401 (was 200 before the fix)', async () => {
    const { app, deps } = createTestApp({ apiToken: TOKEN, isLoopback: false })
    todoRepo.create(deps.db, { title: 'x' })
    const res = await app.request('/api/todos')
    expect(res.status).toBe(401)
  })

  test('POST with a forged same-origin Origin and no token -> 401 (was 201 before the fix)', async () => {
    const { app } = createTestApp({ apiToken: TOKEN, isLoopback: false })
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'forged' }),
    })
    expect(res.status).toBe(401)
  })

  test('DELETE with no token -> 401 (was 200 before the fix, e.g. against /api/prompts/history)', async () => {
    const { app } = createTestApp({ apiToken: TOKEN, isLoopback: false })
    const res = await app.request('/api/prompts/history', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })

  test('POST /api/herdr/sync with a forged Origin and no token -> 401, not the previous 200', async () => {
    const { app } = createTestApp({ apiToken: TOKEN, isLoopback: false })
    const res = await app.request('/api/herdr/sync', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757' },
    })
    expect(res.status).toBe(401)
  })

  test('a valid token still works normally: CRUD allowed, dispatch still 403', async () => {
    const { app } = createTestApp({ apiToken: TOKEN, isLoopback: false })
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

    const createRes = await app.request('/api/todos', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'x' }),
    })
    expect(createRes.status).toBe(201)
    const created = (await readJson(createRes)).data

    const dispatchRes = await app.request(`/api/todos/${created.id}/dispatch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(dispatchRes.status).toBe(403)

    // Endpoints outside the todos/milestones/labels allowlist are
    // unreachable even WITH a valid token, once the server is exposed
    // beyond loopback — there is no legitimate external use for them.
    const promptsRes = await app.request('/api/prompts/history', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(promptsRes.status).toBe(403)
  })

  test('an invalid token still gets 401, same as on loopback', async () => {
    const { app } = createTestApp({ apiToken: TOKEN, isLoopback: false })
    const res = await app.request('/api/todos', { headers: { authorization: 'Bearer wrong' } })
    expect(res.status).toBe(401)
  })
})

describe('regression: loopback bind keeps the pre-F50 "no token -> CSRF fallback" behavior', () => {
  test('token configured, no token sent, legitimate same-origin request still succeeds', async () => {
    const { app } = createTestApp({ apiToken: TOKEN, isLoopback: true })
    const res = await app.request('/api/todos', { headers: { origin: 'http://localhost:5757' } })
    expect(res.status).toBe(200)
  })
})

describe('pull request links over the API token path (the MCP transport)', () => {
  test('a valid token can add, refresh, and remove a PR link', async () => {
    const exec = async () => ({
      stdout: JSON.stringify({ title: 'Fix it', state: 'OPEN', isDraft: false }),
      stderr: '',
      exitCode: 0,
    })
    const { app, deps } = createTestApp({ apiToken: TOKEN, exec })
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    const todoId = todoRepo.create(deps.db, { title: 'has a PR' }).id

    const addRes = await app.request(`/api/todos/${todoId}/pull-requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://github.com/o/r/pull/7' }),
    })
    expect(addRes.status).toBe(201)
    const prId = (await readJson(addRes)).data.pullRequests[0].id

    const refreshRes = await app.request(
      `/api/todos/${todoId}/pull-requests/${prId}/refresh`,
      { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }
    )
    expect(refreshRes.status).toBe(200)

    const deleteRes = await app.request(`/api/todos/${todoId}/pull-requests/${prId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(deleteRes.status).toBe(200)
    expect((await readJson(deleteRes)).data.pullRequests).toEqual([])
  })

  test('the workspacePath history stays off-limits to a token (403, not 200)', async () => {
    const { app } = createTestApp({ apiToken: TOKEN })
    const res = await app.request('/api/workspaces/history', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(403)
  })
})
