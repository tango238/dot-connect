import { describe, expect, test } from 'bun:test'
import { buildPromptArgs, verifyPromptParser } from '../../src/herdr/promptArgs'
import { createHerdrClient } from '../../src/herdr/herdrClient'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import { dispatchTodo } from '../../src/services/dispatchService'

const samples = ['日本語 "引用" \'引用\'\n  空白 - --wait', '-先頭', '--help', '--wait', '--', '--session literal text']
test.each(samples)('keeps target/text in exact positional slots: %s', text => {
  expect(buildPromptArgs('herdr', 'wB:p1', text)).toEqual(['herdr', 'agent', 'prompt', 'wB:p1', text])
})

describe('unsupported global option values', () => {
  test.each(['--session', '--session=test', '--remote', '--remote=x', '--remote-keybindings', '--remote-keybindings=local', '--handoff', 'NUL\0text'])(
    'rejects %s before creating a workspace or executing the CLI', async text => {
      let calls = 0
      const client = createHerdrClient(async () => { calls++; throw new Error('must not execute') }, 'herdr')
      await expect(client.submitPrompt('wB:p1', text)).rejects.toThrow()
      const db = createDatabase(':memory:')
      try {
        const todo = todoRepo.create(db, { title: 'test', workspacePath: '/tmp' })
        await expect(dispatchTodo(db, client, todo.id, { claudeBin: 'mock', promptBody: text })).rejects.toThrow()
        expect(calls).toBe(0)
        expect(todoRepo.getById(db, todo.id)?.herdrPaneId).toBeNull()
      } finally { db.close() }
    }
  )
})

test('probe rejects a shifted text argument and isolates all executions from the live socket', async () => {
  let calls = 0
  const verified = await verifyPromptParser(async (cmd, options) => {
    calls++
    expect(cmd[3]).toBe('wTEST:pTEST')
    expect(options?.env?.HERDR_SOCKET_PATH).toEndWith('/absent.sock')
    return { stdout: '', stderr: 'unknown option: misplaced prompt', exitCode: 2 }
  }, 'herdr', 3000)
  expect(verified).toBe(false)
  expect(calls).toBe(1)
})
