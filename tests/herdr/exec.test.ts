import { describe, expect, test } from 'bun:test'
import { ExecTimeoutError, spawnExec } from '../../src/herdr/exec'

// spawnExec is the real Bun.spawn-backed implementation. It is only ever
// exercised here with harmless commands (echo/false/sleep) — never herdr or
// claude.
describe('spawnExec', () => {
  test('captures stdout and a zero exit code', async () => {
    const result = await spawnExec(['echo', 'hello'])
    expect(result.stdout.trim()).toBe('hello')
    expect(result.exitCode).toBe(0)
  })

  test('captures a non-zero exit code', async () => {
    const result = await spawnExec(['false'])
    expect(result.exitCode).not.toBe(0)
  })

  test('resolves normally when the command finishes before the timeout', async () => {
    const result = await spawnExec(['echo', 'fast'], { timeoutMs: 5000 })
    expect(result.stdout.trim()).toBe('fast')
  })

  test('rejects with ExecTimeoutError when the command exceeds the timeout', async () => {
    await expect(spawnExec(['sleep', '2'], { timeoutMs: 100 })).rejects.toThrow(ExecTimeoutError)
  })
})
