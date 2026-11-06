// herdr に投入する TODO か、自分でやる TODO か —— TODO 側で決める。
// 週の一覧(目標ページ)の「herdr」「自分」の印はこの判定の写し。
// サーバー側の同じ判定は src/services/weekQueueService.ts の queueDispatchFor。
//
//   dispatchMode 'herdr' / 'self' … 詳細の「投入先」で明示したもの(最優先)
//   null(自動)                    … 作業ディレクトリがあるか Grilled 済みなら herdr、
//                                   どちらも無ければ自分
// DOM も state も触らない。

/** 詳細の「投入先」select の選択肢。value '' が自動(dispatchMode null)。 */
export const DISPATCH_MODE_OPTIONS = [
  { value: '', label: '自動' },
  { value: 'herdr', label: 'herdr に投入' },
  { value: 'self', label: '自分でやる' },
]

/**
 * @returns {{ herdr: boolean, mode: 'herdr'|'self'|'auto', reason: string } | null}
 *   herdr: 投入する対象か。mode: 明示なら 'herdr'/'self'、自動なら 'auto'。
 */
export function dispatchDecision(todo) {
  if (!todo) return null
  if (todo.dispatchMode === 'herdr') return { herdr: true, mode: 'herdr', reason: 'herdr に投入すると指定' }
  if (todo.dispatchMode === 'self') return { herdr: false, mode: 'self', reason: '自分でやると指定' }
  if (todo.workspacePath) return { herdr: true, mode: 'auto', reason: '作業ディレクトリあり' }
  if (todo.grilledAt) return { herdr: true, mode: 'auto', reason: 'Grilled 済み' }
  return { herdr: false, mode: 'auto', reason: '作業ディレクトリも Grilled も無し' }
}

/** herdr に投入する TODO か(「目標に登録」で herdr の印になるか)。 */
export function isHerdrTask(todo) {
  return dispatchDecision(todo)?.herdr === true
}

/** 自動のときに select の横に出す補足。明示なら不要なので null。 */
export function dispatchModeNote(todo) {
  const d = dispatchDecision(todo)
  if (!d || d.mode !== 'auto') return null
  return `いまは ${d.herdr ? 'herdr' : '自分'}(${d.reason})`
}

/** 保存後のトースト用ラベル。 */
export function dispatchModeLabel(value) {
  return DISPATCH_MODE_OPTIONS.find((o) => o.value === (value ?? ''))?.label ?? '自動'
}
