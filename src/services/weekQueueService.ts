import type { Database } from 'bun:sqlite'
import * as todoRepo from '../db/todoRepo'
import * as weekQueueRepo from '../db/weekQueueRepo'
import type { Todo } from '../types'
import { NotFoundError } from './errors'
import { addDaysLocal } from './localDate'

// 「今週終わらせるタスク」の一覧。週に入れた TODO には必ず期日が付く ——
// 無ければその週の日曜(週末)を自動で入れる。既に期日があればそのまま
// (来週の期日でも動かさない。動かすなら一覧の期日欄で)。

// 一覧の 1 行: TODO と、herdr に投入する対象か(週ごとの印)。
export type QueuedTodo = Todo & { readonly dispatch: boolean }

export interface WeekQueue {
  readonly weekStart: string
  readonly weekEnd: string
  readonly todos: readonly QueuedTodo[]
}

export function weekEndOf(weekStart: string): string {
  return addDaysLocal(weekStart, 6)
}

export function listQueue(db: Database, weekStart: string): WeekQueue {
  const todos: QueuedTodo[] = []
  for (const entry of weekQueueRepo.listEntries(db, weekStart)) {
    const todo = todoRepo.getById(db, entry.todoId)
    if (todo) todos.push({ ...todo, dispatch: entry.dispatch })
  }
  return { weekStart, weekEnd: weekEndOf(weekStart), todos }
}

/** herdr に投入する対象かを切り替える。その週に無ければ false。 */
export function setQueueDispatch(db: Database, weekStart: string, todoId: number, dispatch: boolean): boolean {
  return weekQueueRepo.setDispatch(db, weekStart, todoId, dispatch)
}

/**
 * その TODO を herdr に投入する対象にするか(週の一覧の「herdr」「自分」の印)。
 * TODO 側の明示指定(dispatchMode)が最優先。無ければ自動: 作業ディレクトリが
 * あるか Grilled 済みなら herdr、どちらも無ければ自分でやるタスク。
 * フロント側の同じ判定は public/js/lib/dispatchMode.js。
 */
export function queueDispatchFor(todo: Pick<Todo, 'dispatchMode' | 'workspacePath' | 'grilledAt'>): boolean {
  if (todo.dispatchMode === 'herdr') return true
  if (todo.dispatchMode === 'self') return false
  return todo.workspacePath !== null || todo.grilledAt !== null
}

/**
 * TODO 側の判定が変わったとき(明示指定・作業ディレクトリ・Grilled)、その TODO が
 * 入っている週の行の印をそろえる。
 * @returns 変えた行数
 */
export function syncQueueDispatch(db: Database, todo: Todo): number {
  return weekQueueRepo.setDispatchForTodo(db, todo.id, queueDispatchFor(todo))
}

/**
 * 週に足す(既にあれば並びも herdr の印も変えない)。期日が無ければ週末を入れる。
 * dispatch(herdr に投入する対象か)を省くと queueDispatchFor(TODO 側の判定)
 * になる。
 * @throws NotFoundError TODO が無いとき
 */
export function addToQueue(db: Database, weekStart: string, todoId: number, dispatch?: boolean): Todo {
  const todo = todoRepo.getById(db, todoId)
  if (todo === null) {
    throw new NotFoundError(`Todo ${todoId} not found`)
  }
  weekQueueRepo.add(db, weekStart, todoId, dispatch ?? queueDispatchFor(todo))
  if (todo.dueDate === null) {
    return todoRepo.update(db, todoId, { dueDate: weekEndOf(weekStart) }) ?? todo
  }
  return todo
}

export function removeFromQueue(db: Database, weekStart: string, todoId: number): boolean {
  return weekQueueRepo.remove(db, weekStart, todoId)
}

export function reorderQueue(db: Database, weekStart: string, todoIds: readonly number[]): WeekQueue {
  weekQueueRepo.reorder(db, weekStart, todoIds)
  return listQueue(db, weekStart)
}
