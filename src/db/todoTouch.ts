import type { Database } from 'bun:sqlite'

// TODOの「最終更新」を今にする、依存ゼロの一関数。
//
// 独立したファイルなのは循環参照を避けるため: todoRepo は
// todoPullRequestRepo と todoAttachmentRepo を import しているので、子側から
// todoRepo を呼び返すことはできない。3者が共通で見られる場所がここになる。
//
// 何を「更新」に数えるかの線引きは呼び出し側の判断だが、方針は一つ:
// 人の操作(作成後の編集・完了/再オープン・PRや添付の付け外し・herdr投入)と、
// TODO自身の状態が実際に変わったとき(statusSync のセッション状態遷移)だけ
// 打つ。中身が変わらない定期的な取り直し(PRメタデータの refresh-stale)では
// 打たない —— それをやると、何も動いていないTODOが更新順の先頭に上がり続け
// て「最近の更新」が意味を失う。
export function touchTodo(db: Database, todoId: number): void {
  db.run(`UPDATE todos SET updated_at = datetime('now') WHERE id = ?`, [todoId])
}
