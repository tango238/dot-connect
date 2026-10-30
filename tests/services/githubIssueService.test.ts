import { describe, expect, test } from 'bun:test'
import type { ExecFn, ExecResult } from '../../src/herdr/exec'
import { createFetchIssue, createListIssues, MAX_LIST_LIMIT } from '../../src/services/githubIssueService'

const REPO = 'acme/my-app'

function execReturning(result: Partial<ExecResult>): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = []
  const exec: ExecFn = async (cmd) => {
    calls.push(cmd)
    return { stdout: '', stderr: '', exitCode: 0, ...result }
  }
  return { exec, calls }
}

const ghIssue = {
  number: 12,
  title: 'Login fails on Safari',
  body: 'Steps…',
  state: 'OPEN',
  url: 'https://github.com/acme/my-app/issues/12',
  labels: [{ name: 'bug', color: 'd73a4a' }],
  updatedAt: '2026-10-20T01:02:03Z',
}

describe('createListIssues', () => {
  test('invokes gh issue list with the repo, state, limit and fields', async () => {
    const { exec, calls } = execReturning({ stdout: '[]' })
    await createListIssues(exec, '/opt/gh')(REPO, { state: 'open', limit: 50 })
    expect(calls).toEqual([
      ['/opt/gh', 'issue', 'list', '-R', REPO, '--state', 'open', '--limit', '50', '--json', 'number,title,body,state,url,labels,updatedAt'],
    ])
  })

  test('passes a non-blank search through and drops a blank one', async () => {
    const { exec, calls } = execReturning({ stdout: '[]' })
    const list = createListIssues(exec, 'gh')
    await list(REPO, { state: 'all', limit: 10, search: ' login ' })
    await list(REPO, { state: 'all', limit: 10, search: '   ' })
    expect(calls[0]!.slice(-2)).toEqual(['--search', 'login'])
    expect(calls[1]).not.toContain('--search')
  })

  test('clamps the limit into gh-friendly bounds', async () => {
    const { exec, calls } = execReturning({ stdout: '[]' })
    const list = createListIssues(exec, 'gh')
    await list(REPO, { state: 'open', limit: 10_000 })
    await list(REPO, { state: 'open', limit: 0 })
    expect(calls[0]![calls[0]!.indexOf('--limit') + 1]).toBe(String(MAX_LIST_LIMIT))
    expect(calls[1]![calls[1]!.indexOf('--limit') + 1]).toBe('1')
  })

  test('maps gh issues into summaries, folding state to lower case', async () => {
    const { exec } = execReturning({ stdout: JSON.stringify([ghIssue, { ...ghIssue, number: 13, state: 'CLOSED', body: null, labels: null }]) })
    const result = await createListIssues(exec, 'gh')(REPO, { state: 'all', limit: 50 })
    expect(result).toEqual({
      ok: true,
      issues: [
        {
          number: 12,
          title: 'Login fails on Safari',
          body: 'Steps…',
          state: 'open',
          url: 'https://github.com/acme/my-app/issues/12',
          labels: [{ name: 'bug', color: 'd73a4a' }],
          updatedAt: '2026-10-20T01:02:03Z',
        },
        {
          number: 13,
          title: 'Login fails on Safari',
          body: '',
          state: 'closed',
          url: 'https://github.com/acme/my-app/issues/12',
          labels: [],
          updatedAt: '2026-10-20T01:02:03Z',
        },
      ],
    })
  })

  test('skips entries whose shape it does not recognise rather than failing the list', async () => {
    const { exec } = execReturning({ stdout: JSON.stringify([ghIssue, { title: 'no number' }, null]) })
    const result = await createListIssues(exec, 'gh')(REPO, { state: 'open', limit: 50 })
    expect(result.ok && result.issues.map((i) => i.number)).toEqual([12])
  })

  test("surfaces gh's own stderr on a non-zero exit", async () => {
    const { exec } = execReturning({ exitCode: 1, stderr: 'GraphQL: Could not resolve to a Repository' })
    const result = await createListIssues(exec, 'gh')(REPO, { state: 'open', limit: 50 })
    expect(result).toEqual({ ok: false, error: 'GraphQL: Could not resolve to a Repository' })
  })

  test('returns a failure (never throws) when gh cannot be run at all', async () => {
    const exec: ExecFn = async () => {
      throw new Error('ENOENT: no such file or directory')
    }
    const result = await createListIssues(exec, 'gh')(REPO, { state: 'open', limit: 50 })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('ENOENT')
  })

  test.each([
    ['not json', 'not json'],
    ['an object instead of an array', '{}'],
  ])('reports %s as unparseable', async (_label, stdout) => {
    const { exec } = execReturning({ stdout })
    const result = await createListIssues(exec, 'gh')(REPO, { state: 'open', limit: 50 })
    expect(result).toEqual({ ok: false, error: 'gh の出力を解釈できませんでした' })
  })
})

describe('createFetchIssue', () => {
  test('invokes gh issue view with the number and repo', async () => {
    const { exec, calls } = execReturning({ stdout: JSON.stringify(ghIssue) })
    const result = await createFetchIssue(exec, 'gh')(REPO, 12)
    expect(calls).toEqual([['gh', 'issue', 'view', '12', '-R', REPO, '--json', 'number,title,body,state,url,labels,updatedAt']])
    expect(result.ok && result.issue.title).toBe('Login fails on Safari')
  })

  test('reports output missing the essentials as a failure', async () => {
    const { exec } = execReturning({ stdout: JSON.stringify({ body: 'x' }) })
    const result = await createFetchIssue(exec, 'gh')(REPO, 12)
    expect(result.ok).toBe(false)
  })

  test("surfaces gh's own stderr on a non-zero exit", async () => {
    const { exec } = execReturning({ exitCode: 1, stderr: 'GraphQL: Could not resolve to an Issue' })
    const result = await createFetchIssue(exec, 'gh')(REPO, 999)
    expect(result).toEqual({ ok: false, error: 'GraphQL: Could not resolve to an Issue' })
  })
})
