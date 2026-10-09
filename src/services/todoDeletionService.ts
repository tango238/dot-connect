import type { Database } from 'bun:sqlite'
import * as todoRepo from '../db/todoRepo'
import type { HerdrClient } from '../herdr/herdrClient'
import { logger } from '../logger'
import { ConflictError } from './errors'

// herdr セッションが生きているTODOは消させない。消すと紐付けだけが失われ、
// ペインは誰の管理下にも無いまま動き続ける —— 先にセッションを終了してもらう。
//
// 保存された紐付けは statusSync の最後の観測でしかないので、herdr に聞き直す。
// ペインが既に無ければ古い紐付けを外して削除を通す。herdr に聞けなかったら
// 消さない(fail closed)。生きているかを確認できないまま孤児を作らないため。

export const SESSION_ALIVE_MESSAGE =
  'herdrセッションが残っているため削除できません。先にセッションを終了してから削除してください'

export async function assertNoLiveSession(db: Database, herdr: HerdrClient, todoId: number): Promise<void> {
  const todo = todoRepo.getById(db, todoId)
  if (todo === null || todo.herdrPaneId === null) {
    return
  }
  const paneId = todo.herdrPaneId
  let alive: boolean
  try {
    const snapshot = await herdr.snapshot()
    alive = snapshot.panes.some((pane) => pane.paneId === paneId)
  } catch (err) {
    logger.warn('Could not check the herdr pane of a todo being deleted; refusing', {
      todoId,
      paneId,
      message: err instanceof Error ? err.message : String(err),
    })
    throw new ConflictError(
      'herdrセッションの状態を確認できないため削除できません。herdr を起動してから再度お試しください',
      { code: 'session_unverified' }
    )
  }
  if (alive) {
    throw new ConflictError(SESSION_ALIVE_MESSAGE, { code: 'session_alive' })
  }
  todoRepo.clearDispatch(db, todoId)
}
