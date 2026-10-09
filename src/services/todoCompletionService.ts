import type { Database } from 'bun:sqlite'
import * as todoRepo from '../db/todoRepo'
import type { HerdrAgentStatus, HerdrClient } from '../herdr/herdrClient'
import { logger } from '../logger'
import type { Todo } from '../types'
import { cleanupGrill } from './grillService'

// TODOを完了にして、その仕事のために開いた herdr のワークスペースを畳む。
//
// 完了は「もう触らない」という宣言なので、終わった仕事のワークスペースが
// 一覧に残り続けるのは邪魔なだけ——だが、閉じるとペインもスクロールバックも
// 走っているプロセスも消える。取り返しがつかないので、判断は fail closed:
// 「終わっていると確認できたときだけ閉じる」であって「動いていなさそうなら
// 閉じる」ではない。

// 閉じてよいペインの状態。allow-list にしているのは、herdr に新しい状態が
// 増えたときに既定で「閉じる」側へ倒れないため。
//
// 'working' を除くのは自明として、'blocked' も閉じない: これは許可ダイアログ
// を出して人の返事を待っているエージェントで(dispatchService の
// isDeliveryConfirmed 参照)、終わった合図ではない。閉じれば作業もダイアログ
// も消える。'unknown'(ペイン内でclaudeが動いていない)も除く——中で何が動いて
// いるか確認できていないため。
const CLOSABLE_STATUSES: readonly HerdrAgentStatus[] = ['idle', 'done']

// 後片付けの対象になりうるペインを返す。null なら何もしない。判定と値の
// 取り出しを1つにしているのは、呼び出し側で非nullアサーションを書かずに
// 済ませるため。ここを通っても閉じるとは限らない(実状態の確認が本番)。
function sessionToClose(before: Todo): { workspaceId: string; paneId: string } | null {
  // 既に done のTODOへの再completeでは何もしない。complete() は working を
  // 'idle' に書き換えるので、2回目には「元は走っていた」が保存値から判別
  // できない —— ✔ のダブルクリックやMCPの二重呼び出しで、走っているClaudeを
  // 殺すことになる。
  if (before.status === 'done') {
    return null
  }
  if (before.herdrWorkspaceId === null || before.herdrPaneId === null) {
    return null
  }
  return { workspaceId: before.herdrWorkspaceId, paneId: before.herdrPaneId }
}

// 保存された session_state は statusSync が最後に回ったときのスナップショット
// でしかない。それを回すのはブラウザのポーリングだけなので、画面を閉じている
// 間やMCP経由の完了では、何時間も前の観測値であり得る。ペインを畳む直前に
// herdr へ聞き直し、確認できなければ閉じない。
async function liveStatusOf(
  herdr: HerdrClient,
  paneId: string,
  todoId: number
): Promise<HerdrAgentStatus | undefined> {
  try {
    const snapshot = await herdr.snapshot()
    return snapshot.panes.find((pane) => pane.paneId === paneId)?.agentStatus
  } catch (err) {
    logger.warn('Could not check the herdr pane of a completed todo; leaving it open', {
      todoId,
      paneId,
      message: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/**
 * @returns 完了後のTODO。該当するTODOが無ければ null。
 */
export async function completeTodo(
  db: Database,
  herdr: HerdrClient,
  todoId: number
): Promise<Todo | null> {
  // 完了「前」の状態を控える: todoRepo.complete は session_state が非NULLなら
  // 'idle' に書き換えるので、完了後に読むと元の状態が分からなくなる。
  const before = todoRepo.getById(db, todoId)
  if (before === null) {
    return null
  }

  const completed = todoRepo.complete(db, todoId)
  if (completed === null) {
    return completed
  }
  // 完了は Grill の放棄でもある。ワークスペースを閉じられたかに関わらず、
  // 一時ディレクトリと grill_dir は片付ける(残すと再オープン後に Grill も
  // 投入もできなくなる)。
  const grillAbandoned = before.grillDir !== null
  if (grillAbandoned) {
    cleanupGrill(db, todoId)
  }
  const afterCleanup = grillAbandoned ? todoRepo.getById(db, todoId) : completed
  const session = sessionToClose(before)
  if (session === null) {
    return afterCleanup
  }

  const { workspaceId, paneId } = session
  const live = await liveStatusOf(herdr, paneId, todoId)
  if (live === undefined || !CLOSABLE_STATUSES.includes(live)) {
    return afterCleanup
  }

  try {
    await herdr.closeWorkspace(workspaceId)
  } catch (err) {
    // herdr が落ちている、あるいは既に手で閉じられている。完了そのものを
    // 失敗させるのは筋が悪いので、紐付けは残したまま完了を返す。
    //
    // ここを statusSync が拾ってくれるとは限らない: フロントのポーリングは
    // 未完了でセッション付きのTODOが1件も無ければ動かない(sessionPolling.js)
    // ので、完了済みのこのTODOの古い紐付けは reopen するまで残りうる。害は
    // reopen 後に「セッションを開く」が閉じたペインを指すことで、そのときは
    // statusSync が次の周回で片付ける。
    logger.warn('Failed to close the herdr workspace of a completed todo', {
      todoId,
      workspaceId,
      message: err instanceof Error ? err.message : String(err),
    })
    return afterCleanup
  }

  // 閉じたペインを指したままにしない。完了行にはボタンが出ないので効くのは
  // reopen したあと——そのとき「セッションを開く」が死んだペインを指す。
  //
  // 消すのは「自分が閉じたワークスペース」を指しているときだけ: closeWorkspace
  // は最大10秒ブロックしうるので、その間に reopen → 再dispatch が走っている
  // 可能性がある。無条件に消すと、新しいワークスペースを孤児にしてしまう。
  todoRepo.clearSessionIfWorkspace(db, todoId, workspaceId)
  return todoRepo.getById(db, todoId)
}
