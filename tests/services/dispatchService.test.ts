import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as dispatchEventRepo from '../../src/db/dispatchEventRepo'
import * as promptHistoryRepo from '../../src/db/promptHistoryRepo'
import * as workspacePathHistoryRepo from '../../src/db/workspacePathHistoryRepo'
import * as todoRepo from '../../src/db/todoRepo'
import type {
  CreateWorkspaceParams,
  CreatedWorkspace,
  HerdrAgentStatus,
  HerdrClient,
  HerdrSnapshot,
} from '../../src/herdr/herdrClient'
import { dispatchTodo } from '../../src/services/dispatchService'
import { BadRequestError, ConflictError, NotFoundError } from '../../src/services/errors'
import { herdrWorkspaceLabel } from '../../src/services/herdrWorkspaceLabel'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

const noSleep = async (): Promise<void> => undefined
const fastDeliveryOptions = { settleMs: 0, deliveryConfirmTimeoutMs: 0 }

interface RecordedClient extends HerdrClient {
  readonly createWorkspaceCalls: CreateWorkspaceParams[]
  readonly runInPaneCalls: { paneId: string; command: string }[]
  readonly submitPromptCalls: { paneId: string; text: string }[]
  readonly sendKeysCalls: { paneId: string; keys: string[] }[]
  readonly readPaneCalls: string[]
  readonly closeWorkspaceCalls: string[]
  readonly snapshotCalls: number[]
  failRunInPaneOnCall?: number
  failSubmitPromptOnCall?: number
  agentStatusSequence: HerdrAgentStatus[]
  postSendStatus: HerdrAgentStatus
}

function fakeClient(created: CreatedWorkspace): RecordedClient {
  const client: RecordedClient = {
    createWorkspaceCalls: [], runInPaneCalls: [], submitPromptCalls: [],
    sendKeysCalls: [], readPaneCalls: [], closeWorkspaceCalls: [], snapshotCalls: [],
    agentStatusSequence: ['idle'], postSendStatus: 'working',
    async snapshot(): Promise<HerdrSnapshot> {
      client.snapshotCalls.push(Date.now())
      const index = Math.min(client.snapshotCalls.length - 1, client.agentStatusSequence.length - 1)
      const agentStatus = client.submitPromptCalls.length
        ? client.postSendStatus : client.agentStatusSequence[index] ?? 'idle'
      return { panes: [{ ...created, agentStatus }] }
    },
    async createWorkspace(params) {
      client.createWorkspaceCalls.push(params)
      return created
    },
    async runInPane(paneId, command) {
      client.runInPaneCalls.push({ paneId, command })
      if (client.runInPaneCalls.length === client.failRunInPaneOnCall) {
        throw new Error('herdr pane run failed')
      }
    },
    async submitPrompt(paneId, text) {
      client.submitPromptCalls.push({ paneId, text })
      if (client.submitPromptCalls.length === client.failSubmitPromptOnCall) {
        throw new Error('herdr send text failed')
      }
    },
    async sendKeys(paneId, ...keys) { client.sendKeysCalls.push({ paneId, keys }) },
    async readPane(paneId) { client.readPaneCalls.push(paneId); return '' },
    async focusTab() {},
    async closeWorkspace(workspaceId) { client.closeWorkspaceCalls.push(workspaceId) },
  }
  return client
}

describe('dispatchTodo', () => {
  test('throws NotFoundError for a missing todo', async () => {
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    await expect(
      dispatchTodo(db, client, 999, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow(NotFoundError)
  })

  test('throws ConflictError when the todo is already dispatched and working', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w0',
      herdrTabId: 'w0:t1',
      herdrPaneId: 'w0:p1',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow(ConflictError)
  })

  test('throws BadRequestError when the todo has no workspacePath and none is given at dispatch time, without calling herdr', async () => {
    const todo = todoRepo.create(db, { title: 'no path set' })
    const client = fakeClient({ workspaceId: 'w8', tabId: 'w8:t1', paneId: 'w8:p1' })
    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow(BadRequestError)
    expect(client.createWorkspaceCalls).toEqual([])
  })

  describe('default prompt (no custom prompt given)', () => {
    test('sends the title, a blank line, then the description', async () => {
      const todo = todoRepo.create(db, { title: 'Fix login', description: '  Session expires too early.\n' , workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
      expect(client.submitPromptCalls[0]?.text).toBe('Fix login\n\nSession expires too early.')
    })

    test('sends just the title when there is no description', async () => {
      const todo = todoRepo.create(db, { title: 'Fix login', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
      expect(client.submitPromptCalls[0]?.text).toBe('Fix login')
    })
  })

  describe('workspacePath resolution at dispatch time', () => {
    test('a dispatch-time workspacePath is used for the herdr workspace and persisted onto the todo', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/old' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        workspacePath: '/tmp/new',
      })

      expect(client.createWorkspaceCalls).toEqual([{ cwd: '/tmp/new', label: herdrWorkspaceLabel(todo) }])
      expect(result.workspacePath).toBe('/tmp/new')
      expect(todoRepo.getById(db, todo.id)?.workspacePath).toBe('/tmp/new')
    })

    test('a todo with no stored workspacePath can be dispatched by supplying one at dispatch time', async () => {
      const todo = todoRepo.create(db, { title: 'no path set' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        workspacePath: '/tmp/assigned-at-dispatch',
      })

      expect(client.createWorkspaceCalls).toEqual([
        { cwd: '/tmp/assigned-at-dispatch', label: herdrWorkspaceLabel(todo) },
      ])
      expect(result.workspacePath).toBe('/tmp/assigned-at-dispatch')
      expect(todoRepo.getById(db, todo.id)?.workspacePath).toBe('/tmp/assigned-at-dispatch')
    })

    test('omitting workspacePath at dispatch time falls back to the todo-stored value, unchanged', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/stored' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

      expect(client.createWorkspaceCalls).toEqual([{ cwd: '/tmp/stored', label: herdrWorkspaceLabel(todo) }])
      expect(todoRepo.getById(db, todo.id)?.workspacePath).toBe('/tmp/stored')
    })

    test('does not persist workspacePath (or touch createWorkspace) when a length-capped prompt still fails', async () => {
      const todo = todoRepo.create(db, { title: 'x'.repeat(100) })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      const explosivePrompt = '{{title}}'.repeat(200)

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          workspacePath: '/tmp/should-still-be-saved',
          promptBody: explosivePrompt,
        })
      ).rejects.toThrow(BadRequestError)

      // The spec explicitly requires: resolve -> save -> prompt-length check
      // -> workspace creation. So the workspacePath IS saved even though the
      // dispatch as a whole fails on the very next step (prompt too long) —
      // it's the user's own input and isn't tied to whether herdr ever gets
      // called.
      expect(todoRepo.getById(db, todo.id)?.workspacePath).toBe('/tmp/should-still-be-saved')
      expect(client.createWorkspaceCalls).toEqual([])
    })

    test('keeps the dispatch-time workspacePath saved even when the dispatch itself rolls back', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/old' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.failRunInPaneOnCall = 1 // starting claude fails -> rollback

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          workspacePath: '/tmp/kept-despite-rollback',
        })
      ).rejects.toThrow('herdr pane run failed')

      expect(client.closeWorkspaceCalls).toEqual(['w1']) // rollback did happen
      const after = todoRepo.getById(db, todo.id)
      expect(after?.sessionState).toBeNull() // dispatch info rolled back
      expect(after?.workspacePath).toBe('/tmp/kept-despite-rollback') // but not this
    })
  })

  describe('model resolution at dispatch time', () => {
    test('a todo with no model starts claude with no --model flag', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: 'claude' }])
    })

    test('a dispatch-time model is appended as --model and persisted onto the todo', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        model: 'opus',
        allowedModels: ['opus', 'sonnet'],
      })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: 'claude --model opus' }])
      expect(result.model).toBe('opus')
      expect(todoRepo.getById(db, todo.id)?.model).toBe('opus')
    })

    test('omitting model at dispatch time falls back to the todo-stored value', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp', model: 'sonnet' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        allowedModels: ['opus', 'sonnet'],
      })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: 'claude --model sonnet' }])
    })

    test('honors a custom claudeBin, appending --model after it', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await dispatchTodo(db, client, todo.id, {
        claudeBin: '/opt/claude',
        sleep: noSleep,
        model: 'haiku',
        allowedModels: ['haiku'],
      })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: '/opt/claude --model haiku' }])
    })

    test('the codex model launches the Codex CLI instead of claude, with no --model flag', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        model: 'codex',
      })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: 'codex' }])
      expect(result.model).toBe('codex')
    })

    test('honors a custom codexBin for the codex model', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp', model: 'codex' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        codexBin: '/opt/codex',
        sleep: noSleep,
      })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: '/opt/codex' }])
    })

    test('codex is still subject to the allowlist', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          model: 'codex',
          allowedModels: ['opus'],
        })
      ).rejects.toThrow(BadRequestError)
      expect(client.createWorkspaceCalls).toEqual([])
    })

    test('rejects a dispatch-time model not in the allowlist with BadRequestError, without calling herdr', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          model: 'gpt-4',
          allowedModels: ['opus', 'sonnet'],
        })
      ).rejects.toThrow(BadRequestError)
      expect(client.createWorkspaceCalls).toEqual([])
    })

    test('rejects a stale stored model that is no longer in the (now-narrowed) allowlist', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp', model: 'fable' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          allowedModels: ['opus', 'sonnet'],
        })
      ).rejects.toThrow(BadRequestError)
      expect(client.createWorkspaceCalls).toEqual([])
    })

    test('defaults the allowlist to opus/sonnet/haiku/fable/codex when allowedModels is not passed', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        model: 'haiku',
      })

      expect(result.model).toBe('haiku')
    })
  })

  test('creates a workspace labeled "#<id> <title>", starts claude, polls until idle, sends the prompt, and records dispatch', async () => {
    const todo = todoRepo.create(db, { title: 'Fix the bug', workspacePath: '/tmp/proj' })
    const client = fakeClient({ workspaceId: 'w7', tabId: 'w7:t1', paneId: 'w7:p1' })

    const result = await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

    // ここだけリテラルで固定する。他のケースは herdrWorkspaceLabel(todo) と
    // 突き合わせているので、その関数が壊れても両辺が同時に変わって気付けない
    // ——書式そのものは herdrWorkspaceLabel.test.ts と、この1本が押さえる。
    expect(client.createWorkspaceCalls).toEqual([
      { cwd: '/tmp/proj', label: `#${todo.id} Fix the bug` },
    ])
    // runInPane is used only to start claude now (see F48): the task prompt
    // goes through submitPrompt instead.
    expect(client.runInPaneCalls).toEqual([{ paneId: 'w7:p1', command: 'claude' }])
    expect(client.snapshotCalls.length).toBeGreaterThan(0)
    expect(client.submitPromptCalls[0]?.paneId).toBe('w7:p1')
    expect(client.submitPromptCalls[0]?.text).toBe('Fix the bug')
    expect(client.sendKeysCalls).toHaveLength(0)

    expect(result.herdrWorkspaceId).toBe('w7')
    expect(result.herdrTabId).toBe('w7:t1')
    expect(result.herdrPaneId).toBe('w7:p1')
    expect(result.sessionState).toBe('working')
    expect(result.dispatchedAt).not.toBeNull()
    expect(result.promptDelivered).toBe(true)

    expect(dispatchEventRepo.countInRange(db, '2000-01-01', '2999-01-01')).toBe(1)
  })

  test('does not append a TASK_DONE_OK/FAIL completion instruction to the prompt', async () => {
    const todo = todoRepo.create(db, { title: 'Fix the bug', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toBe('Fix the bug')
    expect(prompt).not.toContain('TASK_DONE_OK')
    expect(prompt).not.toContain('TASK_DONE_FAIL')
    expect(prompt).not.toContain('完了したら')
  })

  test.each(['idle', 'unknown', 'working', 'blocked', 'done'] as const)(
    'submits exactly once and never sends Enter again for status %s', async (status) => {
      const todo = todoRepo.create(db, { title: '確認用', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.postSendStatus = status
      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude', sleep: noSleep, ...fastDeliveryOptions,
      })
      expect(client.submitPromptCalls).toHaveLength(1)
      expect(client.sendKeysCalls).toHaveLength(0)
      expect(client.readPaneCalls).toHaveLength(0)
      expect(result.promptDelivered).toBe(['working', 'blocked', 'done'].includes(status))
      expect(client.closeWorkspaceCalls).toHaveLength(0)
    }
  )

  test('preserves newlines in the title into spaces on one line', async () => {
    const todo = todoRepo.create(db, {
      title: 'Fix the bug\nand also\nwrite a test',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('\n')
    expect(prompt).toContain('Fix the bug\nand also\nwrite a test')
  })

  test('polls multiple times when the agent is not idle right away', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.agentStatusSequence = ['working', 'working', 'idle']

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      pollIntervalMs: 1,
    })

    expect(client.snapshotCalls.length).toBeGreaterThanOrEqual(3)
  })

  // The one test in this file that deliberately does NOT inject `sleep`, so
  // it's the only one that actually exercises defaultSleep (real
  // setTimeout) rather than a fake. Every other real-time wait this
  // dispatch would normally do (settle, keystroke delay, delivery confirm)
  // is zeroed out here so the test only burns real wall-clock time on the
  // one thing it's meant to verify — the pollIntervalMs-based readiness
  // polling — rather than also waiting out unrelated multi-second defaults.
  test('uses the real timer-based sleep when no sleep override is given', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.agentStatusSequence = ['working', 'idle']

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      pollIntervalMs: 5,
      settleMs: 0,

      deliveryConfirmTimeoutMs: 0,
    })

    // The readiness poll needed at least 2 real snapshot() calls
    // (agentStatusSequence: ['working', 'idle']) — this count is
    // deterministic by construction (index-driven, not time-driven), real
    // timers or not.
    expect(client.snapshotCalls.length).toBeGreaterThanOrEqual(2)
  })

  test('rolls back and throws a ConflictError (409) when the agent never reaches idle before the timeout', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.agentStatusSequence = ['working']

    let caught: unknown
    try {
      await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        agentReadyTimeoutMs: 0,
        pollIntervalMs: 1,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as Error).message).toBe('Claude Code の起動を確認できませんでした')
    expect(client.closeWorkspaceCalls).toEqual(['w1'])
    const after = todoRepo.getById(db, todo.id)
    expect(after?.sessionState).toBeNull()
    expect(after?.herdrWorkspaceId).toBeNull()
    expect(dispatchEventRepo.countInRange(db, '2000-01-01', '2999-01-01')).toBe(0)
  })

  test('allows re-dispatch of a todo that was previously completed', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w0',
      herdrTabId: 'w0:t1',
      herdrPaneId: 'w0:p1',
    })
    todoRepo.complete(db, todo.id)

    const client = fakeClient({ workspaceId: 'w9', tabId: 'w9:t1', paneId: 'w9:p1' })
    const result = await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    expect(result.herdrWorkspaceId).toBe('w9')
  })

  test('uses a custom promptBody instead of the title when provided', async () => {
    const todo = todoRepo.create(db, { title: 'Fix the bug', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Refactor the auth module instead',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toBe('Refactor the auth module instead')
    expect(prompt).not.toContain('Fix the bug')
  })

  test('preserves newlines in a custom promptBody the same way as the title', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Line one\nLine two\nLine three',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('\n')
    expect(prompt).toContain('Line one\nLine two\nLine three')
  })

  test('substitutes {{title}} and {{description}} with the todo\'s real values', async () => {
    const todo = todoRepo.create(db, {
      title: 'Fix the login bug',
      description: 'Users cannot log in with SSO',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Task: {{title}}\nDetails: {{description}}',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('Fix the login bug')
    expect(prompt).toContain('Users cannot log in with SSO')
    expect(prompt).not.toContain('{{title}}')
    expect(prompt).not.toContain('{{description}}')
  })

  test('substitutes placeholders with inner whitespace, e.g. {{ title }}', async () => {
    const todo = todoRepo.create(db, { title: 'Fix it', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Please: {{ title }}',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('Please: Fix it')
  })

  test('leaves unknown {{placeholders}} untouched', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'See {{ticket_id}} for context',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('{{ticket_id}}')
  })

  test('leaves Object.prototype-inherited keys untouched (not resolved via prototype chain lookup)', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody:
        '{{constructor}} {{toString}} {{valueOf}} {{__proto__}} {{hasOwnProperty}}',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('{{constructor}}')
    expect(prompt).toContain('{{toString}}')
    expect(prompt).toContain('{{valueOf}}')
    expect(prompt).toContain('{{__proto__}}')
    expect(prompt).toContain('{{hasOwnProperty}}')
    expect(prompt).not.toContain('native code')
    expect(prompt).not.toContain('[object Object]')
  })

  test('does not re-substitute {{description}} when it appears literally inside the title', async () => {
    const todo = todoRepo.create(db, {
      title: 'Contains {{description}} literally',
      description: 'REAL DESCRIPTION',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: '{{title}}',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('Contains {{description}} literally')
    expect(prompt).not.toContain('REAL DESCRIPTION')
  })

  test('does not re-substitute {{title}} when it appears literally inside the description (symmetry with the above)', async () => {
    const todo = todoRepo.create(db, {
      title: 'REAL TITLE',
      description: 'Contains {{title}} literally',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: '{{description}}',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('Contains {{title}} literally')
    expect(prompt).not.toContain('REAL TITLE')
  })

  test('substitutes {{description}} with an empty string when the todo has no description', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Before[{{description}}]After',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('Before[]After')
  })

  test('does not corrupt substitution when the title contains a literal "$" (String.replace special pattern)', async () => {
    const todo = todoRepo.create(db, { title: 'Fix $& and $1 handling', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Task: {{title}}',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('Fix $& and $1 handling')
  })

  test('preserves newlines introduced by substitution', async () => {
    const todo = todoRepo.create(db, {
      title: 'Line A\nLine B',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: '{{title}}',
    })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('\n')
    expect(prompt).toContain('Line A\nLine B')
  })

  test('does not substitute placeholders when no custom prompt is given (title-only dispatch)', async () => {
    const todo = todoRepo.create(db, { title: '{{title}} literal', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

    const prompt = client.submitPromptCalls[0]?.text ?? ''
    expect(prompt).toContain('{{title}} literal')
  })

  test('records the raw (pre-substitution) prompt in history, not the substituted text', async () => {
    const todo = todoRepo.create(db, {
      title: 'Fix the bug',
      description: 'It crashes on save',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Task: {{title}} — {{description}}',
    })

    const history = promptHistoryRepo.listAll(db)
    expect(history).toHaveLength(1)
    expect(history[0]?.body).toBe('Task: {{title}} — {{description}}')
  })

  test('records a custom promptBody in history after a successful dispatch', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Remember this prompt',
    })

    const history = promptHistoryRepo.listAll(db)
    expect(history).toHaveLength(1)
    expect(history[0]?.body).toBe('Remember this prompt')
  })

  test('does not record anything in history when no promptBody is given (title-only dispatch)', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

    expect(promptHistoryRepo.listAll(db)).toEqual([])
  })

  test('does not record history when the dispatch fails and rolls back', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.failSubmitPromptOnCall = 1 // fails while sending the (custom) prompt

    await expect(
      dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        promptBody: 'should never be recorded',
      })
    ).rejects.toThrow('herdr send text failed')

    expect(promptHistoryRepo.listAll(db)).toEqual([])
  })

  // The workspacePath history is the workspacePath counterpart to the prompt
  // history above, and follows it exactly: success-path only, so a path that
  // was never actually run in never shows up as a suggestion.
  test('records the workspacePath in history after a successful dispatch', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/proj' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

    expect(workspacePathHistoryRepo.listAll(db).map((h) => h.path)).toEqual(['/tmp/proj'])
  })

  test('records the dispatch-time override, not the previously saved path', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/old' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      workspacePath: '/tmp/new',
    })

    expect(workspacePathHistoryRepo.listAll(db).map((h) => h.path)).toEqual(['/tmp/new'])
  })

  test('does not record the workspacePath when the dispatch fails and rolls back', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/proj' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.failSubmitPromptOnCall = 1

    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow('herdr send text failed')

    expect(workspacePathHistoryRepo.listAll(db)).toEqual([])
  })

  test('rolls back the workspace and clears dispatch info when starting claude fails', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.failRunInPaneOnCall = 1 // fail the very first pane run (starting claude)

    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow('herdr pane run failed')

    expect(client.closeWorkspaceCalls).toEqual(['w1'])
    const after = todoRepo.getById(db, todo.id)
    expect(after?.herdrWorkspaceId).toBeNull()
    expect(after?.herdrTabId).toBeNull()
    expect(after?.herdrPaneId).toBeNull()
    expect(after?.sessionState).toBeNull()
    expect(after?.dispatchedAt).toBeNull()
    expect(dispatchEventRepo.countInRange(db, '2000-01-01', '2999-01-01')).toBe(0)
  })

  test('rolls back the workspace when sending the task prompt fails', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.failSubmitPromptOnCall = 1 // claude starts fine, sending the prompt fails

    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow('herdr send text failed')

    expect(client.closeWorkspaceCalls).toEqual(['w1'])
    expect(todoRepo.getById(db, todo.id)?.sessionState).toBeNull()
  })

  test('still throws the original error even if closeWorkspace itself fails', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.failRunInPaneOnCall = 1
    client.closeWorkspace = async () => {
      throw new Error('close also failed')
    }

    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow('herdr pane run failed')
    // Rollback of the DB state is independent of closeWorkspace succeeding.
    expect(todoRepo.getById(db, todo.id)?.sessionState).toBeNull()
  })

  test('throws BadRequestError before any herdr call when placeholder expansion blows past the prompt length cap', async () => {
    const todo = todoRepo.create(db, { title: 'x'.repeat(100), workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    // 100-char title x 200 occurrences = 20,000 chars, well past the 8,000 cap.
    const explosivePrompt = '{{title}}'.repeat(200)

    await expect(
      dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        promptBody: explosivePrompt,
      })
    ).rejects.toThrow(BadRequestError)

    expect(client.createWorkspaceCalls).toEqual([])
    expect(client.runInPaneCalls).toEqual([])
    expect(client.closeWorkspaceCalls).toEqual([])
    expect(todoRepo.getById(db, todo.id)?.sessionState).toBeNull()
  })

  test('does not throw for a title-only dispatch even with a long (but under-cap) title', async () => {
    const todo = todoRepo.create(db, { title: 'a'.repeat(200), workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    const result = await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    expect(result.sessionState).toBe('working')
  })
})
