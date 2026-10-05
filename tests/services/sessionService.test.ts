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
