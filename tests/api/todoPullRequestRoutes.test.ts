import { describe, expect, test } from 'bun:test'
import * as todoPullRequestRepo from '../../src/db/todoPullRequestRepo'
import * as todoRepo from '../../src/db/todoRepo'
import type { ExecFn } from '../../src/herdr/exec'
import { createTestApp, readJson } from './testApp'

const PR_URL = 'https://github.com/acme/my-app/pull/123'

function ghReturning(json: unknown): ExecFn {
  return async () => ({ stdout: JSON.stringify(json), stderr: '', exitCode: 0 })
}

const ghOk = ghReturning({ title: 'Fix login error handling', state: 'OPEN', isDraft: false })

const ghFailing: ExecFn = async () => ({
  stdout: '',
  stderr: 'gh: authentication required',
  exitCode: 1,
})

function appWithGh(exec: ExecFn) {
  const ctx = createTestApp({ exec })
  const todo = todoRepo.create(ctx.deps.db, { title: 'a todo' })
  return { ...ctx, todoId: todo.id }
}

function post(app: { request: (i: string, init?: RequestInit) => Promise<Response> }, path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('POST /api/todos/:id/pull-requests', () => {
  test('links a PR and returns the updated todo with its fetched metadata', async () => {
    const { app, todoId } = appWithGh(ghOk)
    const res = await post(app, `/api/todos/${todoId}/pull-requests`, { url: PR_URL })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.id).toBe(todoId)
    expect(body.data.pullRequests).toHaveLength(1)
    expect(body.data.pullRequests[0]).toMatchObject({
      url: PR_URL,
      owner: 'acme',
      repo: 'my-app',
      number: 123,
      title: 'Fix login error handling',
      state: 'open',
      isDraft: false,
      fetchError: null,
    })
  })

  test('stores the canonical URL, not whatever variant was pasted', async () => {
    const { app, todoId } = appWithGh(ghOk)
    const res = await post(app, `/api/todos/${todoId}/pull-requests`, {
      url: `${PR_URL}/files#discussion_r1`,
    })
    const body = await readJson(res)
    expect(body.data.pullRequests[0].url).toBe(PR_URL)
  })

  test('accepts more than one PR on the same todo', async () => {
    const { app, todoId } = appWithGh(ghOk)
    await post(app, `/api/todos/${todoId}/pull-requests`, { url: PR_URL })
    const res = await post(app, `/api/todos/${todoId}/pull-requests`, {
      url: 'https://github.com/acme/my-app/pull/124',
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.pullRequests.map((pr: { number: number }) => pr.number)).toEqual([123, 124])
  })

  // The whole point of the "URL first, metadata second" split: a link is
  // still worth keeping when gh can't be reached.
  test('still registers the link when gh fails, recording why', async () => {
    const { app, todoId } = appWithGh(ghFailing)
    const res = await post(app, `/api/todos/${todoId}/pull-requests`, { url: PR_URL })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.pullRequests[0]).toMatchObject({
      url: PR_URL,
      title: null,
      state: null,
      fetchedAt: null,
      fetchError: 'gh: authentication required',
    })
  })

  test('rejects a non-PR URL with 400', async () => {
    const { app, todoId } = appWithGh(ghOk)
    const res = await post(app, `/api/todos/${todoId}/pull-requests`, {
      url: 'https://github.com/acme/my-app/issues/1',
    })
    expect(res.status).toBe(400)
  })

  test('rejects the same PR twice on one todo with 409', async () => {
    const { app, todoId } = appWithGh(ghOk)
    await post(app, `/api/todos/${todoId}/pull-requests`, { url: PR_URL })
    const res = await post(app, `/api/todos/${todoId}/pull-requests`, { url: `${PR_URL}/files` })
    expect(res.status).toBe(409)
  })

  test('404s for a todo that does not exist', async () => {
    const { app } = appWithGh(ghOk)
    const res = await post(app, '/api/todos/9999/pull-requests', { url: PR_URL })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/todos/:id/pull-requests/:prId/refresh', () => {
  test('re-fetches and stores the current state', async () => {
    const ctx = createTestApp({ exec: ghOk })
    const todoId = todoRepo.create(ctx.deps.db, { title: 'a todo' }).id
    const created = await readJson(
      await post(ctx.app, `/api/todos/${todoId}/pull-requests`, { url: PR_URL })
    )
    const prId = created.data.pullRequests[0].id

    // A second app over the SAME database, but with gh now reporting the PR
    // as merged — the app builds its fetcher once at route-construction
    // time, so swapping gh's answer means building a new app.
    const merged = createTestApp({
      exec: ghReturning({ title: 'Fix login error handling', state: 'MERGED', isDraft: false }),
      db: ctx.deps.db,
    })
    const res = await post(merged.app, `/api/todos/${todoId}/pull-requests/${prId}/refresh`)
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.pullRequests[0]).toMatchObject({ state: 'merged', fetchError: null })
  })

  test('keeps the previous snapshot when the refresh fails', async () => {
    const ctx = createTestApp({ exec: ghOk })
    const todoId = todoRepo.create(ctx.deps.db, { title: 'a todo' }).id
    const created = await readJson(
      await post(ctx.app, `/api/todos/${todoId}/pull-requests`, { url: PR_URL })
    )
    const prId = created.data.pullRequests[0].id

    const failing = createTestApp({ exec: ghFailing, db: ctx.deps.db })
    const res = await post(failing.app, `/api/todos/${todoId}/pull-requests/${prId}/refresh`)
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.pullRequests[0]).toMatchObject({
      title: 'Fix login error handling',
      state: 'open',
      fetchError: 'gh: authentication required',
    })
  })

  test('404s for a PR id that belongs to a different todo', async () => {
    const ctx = createTestApp({ exec: ghOk })
    const owner = todoRepo.create(ctx.deps.db, { title: 'owner' }).id
    const other = todoRepo.create(ctx.deps.db, { title: 'other' }).id
    const created = todoPullRequestRepo.create(ctx.deps.db, {
      todoId: owner,
      url: PR_URL,
      owner: 'acme',
      repo: 'my-app',
      number: 123,
    })
    const res = await post(ctx.app, `/api/todos/${other}/pull-requests/${created.id}/refresh`)
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/todos/:id/pull-requests/:prId', () => {
  test('removes the link and returns the updated todo', async () => {
    const ctx = createTestApp({ exec: ghOk })
    const todoId = todoRepo.create(ctx.deps.db, { title: 'a todo' }).id
    const created = await readJson(
      await post(ctx.app, `/api/todos/${todoId}/pull-requests`, { url: PR_URL })
    )
    const prId = created.data.pullRequests[0].id
    const res = await ctx.app.request(`/api/todos/${todoId}/pull-requests/${prId}`, {
      method: 'DELETE',
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.pullRequests).toEqual([])
  })

  test('404s for a PR id that belongs to a different todo', async () => {
    const ctx = createTestApp({ exec: ghOk })
    const owner = todoRepo.create(ctx.deps.db, { title: 'owner' }).id
    const other = todoRepo.create(ctx.deps.db, { title: 'other' }).id
    const created = todoPullRequestRepo.create(ctx.deps.db, {
      todoId: owner,
      url: PR_URL,
      owner: 'acme',
      repo: 'my-app',
      number: 123,
    })
    const res = await ctx.app.request(`/api/todos/${other}/pull-requests/${created.id}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
    expect(todoPullRequestRepo.getById(ctx.deps.db, created.id)).not.toBeNull()
  })
})

describe('GET /api/todos', () => {
  test('carries each todo’s pull requests', async () => {
    const ctx = createTestApp({ exec: ghOk })
    const todoId = todoRepo.create(ctx.deps.db, { title: 'a todo' }).id
    todoRepo.create(ctx.deps.db, { title: 'no PRs' })
    await post(ctx.app, `/api/todos/${todoId}/pull-requests`, { url: PR_URL })
    const body = await readJson(await ctx.app.request('/api/todos'))
    const withPr = body.data.find((t: { id: number }) => t.id === todoId)
    const without = body.data.find((t: { title: string }) => t.title === 'no PRs')
    expect(withPr.pullRequests).toHaveLength(1)
    expect(without.pullRequests).toEqual([])
  })
})
