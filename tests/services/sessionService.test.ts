import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import type { ExecFn } from '../../src/herdr/exec'
import type { HerdrClient } from '../../src/herdr/herdrClient'
import { NotFoundError } from '../../src/services/errors'
import { openSession } from '../../src/services/sessionService'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

function fakeClient(focusTabCalls: string[]): HerdrClient {
  return {
    snapshot: async () => ({ panes: [] }),
    createWorkspace: async () => {
      throw new Error('not used')
    },
    runInPane: async () => undefined,
    submitPrompt: async () => undefined,
    sendKeys: async () => undefined,
    sendText: async () => undefined,
    readPane: async () => '',
    focusTab: async (tabId) => {
      focusTabCalls.push(tabId)
    },
    closeWorkspace: async () => undefined,
  }
}

describe('openSession', () => {
  test('throws NotFoundError for a missing todo', async () => {
    const focusTabCalls: string[] = []
    const client = fakeClient(focusTabCalls)
    const exec: ExecFn = async () => ({ stdout: '', stderr: '', exitCode: 0 })
    await expect(
      openSession(db, client, 999, { terminalApp: null, exec })
    ).rejects.toThrow(NotFoundError)
  })

  test('throws NotFoundError when the todo has no herdr session info', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    const focusTabCalls: string[] = []
    const client = fakeClient(focusTabCalls)
    const exec: ExecFn = async () => ({ stdout: '', stderr: '', exitCode: 0 })
    await expect(
      openSession(db, client, todo.id, { terminalApp: null, exec })
    ).rejects.toThrow(NotFoundError)
  })

  test('focuses the tab and does not shell out when TERMINAL_APP is unset', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })
    const focusTabCalls: string[] = []
    const client = fakeClient(focusTabCalls)
    let execCalled = false
    const exec: ExecFn = async () => {
      execCalled = true
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    const result = await openSession(db, client, todo.id, { terminalApp: null, exec })

    expect(focusTabCalls).toEqual(['w1:t1'])
    expect(execCalled).toBe(false)
    expect(result.id).toBe(todo.id)
  })

  test('activates the terminal app via osascript when TERMINAL_APP is set, with a 5s timeout', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })
    const focusTabCalls: string[] = []
    const client = fakeClient(focusTabCalls)
    const execCalls: { cmd: string[]; options?: { timeoutMs?: number } }[] = []
    const exec: ExecFn = async (cmd, options) => {
      execCalls.push({ cmd, options })
      return { stdout: '', stderr: '', exitCode: 0 }
    }

    await openSession(db, client, todo.id, { terminalApp: 'iTerm', exec })

    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]?.cmd[0]).toBe('osascript')
    expect(execCalls[0]?.cmd.join(' ')).toContain('iTerm')
    expect(execCalls[0]?.options?.timeoutMs).toBe(5000)
  })
})

import type { HerdrPane } from '../../src/herdr/herdrClient'
import { ConflictError, BadRequestError } from '../../src/services/errors'
import { attachSession, detachSession } from '../../src/services/sessionService'
import * as appSettingsRepo from '../../src/db/appSettingsRepo'
import { WIP_LIMIT_ENABLED_KEY, WIP_LIMIT_KEY } from '../../src/services/wipLimitService'

function pane(paneId: string, agentStatus: HerdrPane['agentStatus'] = 'working'): HerdrPane {
  const [workspaceId = 'w'] = paneId.split(':')
  return { paneId, tabId: `${workspaceId}:t1`, workspaceId, agentStatus }
}

function clientWithPanes(panes: HerdrPane[], snapshotError: Error | null = null): HerdrClient {
  return {
    ...fakeClient([]),
    snapshot: async () => {
      if (snapshotError) throw snapshotError
      return { panes }
    },
  }
}

describe('attachSession', () => {
  test('records the pane, its tab/workspace from the snapshot, and the observed agent state', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    const client = clientWithPanes([pane('w9:p3', 'idle')])

    const result = await attachSession(db, client, todo.id, { paneId: 'w9:p3' })

    expect(result.herdrPaneId).toBe('w9:p3')
    expect(result.herdrTabId).toBe('w9:t1')
    expect(result.herdrWorkspaceId).toBe('w9')
    expect(result.sessionState).toBe('idle')
    expect(result.dispatchedAt).not.toBeNull()
  })

  test('throws NotFoundError for a missing todo and for a pane herdr does not know', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    const client = clientWithPanes([pane('w1:p1')])
    await expect(attachSession(db, client, 999, { paneId: 'w1:p1' })).rejects.toThrow(NotFoundError)
    await expect(attachSession(db, client, todo.id, { paneId: 'nope' })).rejects.toThrow(NotFoundError)
  })

  test('rejects tab/workspace ids that disagree with herdr', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    const client = clientWithPanes([pane('w1:p1')])
    await expect(
      attachSession(db, client, todo.id, { paneId: 'w1:p1', tabId: 'other' })
    ).rejects.toThrow(BadRequestError)
    await expect(
      attachSession(db, client, todo.id, { paneId: 'w1:p1', workspaceId: 'other' })
    ).rejects.toThrow(BadRequestError)
    expect(todoRepo.getById(db, todo.id)?.herdrPaneId).toBeNull()
  })

  test('refuses a pane where herdr detects no agent', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    const client = clientWithPanes([pane('w1:p1', 'unknown')])
    const err = await attachSession(db, client, todo.id, { paneId: 'w1:p1' }).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.data?.code).toBe('agent_not_detected')
  })

  test('refuses a done todo and a todo being grilled', async () => {
    const done = todoRepo.create(db, { title: 'done' })
    todoRepo.complete(db, done.id)
    const grilled = todoRepo.create(db, { title: 'grill' })
    todoRepo.setGrillDir(db, grilled.id, '/tmp/grill/todo-' + grilled.id)
    const client = clientWithPanes([pane('w1:p1')])

    const e1 = await attachSession(db, client, done.id, { paneId: 'w1:p1' }).catch((e) => e)
    expect(e1.data?.code).toBe('todo_done')
    const e2 = await attachSession(db, client, grilled.id, { paneId: 'w1:p1' }).catch((e) => e)
    expect(e2.data?.code).toBe('grill_in_progress')
  })

  test('refuses while the todo still has a different, live session; overwrites a stale one', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, { herdrWorkspaceId: 'w1', herdrTabId: 'w1:t1', herdrPaneId: 'w1:p1' })

    const live = clientWithPanes([pane('w1:p1'), pane('w2:p1')])
    const err = await attachSession(db, live, todo.id, { paneId: 'w2:p1' }).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.data?.code).toBe('session_alive')

    const stale = clientWithPanes([pane('w2:p1')])
    const result = await attachSession(db, stale, todo.id, { paneId: 'w2:p1' })
    expect(result.herdrPaneId).toBe('w2:p1')
  })

  test('is idempotent for the pane the todo already holds', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, { herdrWorkspaceId: 'w1', herdrTabId: 'w1:t1', herdrPaneId: 'w1:p1' })
    const client = clientWithPanes([pane('w1:p1', 'blocked')])
    const result = await attachSession(db, client, todo.id, { paneId: 'w1:p1' })
    expect(result.herdrPaneId).toBe('w1:p1')
    expect(result.sessionState).toBe('blocked')
  })

  test('refuses a pane another todo already owns, naming that todo', async () => {
    const owner = todoRepo.create(db, { title: 'owner' })
    todoRepo.markDispatched(db, owner.id, { herdrWorkspaceId: 'w1', herdrTabId: 'w1:t1', herdrPaneId: 'w1:p1' })
    const todo = todoRepo.create(db, { title: 'x' })
    const client = clientWithPanes([pane('w1:p1')])

    const err = await attachSession(db, client, todo.id, { paneId: 'w1:p1' }).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.data).toEqual({ code: 'pane_in_use', todoId: owner.id })
    expect(err.message).toContain(`#${owner.id}`)
  })

  test('honors the WIP limit with a link-specific message', async () => {
    appSettingsRepo.set(db, WIP_LIMIT_ENABLED_KEY, '1')
    appSettingsRepo.set(db, WIP_LIMIT_KEY, '1')
    const busy = todoRepo.create(db, { title: 'busy' })
    todoRepo.markDispatched(db, busy.id, { herdrWorkspaceId: 'w1', herdrTabId: 'w1:t1', herdrPaneId: 'w1:p1' })
    const todo = todoRepo.create(db, { title: 'x' })
    const client = clientWithPanes([pane('w1:p1'), pane('w2:p1')])

    const err = await attachSession(db, client, todo.id, { paneId: 'w2:p1' }).catch((e) => e)
    expect(err.data?.code).toBe('wip_limit_reached')
    expect(err.message).toContain('紐づけできません')
  })

  test('propagates a herdr failure without touching the todo', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    const client = clientWithPanes([], new Error('herdr down'))
    await expect(attachSession(db, client, todo.id, { paneId: 'w1:p1' })).rejects.toThrow('herdr down')
    expect(todoRepo.getById(db, todo.id)?.herdrPaneId).toBeNull()
  })
})

describe('detachSession', () => {
  test('clears the linkage but keeps dispatchedAt, and never talks to herdr', () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, { herdrWorkspaceId: 'w1', herdrTabId: 'w1:t1', herdrPaneId: 'w1:p1' })

    const result = detachSession(db, todo.id)

    expect(result.herdrPaneId).toBeNull()
    expect(result.herdrWorkspaceId).toBeNull()
    expect(result.sessionState).toBeNull()
    expect(result.dispatchedAt).not.toBeNull()
  })

  test('is a no-op for a todo without a session, 404 for a missing todo, 409 while grilling', () => {
    const todo = todoRepo.create(db, { title: 'x' })
    expect(detachSession(db, todo.id).herdrPaneId).toBeNull()
    expect(() => detachSession(db, 999)).toThrow(NotFoundError)
    todoRepo.setGrillDir(db, todo.id, '/tmp/grill/todo-' + todo.id)
    expect(() => detachSession(db, todo.id)).toThrow(ConflictError)
  })
})
