import { describe, expect, test } from 'bun:test'
import type { ExecFn, ExecOptions, ExecResult } from '../../src/herdr/exec'
import { HerdrCommandError, createHerdrClient } from '../../src/herdr/herdrClient'

function jsonResult(id: string, result: unknown): ExecResult {
  return { stdout: JSON.stringify({ id, result }), stderr: '', exitCode: 0 }
}

function jsonError(id: string, code: string, message: string): ExecResult {
  return { stdout: JSON.stringify({ id, error: { code, message } }), stderr: '', exitCode: 1 }
}

// This is what herdr *actually* returns on success for "action" commands
// (pane run, tab focus, workspace close): nothing at all. Using jsonResult()
// here instead — as an earlier version of these tests did — hid the real
// bug: runHerdr required a JSON envelope unconditionally, so every real
// successful dispatch was misclassified as a failure and rolled back.
function voidSuccess(): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0 }
}

function fakeExec(handler: (cmd: string[], options?: ExecOptions) => ExecResult): ExecFn {
  return async (cmd, options) => handler(cmd, options)
}

describe('herdrClient.snapshot', () => {
  test('parses panes from the session snapshot', async () => {
    const exec = fakeExec((cmd) => {
      expect(cmd).toEqual(['herdr', 'api', 'snapshot'])
      return jsonResult('cli:api:snapshot', {
        type: 'session_snapshot',
        snapshot: {
          panes: [
            { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent_status: 'working' },
            { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2', agent_status: 'unknown' },
          ],
        },
      })
    })
    const client = createHerdrClient(exec, 'herdr')
    const snapshot = await client.snapshot()
    expect(snapshot.panes).toEqual([
      { paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'working' },
      { paneId: 'w2:p1', tabId: 'w2:t1', workspaceId: 'w2', agentStatus: 'unknown' },
    ])
  })

  test('throws a descriptive HerdrCommandError when herdr reports an error', async () => {
    const exec = fakeExec(() => jsonError('cli:api:snapshot', 'server_unreachable', 'no server'))
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.snapshot()).rejects.toThrow(/no server/)
    await expect(client.snapshot()).rejects.toBeInstanceOf(HerdrCommandError)
  })

  test('throws when stdout is not valid JSON', async () => {
    const exec: ExecFn = async () => ({ stdout: 'not json', stderr: '', exitCode: 0 })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.snapshot()).rejects.toThrow()
  })

  test('still requires a JSON payload even when stdout is empty (a query command has no valid "no payload" case)', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: '', exitCode: 0 })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.snapshot()).rejects.toBeInstanceOf(HerdrCommandError)
  })

  test('passes the configured timeout through to exec, default 10s', async () => {
    const seen: (ExecOptions | undefined)[] = []
    const exec = fakeExec((_cmd, options) => {
      seen.push(options)
      return jsonResult('x', { snapshot: { panes: [] } })
    })
    const client = createHerdrClient(exec, 'herdr')
    await client.snapshot()
    expect(seen[0]?.timeoutMs).toBe(10_000)
  })

  test('honors a custom timeoutMs passed to createHerdrClient', async () => {
    const seen: (ExecOptions | undefined)[] = []
    const exec = fakeExec((_cmd, options) => {
      seen.push(options)
      return jsonResult('x', { snapshot: { panes: [] } })
    })
    const client = createHerdrClient(exec, 'herdr', { timeoutMs: 3000 })
    await client.snapshot()
    expect(seen[0]?.timeoutMs).toBe(3000)
  })
})

describe('herdrClient.createWorkspace', () => {
  test('sends --cwd/--label/--no-focus and extracts ids', async () => {
    const exec = fakeExec((cmd) => {
      expect(cmd).toEqual([
        'herdr',
        'workspace',
        'create',
        '--cwd',
        '/tmp/proj',
        '--label',
        'dc-42',
        '--no-focus',
      ])
      return jsonResult('cli:workspace:create', {
        type: 'workspace_created',
        workspace: { workspace_id: 'w9' },
        tab: { tab_id: 'w9:t1' },
        root_pane: { pane_id: 'w9:p1' },
      })
    })
    const client = createHerdrClient(exec, 'herdr')
    const created = await client.createWorkspace({ cwd: '/tmp/proj', label: 'dc-42' })
    expect(created).toEqual({ workspaceId: 'w9', tabId: 'w9:t1', paneId: 'w9:p1' })
  })

  test('propagates herdr errors', async () => {
    const exec = fakeExec(() =>
      jsonError('cli:workspace:create', 'invalid_cwd', 'path does not exist')
    )
    const client = createHerdrClient(exec, 'herdr')
    await expect(
      client.createWorkspace({ cwd: '/nope', label: 'dc-1' })
    ).rejects.toThrow(/path does not exist/)
  })
})

describe('herdrClient.runInPane', () => {
  test('sends the pane run command; herdr returns empty stdout on success', async () => {
    const exec = fakeExec((cmd) => {
      expect(cmd).toEqual(['herdr', 'pane', 'run', 'w9:p1', 'claude'])
      return voidSuccess()
    })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.runInPane('w9:p1', 'claude')).resolves.toBeUndefined()
  })

  test('empty stdout with a non-zero exit code is still an error (uses stderr)', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'pane not found', exitCode: 1 })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.runInPane('bad', 'claude')).rejects.toThrow(/pane not found/)
    await expect(client.runInPane('bad', 'claude')).rejects.toBeInstanceOf(HerdrCommandError)
  })

  test('still honors a JSON {error} envelope if herdr emits one for this command', async () => {
    const exec = fakeExec(() => jsonError('cli:pane:run', 'pane_not_found', 'no such pane'))
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.runInPane('bad', 'claude')).rejects.toThrow(/no such pane/)
  })

  test('throws when a void command unexpectedly returns non-empty, non-JSON stdout', async () => {
    const exec: ExecFn = async () => ({ stdout: 'some unexpected banner text', stderr: '', exitCode: 0 })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.runInPane('w9:p1', 'claude')).rejects.toBeInstanceOf(HerdrCommandError)
    await expect(client.runInPane('w9:p1', 'claude')).rejects.toThrow(/unexpected non-JSON output/)
  })
})

describe('herdrClient.submitPrompt', () => {
  test('submits a prompt via herdr agent prompt', async () => {
    const exec = fakeExec((cmd) => {
      expect(cmd).toEqual(['herdr', 'agent', 'prompt', 'w9:p1', 'hello there'])
      return voidSuccess()
    })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.submitPrompt('w9:p1', 'hello there')).resolves.toBeUndefined()
  })

  test('propagates herdr errors', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'pane not found', exitCode: 1 })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.submitPrompt('bad', 'x')).rejects.toThrow(/pane not found/)
  })
})

describe('herdrClient.sendKeys', () => {
  test('sends one or more keys via herdr pane send-keys', async () => {
    const exec = fakeExec((cmd) => {
      expect(cmd).toEqual(['herdr', 'pane', 'send-keys', 'w9:p1', 'Enter'])
      return voidSuccess()
    })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.sendKeys('w9:p1', 'Enter')).resolves.toBeUndefined()
  })

  test('forwards multiple keys in order', async () => {
    const exec = fakeExec((cmd) => {
      expect(cmd).toEqual(['herdr', 'pane', 'send-keys', 'w9:p1', 'Ctrl+A', 'Enter'])
      return voidSuccess()
    })
    const client = createHerdrClient(exec, 'herdr')
    await client.sendKeys('w9:p1', 'Ctrl+A', 'Enter')
  })

  test('propagates herdr errors', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'pane not found', exitCode: 1 })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.sendKeys('bad', 'Enter')).rejects.toThrow(/pane not found/)
  })
})

// Confirmed against real herdr: unlike api/snapshot and workspace/create,
// `pane read` prints the pane's LITERAL text content on stdout — it is NOT
// a JSON envelope. An earlier version of readPane assumed the JSON-envelope
// shape (matching the underlying socket API's PaneReadResult schema) and
// ran real pane content through JSON.parse, which failed every time against
// real herdr despite every fakes-only test passing — the same
// fake-vs-real-behavior gap as the void-command bug documented above.
describe('herdrClient.readPane', () => {
  test('reads the visible pane content via herdr pane read, as literal text (not JSON)', async () => {
    const exec = fakeExec((cmd) => {
      expect(cmd).toEqual(['herdr', 'pane', 'read', 'w9:p1', '--source', 'visible'])
      return { stdout: '❯ some text in the input box', stderr: '', exitCode: 0 }
    })
    const client = createHerdrClient(exec, 'herdr')
    const content = await client.readPane('w9:p1')
    expect(content).toBe('❯ some text in the input box')
  })

  test('returns multi-line pane content unchanged', async () => {
    const exec = fakeExec(() => ({
      stdout: '      225 +        ]);\n      226 +        $this->assertDatabaseHas(\n',
      stderr: '',
      exitCode: 0,
    }))
    const client = createHerdrClient(exec, 'herdr')
    const content = await client.readPane('w9:p1')
    expect(content).toContain('225 +')
    expect(content).toContain('226 +')
  })

  test('returns an empty string when the pane has no visible content', async () => {
    const exec = fakeExec(() => ({ stdout: '', stderr: '', exitCode: 0 }))
    const client = createHerdrClient(exec, 'herdr')
    expect(await client.readPane('w9:p1')).toBe('')
  })

  test('a non-zero exit is an error, using stderr', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'pane not found', exitCode: 1 })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.readPane('bad')).rejects.toThrow(/pane not found/)
    await expect(client.readPane('bad')).rejects.toBeInstanceOf(HerdrCommandError)
  })

  test('does NOT attempt to JSON.parse real pane content, even content that happens to start with a brace', async () => {
    const exec = fakeExec(() => ({
      stdout: '{ this looks like JSON but is just code the user typed }',
      stderr: '',
      exitCode: 0,
    }))
    const client = createHerdrClient(exec, 'herdr')
    const content = await client.readPane('w9:p1')
    expect(content).toBe('{ this looks like JSON but is just code the user typed }')
  })

  test('propagates an error reported via a non-zero exit even when stdout looks like a JSON error envelope', async () => {
    const exec = fakeExec(() => jsonError('cli:pane:read', 'pane_not_found', 'no such pane'))
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.readPane('bad')).rejects.toThrow(/no such pane/)
    await expect(client.readPane('bad')).rejects.toBeInstanceOf(HerdrCommandError)
  })

  test('defensive fallback: honors a JSON {error} envelope even if printed with exit 0', async () => {
    const exec = fakeExec(() => ({
      stdout: JSON.stringify({ id: 'x', error: { code: 'pane_not_found', message: 'no such pane' } }),
      stderr: '',
      exitCode: 0,
    }))
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.readPane('bad')).rejects.toThrow(/no such pane/)
    await expect(client.readPane('bad')).rejects.toBeInstanceOf(HerdrCommandError)
  })
})

describe('herdrClient.focusTab', () => {
  test('sends the tab focus command; herdr returns empty stdout on success', async () => {
    const exec = fakeExec((cmd) => {
      expect(cmd).toEqual(['herdr', 'tab', 'focus', 'w9:t1'])
      return voidSuccess()
    })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.focusTab('w9:t1')).resolves.toBeUndefined()
  })

  test('empty stdout with a non-zero exit code is an error', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'tab not found', exitCode: 1 })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.focusTab('bad')).rejects.toThrow(/tab not found/)
  })
})

describe('herdrClient.closeWorkspace', () => {
  test('sends the workspace close command; herdr returns empty stdout on success', async () => {
    const exec = fakeExec((cmd) => {
      expect(cmd).toEqual(['herdr', 'workspace', 'close', 'w9'])
      return voidSuccess()
    })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.closeWorkspace('w9')).resolves.toBeUndefined()
  })

  test('empty stdout with a non-zero exit code is an error', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'workspace not found', exitCode: 1 })
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.closeWorkspace('bad')).rejects.toThrow(/workspace not found/)
  })

  test('still honors a JSON {error} envelope if herdr emits one for this command', async () => {
    const exec = fakeExec(() =>
      jsonError('cli:workspace:close', 'workspace_not_found', 'no such workspace')
    )
    const client = createHerdrClient(exec, 'herdr')
    await expect(client.closeWorkspace('bad')).rejects.toThrow(/no such workspace/)
  })
})
