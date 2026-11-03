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
 * 週に足す(既にあれば並びも herdr の印も変えない)。期日が無ければ週末を入れる。
 * dispatch(herdr に投入する対象か)を省くと、Grilled 済みなら true、Grill を
 * 通していなければ false(自分でやるタスク)になる —— Grill 無しで登録できる
 * のは herdr に流さないものだから。
 * @throws NotFoundError TODO が無いとき
 */
export function addToQueue(db: Database, weekStart: string, todoId: number, dispatch?: boolean): Todo {
  const todo = todoRepo.getById(db, todoId)
  if (todo === null) {
    throw new NotFoundError(`Todo ${todoId} not found`)
  }
  weekQueueRepo.add(db, weekStart, todoId, dispatch ?? todo.grilledAt !== null)
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
