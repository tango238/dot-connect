import { describe, expect, test } from 'bun:test'
import * as milestoneRepo from '../../src/db/milestoneRepo'
import * as todoRepo from '../../src/db/todoRepo'
import type { ExecFn } from '../../src/herdr/exec'
import { createTestApp, readJson } from './testApp'

const REPO = 'acme/my-app'

function issueJson(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: 'OPEN',
    url: `https://github.com/${REPO}/issues/${number}`,
    labels: [],
    updatedAt: '2026-10-20T00:00:00Z',
    ...extra,
  }
}

// gh のフェイク。`issue list` には配列、`issue view <n>` にはその1件を返す。
// 実際の出力形状は src/services/githubIssueService.ts に合わせること。
function fakeGh(numbers: number[], failing: number[] = []): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = []
  const exec: ExecFn = async (cmd) => {
    calls.push(cmd)
    if (cmd[2] === 'list') {
      return { stdout: JSON.stringify(numbers.map((n) => issueJson(n))), stderr: '', exitCode: 0 }
    }
    const number = Number(cmd[3])
    if (failing.includes(number)) {
      return { stdout: '', stderr: `GraphQL: Could not resolve to an Issue with the number of ${number}`, exitCode: 1 }
    }
    return { stdout: JSON.stringify(issueJson(number)), stderr: '', exitCode: 0 }
  }
  return { exec, calls }
}

const ghFailing: ExecFn = async () => ({ stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login', exitCode: 4 })

function post(app: { request: (i: string, init?: RequestInit) => Promise<Response> }, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/github/issues', () => {
  test('lists the repository\'s open issues by default', async () => {
    const { exec, calls } = fakeGh([12, 13])
    const { app } = createTestApp({ exec })
    const res = await app.request(`/api/github/issues?repo=${encodeURIComponent(REPO)}`)
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.repo).toBe(REPO)
    expect(body.data.issues.map((i: { number: number }) => i.number)).toEqual([12, 13])
    expect(body.data.issues[0]).toMatchObject({ title: 'Issue 12', state: 'open', url: `https://github.com/${REPO}/issues/12` })
    expect(calls[0]).toContain('--state')
    expect(calls[0]![calls[0]!.indexOf('--state') + 1]).toBe('open')
    expect(calls[0]![calls[0]!.indexOf('--limit') + 1]).toBe('50')
  })

  test('accepts a GitHub URL as the repo and passes state/limit/search through', async () => {
    const { exec, calls } = fakeGh([])
    const { app } = createTestApp({ exec })
    const res = await app.request(
      `/api/github/issues?repo=${encodeURIComponent('https://github.com/acme/my-app/issues')}&state=all&limit=10&search=login`
    )
    expect(res.status).toBe(200)
    expect((await readJson(res)).data.repo).toBe(REPO)
    const cmd = calls[0]!
    expect(cmd[cmd.indexOf('-R') + 1]).toBe(REPO)
    expect(cmd[cmd.indexOf('--state') + 1]).toBe('all')
    expect(cmd[cmd.indexOf('--limit') + 1]).toBe('10')
    expect(cmd[cmd.indexOf('--search') + 1]).toBe('login')
  })

  test.each([
    ['missing repo', '/api/github/issues'],
    ['malformed repo', `/api/github/issues?repo=${encodeURIComponent('not a repo')}`],
    ['another host', `/api/github/issues?repo=${encodeURIComponent('https://gitlab.com/a/b')}`],
    ['bad state', `/api/github/issues?repo=a/b&state=merged`],
    ['limit too large', `/api/github/issues?repo=a/b&limit=201`],
  ])('rejects %s with 400 without calling gh', async (_label, path) => {
    const { exec, calls } = fakeGh([12])
    const { app } = createTestApp({ exec })
    const res = await app.request(path)
    expect(res.status).toBe(400)
    expect(calls.length).toBe(0)
  })

  test("surfaces gh's failure as 502 with gh's own message", async () => {
    const { app } = createTestApp({ exec: ghFailing })
    const res = await app.request(`/api/github/issues?repo=${REPO}`)
    const body = await readJson(res)
    expect(res.status).toBe(502)
    expect(body.code).toBe('gh_failed')
    expect(body.error).toContain('gh auth login')
  })
})

describe('POST /api/github/issues/import', () => {
  test('creates one TODO per issue, with the URL on the description\'s first line', async () => {
    const { exec, calls } = fakeGh([12, 13])
    const { app, deps } = createTestApp({ exec })
    const res = await post(app, '/api/github/issues/import', { repo: REPO, numbers: [12, 13] })
    const body = await readJson(res)

    expect(res.status).toBe(201)
    expect(body.data.repo).toBe(REPO)
    expect(body.data.failed).toEqual([])
    expect(body.data.created.map((t: { title: string }) => t.title)).toEqual(['Issue 12', 'Issue 13'])
    expect(body.data.created[0].description).toBe(`https://github.com/${REPO}/issues/12\n\nBody 12`)
    expect(todoRepo.listAll(deps.db).length).toBe(2)
    // One `gh issue view` per issue, nothing else.
    expect(calls.map((c) => c.slice(1, 4))).toEqual([['issue', 'view', '12'], ['issue', 'view', '13']])
  })

  test('applies milestone, priority, workspacePath and model to every created TODO', async () => {
    const { exec } = fakeGh([12, 13])
    const { app, deps } = createTestApp({ exec })
    const ms = milestoneRepo.create(deps.db, { title: 'v1', startDate: '2026-10-01', targetDate: '2026-10-31' })
    const res = await post(app, '/api/github/issues/import', {
      repo: REPO,
      numbers: [12, 13],
      milestoneId: ms.id,
      priority: 'high',
      workspacePath: '/Users/me/my-app',
      model: 'opus',
    })
    expect(res.status).toBe(201)
    for (const todo of todoRepo.listAll(deps.db)) {
      expect(todo).toMatchObject({ milestoneId: ms.id, priority: 'high', workspacePath: '/Users/me/my-app', model: 'opus' })
    }
  })

  test('keeps going past one failed issue and reports it alongside what was created', async () => {
    const { exec } = fakeGh([12, 13, 14], [13])
    const { app, deps } = createTestApp({ exec })
    const res = await post(app, '/api/github/issues/import', { repo: REPO, numbers: [12, 13, 14] })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.created.map((t: { title: string }) => t.title)).toEqual(['Issue 12', 'Issue 14'])
    expect(body.data.failed).toEqual([{ number: 13, error: expect.stringContaining('13') }])
    expect(todoRepo.listAll(deps.db).length).toBe(2)
  })

  test('returns 200 with nothing created when every issue fails', async () => {
    const { app, deps } = createTestApp({ exec: ghFailing })
    const res = await post(app, '/api/github/issues/import', { repo: REPO, numbers: [12] })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.created).toEqual([])
    expect(body.data.failed.length).toBe(1)
    expect(todoRepo.listAll(deps.db).length).toBe(0)
  })

  test.each([
    ['no numbers', { repo: REPO, numbers: [] }],
    ['duplicate numbers', { repo: REPO, numbers: [12, 12] }],
    ['non-positive number', { repo: REPO, numbers: [0] }],
    ['too many numbers', { repo: REPO, numbers: Array.from({ length: 51 }, (_, i) => i + 1) }],
    ['malformed repo', { repo: 'nope', numbers: [12] }],
    ['relative workspacePath', { repo: REPO, numbers: [12], workspacePath: 'relative/path' }],
  ])('rejects %s with 400 without calling gh', async (_label, body) => {
    const { exec, calls } = fakeGh([12])
    const { app } = createTestApp({ exec })
    const res = await post(app, '/api/github/issues/import', body)
    expect(res.status).toBe(400)
    expect(calls.length).toBe(0)
  })

  test('rejects a model outside the allowlist with 400', async () => {
    const { exec, calls } = fakeGh([12])
    const { app } = createTestApp({ exec })
    const res = await post(app, '/api/github/issues/import', { repo: REPO, numbers: [12], model: 'gpt-9' })
    expect(res.status).toBe(400)
    expect(calls.length).toBe(0)
  })

  test('rejects a deleted milestone with 404 before touching gh', async () => {
    const { exec, calls } = fakeGh([12])
    const { app } = createTestApp({ exec })
    const res = await post(app, '/api/github/issues/import', { repo: REPO, numbers: [12], milestoneId: 999 })
    expect(res.status).toBe(404)
    expect(calls.length).toBe(0)
  })
})
