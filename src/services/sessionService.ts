import type { Database } from 'bun:sqlite'
import * as todoRepo from '../db/todoRepo'
import type { ExecFn } from '../herdr/exec'
import type { HerdrClient } from '../herdr/herdrClient'
import type { Todo } from '../types'
import { NotFoundError } from './errors'

export interface OpenSessionOptions {
  readonly terminalApp: string | null
  readonly exec: ExecFn
}

export async function openSession(
  db: Database,
  herdr: HerdrClient,
  todoId: number,
  options: OpenSessionOptions
): Promise<Todo> {
  const todo = todoRepo.getById(db, todoId)
  if (todo === null) {
    throw new NotFoundError(`Todo ${todoId} not found`)
  }
  if (todo.herdrTabId === null) {
    throw new NotFoundError(`Todo ${todoId} has no active herdr session`)
  }

  await herdr.focusTab(todo.herdrTabId)

  if (options.terminalApp !== null) {
    await options.exec(
      ['osascript', '-e', `tell application "${options.terminalApp}" to activate`],
      { timeoutMs: 5000 }
    )
  }

  return todo
}
