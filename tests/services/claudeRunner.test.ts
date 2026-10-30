import { describe, expect, test } from 'bun:test'
import type { ExecFn, ExecOptions } from '../../src/herdr/exec'
import { createClaudeRunner } from '../../src/services/claudeRunner'

const aggregate = {
  weekStart: '2026-07-20',
  weekEnd: '2026-07-26',
  completedCount: 5,
  milestoneLinkedCount: 3,
  unplannedCount: 2,
  dispatchCount: 4,
}

function outerEnvelope(resultText: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ result: resultText, is_error: false, ...extra })
}

describe('createClaudeRunner tidyGoal', () => {
  test('sends the goal after the tidy instructions and returns the plain result text', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd)
      return { stdout: outerEnvelope('- 検索を出す\n- CI を速く\n'), stderr: '', exitCode: 0 }
    }
    const runner = createClaudeRunner(exec, 'claude')
    const tidied = await runner.tidyGoal('検索を出す。CIを速く。')
    expect(tidied).toBe('- 検索を出す\n- CI を速く')
    const prompt = calls[0]?.[2] ?? ''
    expect(prompt).toContain('内容・意図・約束している範囲を変えずに')
    expect(prompt.endsWith('検索を出す。CIを速く。')).toBe(true)
    expect(calls[0]).toContain('--output-format')
  })

  test('unwraps a code fence the model wrapped the text in', async () => {
    const exec: ExecFn = async () => ({
      stdout: outerEnvelope('```markdown\n- a\n- b\n```'),
      stderr: '',
      exitCode: 0,
    })
    expect(await createClaudeRunner(exec, 'claude').tidyGoal('a b')).toBe('- a\n- b')
  })

  test('fails on an empty result or a claude-reported error', async () => {
    const empty: ExecFn = async () => ({ stdout: outerEnvelope('   '), stderr: '', exitCode: 0 })
    await expect(createClaudeRunner(empty, 'claude').tidyGoal('a')).rejects.toThrow('empty result')
    const errored: ExecFn = async () => ({ stdout: outerEnvelope('nope', { is_error: true }), stderr: '', exitCode: 0 })
    await expect(createClaudeRunner(errored, 'claude').tidyGoal('a')).rejects.toThrow('reported an error')
  })
})

describe('createClaudeRunner', () => {
  test('invokes claude -p with --output-format json and parses the inner result JSON', async () => {
    const calls: { cmd: string[]; options?: ExecOptions }[] = []
    const exec: ExecFn = async (cmd, options) => {
      calls.push({ cmd, options })
      return {
        stdout: outerEnvelope(
          JSON.stringify({
            summary: 'Solid week',
            warnings: ['low dispatch count'],
            suggestions: ['dispatch more'],
          })
        ),
        stderr: '',
        exitCode: 0,
      }
    }
    const runner = createClaudeRunner(exec, 'claude')
    const analysis = await runner.analyze(aggregate)

    expect(calls[0]?.cmd[0]).toBe('claude')
    expect(calls[0]?.cmd).toContain('-p')
    expect(calls[0]?.cmd).toContain('--output-format')
    expect(calls[0]?.cmd).toContain('json')
    expect(calls[0]?.options?.timeoutMs).toBe(120_000)
    expect(analysis).toEqual({
      summary: 'Solid week',
      warnings: ['low dispatch count'],
      suggestions: ['dispatch more'],
    })
  })

  test('honors a custom timeoutMs', async () => {
    const calls: { options?: ExecOptions }[] = []
    const exec: ExecFn = async (_cmd, options) => {
      calls.push({ options })
      return {
        stdout: outerEnvelope('{"summary":"s","warnings":[],"suggestions":[]}'),
        stderr: '',
        exitCode: 0,
      }
    }
    const runner = createClaudeRunner(exec, 'claude', { timeoutMs: 5000 })
    await runner.analyze(aggregate)
    expect(calls[0]?.options?.timeoutMs).toBe(5000)
  })

  test('strips a code fence and leading prose from the inner result before parsing', async () => {
    const exec: ExecFn = async () => ({
      stdout: outerEnvelope(
        'Here is the analysis:\n```json\n{"summary":"ok","warnings":[],"suggestions":["a"]}\n```'
      ),
      stderr: '',
      exitCode: 0,
    })
    const runner = createClaudeRunner(exec, 'claude')
    const analysis = await runner.analyze(aggregate)
    expect(analysis).toEqual({ summary: 'ok', warnings: [], suggestions: ['a'] })
  })

  test('throws when claude exits non-zero', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'boom', exitCode: 1 })
    const runner = createClaudeRunner(exec, 'claude')
    await expect(runner.analyze(aggregate)).rejects.toThrow(/boom/)
  })

  test('throws when the outer envelope is not valid JSON', async () => {
    const exec: ExecFn = async () => ({ stdout: 'not json at all', stderr: '', exitCode: 0 })
    const runner = createClaudeRunner(exec, 'claude')
    await expect(runner.analyze(aggregate)).rejects.toThrow()
  })

  test('throws when the outer envelope has no result field', async () => {
    const exec: ExecFn = async () => ({
      stdout: JSON.stringify({ foo: 'bar' }),
      stderr: '',
      exitCode: 0,
    })
    const runner = createClaudeRunner(exec, 'claude')
    await expect(runner.analyze(aggregate)).rejects.toThrow(/result/)
  })

  test('throws when claude reports is_error: true', async () => {
    const exec: ExecFn = async () => ({
      stdout: JSON.stringify({ result: 'rate limited', is_error: true }),
      stderr: '',
      exitCode: 0,
    })
    const runner = createClaudeRunner(exec, 'claude')
    await expect(runner.analyze(aggregate)).rejects.toThrow(/rate limited/)
  })

  test('throws when the inner result is not valid JSON', async () => {
    const exec: ExecFn = async () => ({
      stdout: outerEnvelope('nope, not json'),
      stderr: '',
      exitCode: 0,
    })
    const runner = createClaudeRunner(exec, 'claude')
    await expect(runner.analyze(aggregate)).rejects.toThrow()
  })

  test('throws when the parsed inner JSON is missing required fields', async () => {
    const exec: ExecFn = async () => ({
      stdout: outerEnvelope(JSON.stringify({ summary: 'x' })),
      stderr: '',
      exitCode: 0,
    })
    const runner = createClaudeRunner(exec, 'claude')
    await expect(runner.analyze(aggregate)).rejects.toThrow()
  })
})
