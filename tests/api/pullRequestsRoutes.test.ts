import { describe, expect, test } from 'bun:test'
import * as todoPullRequestRepo from '../../src/db/todoPullRequestRepo'
import * as todoRepo from '../../src/db/todoRepo'
import type { ExecFn } from '../../src/herdr/exec'
import { createTestApp, readJson } from './testApp'

const PR_URL = 'https://github.com/acme/my-app/pull/123'

// gh の JSON 出力を模したフェイク。実際の出力形状は
// src/services/githubPrService.ts の実装に合わせること。
function fakeGh(payload: object): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = []
  const exec: ExecFn = async (cmd) => {
    calls.push(cmd)
    return { stdout: JSON.stringify(payload), stderr: '', exitCode: 0 }
  }
  return { exec, calls }
}

const ghOk: ExecFn = async () => ({
  stdout: JSON.stringify({ title: 'Fix login error handling', state: 'OPEN', isDraft: false }),
  stderr: '',
  exitCode: 0,
})

const ghFailing: ExecFn = async () => ({
  stdout: '',
  stderr: 'gh: authentication required',
  exitCode: 1,
})

function post(app: { request: (i: string, init?: RequestInit) => Promise<Response> }, path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

// Links a PR to a fresh todo (using `ghOk` so the initial link itself
// succeeds), then ages `fetched_at` well past the 5-minute staleness window
// so the refresh-stale endpoint under test picks it up.
async function linkStalePullRequest(db: import('bun:sqlite').Database): Promise<number> {
  const ctx = createTestApp({ exec: ghOk, db })
  const todoId = todoRepo.create(db, { title: 'a todo' }).id
  const created = await readJson(await post(ctx.app, `/api/todos/${todoId}/pull-requests`, { url: PR_URL }))
  const prId = created.data.pullRequests[0].id
  db.run("UPDATE todo_pull_requests SET fetched_at = datetime('now', '-1 hour') WHERE id = ?", [prId])
  return prId
}

describe('POST /api/pull-requests/refresh-stale', () => {
  test('stale が無ければ gh を呼ばず refreshed: 0 を返す', async () => {
    const { exec, calls } = fakeGh({})
    const { app } = createTestApp({ exec })
    const res = await app.request('/api/pull-requests/refresh-stale', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await readJson(res)).data).toEqual({ refreshed: 0, failed: 0 })
    expect(calls.length).toBe(0)
  })

  test('stale な open PR を再取得して結果を保存する', async () => {
    const { db } = createTestApp({ exec: ghOk }).deps
    const prId = await linkStalePullRequest(db)

    const { exec, calls } = fakeGh({ title: 'Fix login error handling', state: 'MERGED', isDraft: false })
    const { app } = createTestApp({ exec, db })
    const res = await app.request('/api/pull-requests/refresh-stale', { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data).toEqual({ refreshed: 1, failed: 0 })
    expect(calls.length).toBe(1)
    expect(todoPullRequestRepo.getById(db, prId)).toMatchObject({
      state: 'merged',
      fetchError: null,
    })
  })

  test('取得に失敗しても 200 を返し failed に数える', async () => {
    const { db } = createTestApp({ exec: ghOk }).deps
    const prId = await linkStalePullRequest(db)

    const { app } = createTestApp({ exec: ghFailing, db })
    const res = await app.request('/api/pull-requests/refresh-stale', { method: 'POST' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data).toEqual({ refreshed: 0, failed: 1 })
    // The link itself must survive a failed refresh.
    expect(todoPullRequestRepo.getById(db, prId)).not.toBeNull()
  })
})
