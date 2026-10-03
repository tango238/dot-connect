import { describe, expect, test } from 'bun:test'
import type { ExecFn, ExecResult } from '../../src/herdr/exec'
import { createFetchPullRequest } from '../../src/services/githubPrService'

const URL = 'https://github.com/o/r/pull/7'

function execReturning(result: Partial<ExecResult>): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = []
  const exec: ExecFn = async (cmd) => {
    calls.push(cmd)
    return { stdout: '', stderr: '', exitCode: 0, ...result }
  }
  return { exec, calls }
}

describe('createFetchPullRequest', () => {
  test('invokes the configured gh binary with the PR URL and requested fields', async () => {
    const { exec, calls } = execReturning({
      stdout: JSON.stringify({ title: 't', state: 'OPEN', isDraft: false }),
    })
    await createFetchPullRequest(exec, '/opt/gh')(URL)
    expect(calls).toEqual([['/opt/gh', 'pr', 'view', URL, '--json', 'title,state,isDraft']])
  })

  test.each([
    ['OPEN', 'open'],
    ['CLOSED', 'closed'],
    // Merged is preserved rather than folded into "closed" — it's the whole
    // point of showing the state.
    ['MERGED', 'merged'],
  ] as const)('maps gh state %s to %s', async (ghState, expected) => {
    const { exec } = execReturning({
      stdout: JSON.stringify({ title: 'Fix it', state: ghState, isDraft: false }),
    })
    const result = await createFetchPullRequest(exec, 'gh')(URL)
    expect(result).toEqual({ ok: true, snapshot: { title: 'Fix it', state: expected, isDraft: false } })
  })

  test('reports draft PRs as draft', async () => {
    const { exec } = execReturning({
      stdout: JSON.stringify({ title: 'WIP', state: 'OPEN', isDraft: true }),
    })
    const result = await createFetchPullRequest(exec, 'gh')(URL)
    expect(result).toEqual({ ok: true, snapshot: { title: 'WIP', state: 'open', isDraft: true } })
  })

  test("surfaces gh's own stderr on a non-zero exit rather than a generic message", async () => {
    const { exec } = execReturning({ exitCode: 1, stderr: 'gh: no pull requests found' })
    const result = await createFetchPullRequest(exec, 'gh')(URL)
    expect(result).toEqual({ ok: false, error: 'gh: no pull requests found' })
  })

  test('falls back to the exit code when gh writes nothing to stderr', async () => {
    const { exec } = execReturning({ exitCode: 4 })
    const result = await createFetchPullRequest(exec, 'gh')(URL)
    expect(result).toEqual({ ok: false, error: 'exit code 4' })
  })

  // A missing gh binary makes Bun.spawn throw rather than exit non-zero, so
  // the thrown case has to be handled too — and must NOT propagate, because
  // the caller still wants to store the URL.
  test('returns a failure (never throws) when gh cannot be run at all', async () => {
    const exec: ExecFn = async () => {
      throw new Error('ENOENT: no such file or directory')
    }
    const result = await createFetchPullRequest(exec, 'gh')(URL)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('ENOENT')
  })

  test('reports unparseable output as a failure', async () => {
    const { exec } = execReturning({ stdout: 'not json' })
    const result = await createFetchPullRequest(exec, 'gh')(URL)
    expect(result).toEqual({ ok: false, error: 'gh の出力を解釈できませんでした' })
  })

  test('reports output missing title/state as a failure', async () => {
    const { exec } = execReturning({ stdout: JSON.stringify({ isDraft: false }) })
    const result = await createFetchPullRequest(exec, 'gh')(URL)
    expect(result.ok).toBe(false)
  })

  test('rejects an unrecognized state rather than storing it', async () => {
    const { exec } = execReturning({ stdout: JSON.stringify({ title: 't', state: 'WEIRD' }) })
    const result = await createFetchPullRequest(exec, 'gh')(URL)
    expect(result.ok).toBe(false)
  })

  test('truncates a runaway error so it cannot be stored wholesale', async () => {
    const { exec } = execReturning({ exitCode: 1, stderr: 'x'.repeat(5000) })
    const result = await createFetchPullRequest(exec, 'gh')(URL)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.length).toBeLessThanOrEqual(301)
  })
})
