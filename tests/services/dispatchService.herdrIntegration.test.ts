import { describe, expect, test } from 'bun:test'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import { createHerdrClient } from '../../src/herdr/herdrClient'
import { ExecTimeoutError } from '../../src/herdr/exec'
import { dispatchTodo } from '../../src/services/dispatchService'

// Real client + argv-level fake: no Herdr or external agents are launched.
describe('dispatch with the Herdr 0.9.3 prompt contract', () => {
  test.each(['working', 'idle', 'read-error', 'timeout', 'exit2'])(
    'submits once, without extra keys or retyping: %s', async (outcome) => {
      const db = createDatabase(':memory:')
      const todo = todoRepo.create(db, { title: 'test', workspacePath: '/tmp' })
      const calls: string[][] = []
      let submitted = false
      const text = '--日本語の確認 "引用" と \'引用\'\n  空白 - --wait $(echo never) `never`'
      const client = createHerdrClient(async (cmd) => {
        calls.push(cmd)
        const [, group, action] = cmd
        if (group === 'workspace' && action === 'create') {
          return { stdout: JSON.stringify({ result: {
            workspace: { workspace_id: 'w8' }, tab: { tab_id: 'w8:t1' }, root_pane: { pane_id: 'w8:p1' },
          } }), stderr: '', exitCode: 0 }
        }
        if (group === 'api') {
          if (submitted && outcome === 'read-error') throw new Error('snapshot unavailable')
          return { stdout: JSON.stringify({ result: { snapshot: { panes: [{
            pane_id: 'w8:p1', tab_id: 'w8:t1', workspace_id: 'w8',
            agent_status: submitted && outcome === 'working' ? 'working' : 'idle',
          }] } } }), stderr: '', exitCode: 0 }
        }
        if (group === 'agent' && action === 'prompt') {
          expect(cmd).toEqual(['herdr', 'agent', 'prompt', 'w8:p1', text])
          submitted = true
          if (outcome === 'timeout') throw new ExecTimeoutError(cmd, 10_000)
          if (outcome === 'exit2') return { stdout: '{"result":{}}', stderr: 'rejected', exitCode: 2 }
        } else if (!((group === 'pane' && action === 'run') || (group === 'workspace' && action === 'close'))) {
          throw new Error(`Unexpected command: ${cmd}`)
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      }, 'herdr')
      try {
        const pending = dispatchTodo(db, client, todo.id, {
          claudeBin: 'mock-agent', promptBody: text, sleep: async () => {},
          settleMs: 0, deliveryConfirmTimeoutMs: 0,
        })
        if (outcome === 'exit2') {
          await expect(pending).rejects.toThrow(/exit 2.*rejected/)
          expect(todoRepo.getById(db, todo.id)?.herdrPaneId).toBeNull()
        } else {
          const result = await pending
          expect(result.promptDelivered).toBe(outcome === 'working')
          expect(result.herdrPaneId).toBe('w8:p1')
          expect(calls.some(c => c[2] === 'close')).toBe(false)
        }
        expect(calls.filter(c => c[1] === 'agent')).toHaveLength(1)
        expect(calls.some(c => c[2] === 'send-keys')).toBe(false)
      } finally { db.close() }
    }
  )
})


test('concurrent requests for one TODO create and submit only once', async () => {
  const db = createDatabase(':memory:')
  const todo = todoRepo.create(db, { title: 'test', workspacePath: '/tmp' })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let creates = 0
  let prompts = 0
  const client = createHerdrClient(async cmd => {
    if (cmd[1] === 'workspace') {
      creates++
      await gate
      return { stdout: JSON.stringify({ result: {
        workspace: { workspace_id: 'w1' }, tab: { tab_id: 'w1:t1' }, root_pane: { pane_id: 'w1:p1' },
      } }), stderr: '', exitCode: 0 }
    }
    if (cmd[1] === 'api') return { stdout: JSON.stringify({ result: { snapshot: { panes: [{
      pane_id: 'w1:p1', agent_status: prompts ? 'working' : 'idle',
    }] } } }), stderr: '', exitCode: 0 }
    if (cmd[1] === 'agent') prompts++
    return { stdout: '', stderr: '', exitCode: 0 }
  }, 'herdr')
  const options = { claudeBin: 'mock-agent', sleep: async () => {}, settleMs: 0 }
  const first = dispatchTodo(db, client, todo.id, options)
  await expect(dispatchTodo(db, client, todo.id, options)).rejects.toThrow(/in progress/)
  release()
  await first
  expect(creates).toBe(1)
  expect(prompts).toBe(1)
  db.close()
})
