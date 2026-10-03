import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import type { ExecFn, ExecOptions, ExecResult } from '../../src/herdr/exec'
import { createHerdrClient } from '../../src/herdr/herdrClient'
import { dispatchTodo } from '../../src/services/dispatchService'

// Regression coverage for the real bug: dispatchService.test.ts's fakeClient
// implements HerdrClient's methods directly and never goes through
// herdrClient.ts's runHerdr* parsing at all, so it could never have caught
// this. This suite instead wraps the REAL createHerdrClient() around a fake
// ExecFn that mimics real herdr's actual CLI contract — including that "pane
// run"/"tab focus"/"workspace close" print nothing at all (empty stdout,
// exit 0) on success. An earlier version of runHerdr required a JSON
// envelope unconditionally, which misclassified every successful dispatch as
// a failure, rolled back the just-created workspace, and returned a 500 to
// the user.

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

const noSleep = async (): Promise<void> => undefined

interface RealisticHerdrExecOptions {
  /** If true, the first Enter does not register: agent status stays 'idle'
   * and `pane read` keeps echoing back the last sent text (as if it's still
   * sitting unsubmitted in the input box) until a SECOND Enter happens —
   * simulating a dropped first Enter that a resend then successfully
   * submits. */
  readonly firstEnterDropped?: boolean
  /** If true, the first `agent send` only partially lands: `pane read` shows
   * a truncated head of it, as a still-initializing TUI does. Long enough to
   * be visible to the post-clear check. The retype after the clear lands
   * whole. */
  readonly firstTypingTruncated?: boolean
}

function realisticHerdrExec(
  options: RealisticHerdrExecOptions = {}
): { exec: ExecFn; calls: { cmd: string[]; options?: ExecOptions }[] } {
  const calls: { cmd: string[]; options?: ExecOptions }[] = []
  // The pane's input box, modelled the same way as the unit-test fake: typing
  // APPENDS, the clear empties it, Enter submits and empties it. Anything
  // less would let a broken clear look fine here.
  let inputBox = ''
  let typedCount = 0
  let enterCount = 0
  let submitted = false

  function promptHasBeenSubmitted(): boolean {
    return submitted
  }

  const exec: ExecFn = async (cmd) => {
    calls.push({ cmd })
    const [, subcommand, action] = cmd

    if (subcommand === 'pane' && action === 'read') {
      // (see the input-box model above for what this reflects)
      // Real herdr: `pane read` prints the pane's literal text content on
      // stdout — NOT a JSON envelope (confirmed against real herdr; see
      // herdrClient.ts's comment on runHerdrText for the full story). This
      // fake existed with the wrong (JSON-envelope) shape before that was
      // caught, which is exactly the kind of fake-vs-real gap this
      // integration suite exists to close.
      return { stdout: inputBox, stderr: '', exitCode: 0 }
    }

    if (subcommand === 'workspace' && action === 'create') {
      const result: ExecResult = {
        stdout: JSON.stringify({
          id: 'cli:workspace:create',
          result: {
            type: 'workspace_created',
            workspace: { workspace_id: 'w1' },
            tab: { tab_id: 'w1:t1' },
            root_pane: { pane_id: 'w1:p1' },
          },
        }),
        stderr: '',
        exitCode: 0,
      }
      return result
    }

    if (subcommand === 'api' && action === 'snapshot') {
      const result: ExecResult = {
        stdout: JSON.stringify({
          id: 'cli:api:snapshot',
          result: {
            snapshot: {
              panes: [
                {
                  pane_id: 'w1:p1',
                  tab_id: 'w1:t1',
                  workspace_id: 'w1',
                  agent_status: promptHasBeenSubmitted() ? 'working' : 'idle',
                },
              ],
            },
          },
        }),
        stderr: '',
        exitCode: 0,
      }
      return result
    }

    if (subcommand === 'pane' && action === 'run') {
      // Real herdr: empty stdout, exit 0, on success. Only used to start
      // claude now — the task prompt goes through `agent send` + `pane
      // send-keys` instead (see below).
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    if (subcommand === 'agent' && action === 'send') {
      const text = cmd[cmd.length - 1] ?? ''
      typedCount += 1
      inputBox += options.firstTypingTruncated && typedCount === 1 ? text.slice(0, 60) : text
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    if (subcommand === 'pane' && action === 'send-keys') {
      if (cmd.includes('Ctrl+u')) {
        inputBox = ''
      }
      // A dropped Enter leaves the text sitting in the box; only the resend
      // actually submits it.
      if (cmd.includes('Enter')) {
        enterCount += 1
        if (inputBox !== '' && enterCount >= (options.firstEnterDropped ? 2 : 1)) {
          submitted = true
          inputBox = ''
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    if (subcommand === 'workspace' && action === 'close') {
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    throw new Error(`unexpected herdr invocation in test: ${cmd.join(' ')}`)
  }

  return { exec, calls }
}

// Zeroed-out delivery timings so tests run fast: the fake exec above reports
// 'working' as soon as Enter has been pressed, so no real polling wait is
// ever needed for these end-to-end-success tests.
const fastDeliveryOptions = {
  settleMs: 0,
  keystrokeDelayBaseMs: 0,
  keystrokeDelayPerCharMs: 0,
  keystrokeDelayMaxMs: 0,
  deliveryConfirmTimeoutMs: 0,
}

describe('dispatchTodo with the real herdrClient (regression: empty-stdout success)', () => {
  test('a full dispatch succeeds end-to-end against a fake ExecFn that mimics real herdr output', async () => {
    const todo = todoRepo.create(db, { title: 'Fix the bug', workspacePath: '/tmp/proj' })
    const { exec, calls } = realisticHerdrExec()
    const herdr = createHerdrClient(exec, 'herdr')

    const result = await dispatchTodo(db, herdr, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      ...fastDeliveryOptions,
    })

    expect(result.sessionState).toBe('working')
    expect(result.herdrPaneId).toBe('w1:p1')
    expect(result.promptDelivered).toBe(true)

    // The bug rolled back via `workspace close` after every dispatch; a
    // correctly succeeding dispatch must never call it.
    const closeWorkspaceCalls = calls.filter((c) => c.cmd[1] === 'workspace' && c.cmd[2] === 'close')
    expect(closeWorkspaceCalls).toHaveLength(0)

    const paneRunCalls = calls.filter((c) => c.cmd[1] === 'pane' && c.cmd[2] === 'run')
    expect(paneRunCalls).toHaveLength(1) // starting claude only

    const agentSendCalls = calls.filter((c) => c.cmd[1] === 'agent' && c.cmd[2] === 'send')
    expect(agentSendCalls).toHaveLength(1)
    const sendKeysCalls = calls.filter((c) => c.cmd[1] === 'pane' && c.cmd[2] === 'send-keys')
    expect(sendKeysCalls).toHaveLength(1)
    expect(sendKeysCalls[0]?.cmd).toContain('Enter')
  })

  test('a dispatch with a custom prompt also succeeds end-to-end', async () => {
    const todo = todoRepo.create(db, {
      title: 'x',
      description: 'some detail',
      workspacePath: '/tmp/proj',
    })
    const { exec } = realisticHerdrExec()
    const herdr = createHerdrClient(exec, 'herdr')

    const result = await dispatchTodo(db, herdr, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Task: {{title}} — {{description}}',
      ...fastDeliveryOptions,
    })

    expect(result.sessionState).toBe('working')
    expect(result.promptDelivered).toBe(true)
  })

  // The pre-submit verification, through the REAL herdrClient: the clear has
  // to reach the CLI as an argv herdr actually accepts. Real herdr rejects
  // 'C-u' and 'ctrl-u' with invalid_key — a regression to either spelling
  // would silently leave the truncated text in the box and then retype on
  // top of it, and only an argv-level test can catch that.
  test('a truncated first typing is cleared with Ctrl+u and retyped before Enter is ever sent', async () => {
    const todo = todoRepo.create(db, {
      title: 'Fix the login bug for SSO users, end to end, with regression tests',
      workspacePath: '/tmp/proj',
    })
    const { exec, calls } = realisticHerdrExec({ firstTypingTruncated: true })
    const herdr = createHerdrClient(exec, 'herdr')

    const result = await dispatchTodo(db, herdr, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      ...fastDeliveryOptions,
    })

    expect(result.promptDelivered).toBe(true)

    const agentSendCalls = calls.filter((c) => c.cmd[1] === 'agent' && c.cmd[2] === 'send')
    expect(agentSendCalls).toHaveLength(2) // truncated attempt, then the retype

    const sendKeysCalls = calls.filter((c) => c.cmd[1] === 'pane' && c.cmd[2] === 'send-keys')
    expect(sendKeysCalls).toHaveLength(2)
    expect(sendKeysCalls[0]?.cmd).toContain('Ctrl+u') // the clear, before the retype
    expect(sendKeysCalls[1]?.cmd).toContain('Enter') // submitted only after it landed whole

    // Three reads: verify the truncated typing, verify the clear emptied the
    // box, verify the retype landed whole.
    const paneReadCalls = calls.filter((c) => c.cmd[1] === 'pane' && c.cmd[2] === 'read')
    expect(paneReadCalls).toHaveLength(3)
  })

  // Regression coverage for the real double-send incident, through the
  // REAL herdrClient (not the hand-rolled fake in dispatchService.test.ts):
  // a dropped first Enter must never cause the prompt TEXT to be resent —
  // only a second Enter — even when everything is driven through the
  // genuine `herdr agent send` / `herdr pane send-keys` / `herdr pane read`
  // CLI argv shapes.
  test('a dropped first Enter recovers via a resent Enter only — the prompt text is never sent twice', async () => {
    const todo = todoRepo.create(db, { title: 'Fix the bug', workspacePath: '/tmp/proj' })
    const { exec, calls } = realisticHerdrExec({ firstEnterDropped: true })
    const herdr = createHerdrClient(exec, 'herdr')

    const result = await dispatchTodo(db, herdr, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      ...fastDeliveryOptions,
    })

    expect(result.promptDelivered).toBe(true)

    const agentSendCalls = calls.filter((c) => c.cmd[1] === 'agent' && c.cmd[2] === 'send')
    expect(agentSendCalls).toHaveLength(1) // the actual regression check

    const sendKeysCalls = calls.filter((c) => c.cmd[1] === 'pane' && c.cmd[2] === 'send-keys')
    expect(sendKeysCalls).toHaveLength(2) // Enter, then Enter again

    const paneReadCalls = calls.filter((c) => c.cmd[1] === 'pane' && c.cmd[2] === 'read')
    expect(paneReadCalls.length).toBeGreaterThan(0) // the input box WAS checked
  })
})
