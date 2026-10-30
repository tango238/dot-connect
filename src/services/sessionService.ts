import type { Database } from 'bun:sqlite'
import * as todoRepo from '../db/todoRepo'
import type { ExecFn } from '../herdr/exec'
import type { HerdrClient } from '../herdr/herdrClient'
import type { Todo } from '../types'
import { BadRequestError, ConflictError, NotFoundError } from './errors'
import { assertWipAvailable } from './wipLimitService'

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
  await activateTerminal(options)

  return todo
}

// herdr のタブにフォーカスしても、ターミナルアプリ自体が前に出るわけでは
// ないので、設定があればアプリを activate する。
export async function activateTerminal(options: OpenSessionOptions): Promise<void> {
  if (options.terminalApp === null) return
  await options.exec(
    ['osascript', '-e', `tell application "${options.terminalApp}" to activate`],
    { timeoutMs: 5000 }
  )
}

// ---------------------------------------------------------------------------
// herdr セッション側からの紐づけ
//
// dot-connect が開いたのではない、既に動いている herdr のペイン(例: ユーザーが
// 自分で開いた Claude Code セッション)を TODO のセッションとして記録する。
// 紐づけた後は dispatch したセッションと同じ扱い —— 「セッションを開く」・
// statusSync・WIP の数え方・削除時のガード・完了時の close がそのまま効く。
//
// ペインは herdr に実在し、エージェントが検知されているものに限る。herdr が
// 'unknown'(エージェント無し)と言うペインを受け付けても statusSync が猶予後に
// 紐づけを外すだけなので、黙って消えるより最初から断る。

export interface AttachSessionInput {
  readonly paneId: string
  /** 指定したときだけ herdr の実測値と照合する(食い違えば 400)。 */
  readonly tabId?: string
  readonly workspaceId?: string
}

export const SESSION_LINKED_ELSEWHERE_MESSAGE =
  'このTODOには別のherdrセッションが紐づいています。先にそのセッションを終了するか紐づけを外してください'

function assertIdMatches(label: string, expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new BadRequestError(`${label} が herdr の情報と一致しません(指定: ${expected}, 実際: ${actual})`)
  }
}

export async function attachSession(
  db: Database,
  herdr: HerdrClient,
  todoId: number,
  input: AttachSessionInput
): Promise<Todo> {
  const todo = todoRepo.getById(db, todoId)
  if (todo === null) {
    throw new NotFoundError(`Todo ${todoId} not found`)
  }
  if (todo.status === 'done') {
    throw new ConflictError('完了済みのTODOにはセッションを紐づけられません。先に未完了に戻してください', {
      code: 'todo_done',
    })
  }
  // Grill のセッションは TODO のセッションそのもの。別のペインを上書きすると
  // Grilled 押下時にそのペインを閉じてしまう。
  if (todo.grillDir !== null) {
    throw new ConflictError('Grill 中のTODOには紐づけられません。先に Grilled を押して内容を確定してください', {
      code: 'grill_in_progress',
    })
  }

  const snapshot = await herdr.snapshot()
  const pane = snapshot.panes.find((p) => p.paneId === input.paneId)
  if (pane === undefined) {
    throw new NotFoundError(`herdr にペイン ${input.paneId} が見つかりません`)
  }
  assertIdMatches('tabId', input.tabId, pane.tabId)
  assertIdMatches('workspaceId', input.workspaceId, pane.workspaceId)
  if (pane.agentStatus === 'unknown') {
    throw new ConflictError(
      `herdr がペイン ${input.paneId} でエージェントを検知していません。Claude Code / Codex が動いているペインを指定してください`,
      { code: 'agent_not_detected' }
    )
  }

  if (todo.herdrPaneId !== null && todo.herdrPaneId !== input.paneId) {
    const currentAlive = snapshot.panes.some((p) => p.paneId === todo.herdrPaneId)
    if (currentAlive) {
      throw new ConflictError(SESSION_LINKED_ELSEWHERE_MESSAGE, { code: 'session_alive' })
    }
    // 紐づけ先のペインが既に無い(statusSync がまだ拾っていない)なら上書きしてよい。
  }

  const owner = todoRepo.findByHerdrPaneId(db, input.paneId)
  if (owner !== null && owner.id !== todoId) {
    throw new ConflictError(`このherdrセッションは既に TODO #${owner.id} 「${owner.title}」に紐づいています`, {
      code: 'pane_in_use',
      todoId: owner.id,
    })
  }

  assertWipAvailable(db, todoId, [], '紐づけ')

  return todoRepo.attachSession(
    db,
    todoId,
    { herdrWorkspaceId: pane.workspaceId, herdrTabId: pane.tabId, herdrPaneId: pane.paneId },
    pane.agentStatus
  )
}

// 紐づけだけを外す。herdr のペインには触らない(閉じない)。
// 投入の記録(dispatched_at)は残す —— clearSessionIfWorkspace の注記を参照。
export function detachSession(db: Database, todoId: number): Todo {
  const todo = todoRepo.getById(db, todoId)
  if (todo === null) {
    throw new NotFoundError(`Todo ${todoId} not found`)
  }
  if (todo.grillDir !== null) {
    throw new ConflictError('Grill 中のTODOのセッションは外せません。先に Grilled を押して内容を確定してください', {
      code: 'grill_in_progress',
    })
  }
  if (todo.herdrWorkspaceId === null) {
    return todo
  }
  todoRepo.clearSessionIfWorkspace(db, todoId, todo.herdrWorkspaceId)
  return todoRepo.getById(db, todoId) ?? todo
}
