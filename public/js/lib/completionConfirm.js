// 完了に二段階確認を挟むかどうか。
//
// 完了は herdr のワークスペースを畳むので、セッションが紐付いていると
// 「行が一覧から消える」と「ペインとスクロールバックが消える」が確認なしに
// 同時に起きる(既定の「最近の更新」は完了を出さないため、押し間違えても
// 押し直す先が見えない)。取り消せない操作なので、そのときだけ一手挟む。
//
// 逆に、セッションが無いTODOでは完了は消えるものが何も無い——毎回確認を
// 出すのは邪魔なだけなので出さない。未完了に戻す側も何も壊さないので出さない。

/**
 * @param {{ status?: string, herdrWorkspaceId?: string|null }|null|undefined} todo
 * @returns {boolean}
 */
export function needsCompletionConfirm(todo) {
  if (!todo) return false
  if (todo.status === 'done') return false
  return Boolean(todo.herdrWorkspaceId)
}
