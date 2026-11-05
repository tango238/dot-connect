// 「今週終わらせるタスク」の並びと自動投入(auto mode)の純粋ロジック。DOM も
// state も触らないので、テストが直接叩ける。
//
// 自動投入の約束:
//   - 同時に走らせる上限は WIP可能数 − バッファ(どちらも設定)
//   - 候補は並びの上から順。投入できる TODO は「未完了・セッション無し・
//     Grill 済み(Grilled を通している)・作業ディレクトリあり」
//   - 投入は必ずユーザーの許可を待つ(autoRun.js が確認ダイアログを出す)。
//     ここは「次に何を提案するか」を決めるだけ。

import { wipCount } from './wipLimit.js'

/** id を delta(-1 / +1)だけ動かした新しい配列。端や無い id なら同じ並び。 */
export function moveId(ids, id, delta) {
  const index = ids.indexOf(id)
  const target = index + delta
  if (index === -1 || target < 0 || target >= ids.length) return [...ids]
  const next = [...ids]
  next.splice(index, 1)
  next.splice(target, 0, id)
  return next
}

/**
 * 空き枠。limit は WIP可能数(WIP制限が無効でも設定値を使う)、running は
 * セッションを持つ未完了 TODO の数(WIP と同じ定義)。
 */
export function autoRunCapacity(settings, todos) {
  const limit = settings?.wipLimit ?? 10
  const buffer = settings?.autoRunBuffer ?? 1
  const running = wipCount(todos ?? [])
  const slots = Math.max(0, limit - buffer)
  return { limit, buffer, running, slots, free: Math.max(0, slots - running) }
}

/** 行の「herdr / 自分」の印。herdr でやるか自分でやるかは TODO 側で決まる
 * (Grilled 済みを「目標に登録」すると herdr、Grill を通さず登録すると自分)ので、
 * 目標ページでは表示するだけで切り替えない。完了行には出さない。 */
export function queueModeLabel(todo) {
  if (!todo || todo.status === 'done') return null
  return todo.queueDispatch === false
    ? { mode: 'self', label: '自分', title: '自分でやるタスク(herdr には投入しません)。herdr か自分かは TODO 側で決めます' }
    : { mode: 'herdr', label: 'herdr', title: 'herdr に投入するタスク。herdr か自分かは TODO 側で決めます' }
}

/** 投入できない理由。投入できるなら null。queueDispatch が false の行(自分で
 * やるタスク)は、Grilled でも投入しない。 */
export function dispatchReadiness(todo) {
  if (!todo) return 'TODO が見つかりません'
  if (todo.status === 'done') return '完了済み'
  if (todo.queueDispatch === false) return 'herdr に投入しない(自分でやる)'
  if (todo.grillDir) return 'Grill 中(Grilled を押して確定してから)'
  if (todo.sessionState) return '実行中'
  if (!todo.grilledAt) return 'Grill 未実施(Grill me → Grilled が条件)'
  if (!todo.workspacePath) return '作業ディレクトリ未設定'
  return null
}

/**
 * 並び(queueTodos: 実行順)から、次に提案する TODO と、見送る TODO の理由。
 * @param {object[]} queueTodos 実行順の TODO(最新の state から引いたもの)
 * @param {object[]} todos 全 TODO(空き枠の計算用)
 * @param {object|null} settings GET /api/settings
 * @param {Set<number>} skippedIds この起動中にユーザーが「スキップ」した id
 */
export function autoRunPlan(queueTodos, todos, settings, skippedIds = new Set()) {
  const capacity = autoRunCapacity(settings, todos)
  let candidate = null
  const waiting = []
  let running = 0
  let done = 0
  for (const todo of queueTodos) {
    if (todo.status === 'done') {
      done++
      continue
    }
    if (todo.sessionState && !todo.grillDir) running++
    const reason = skippedIds.has(todo.id) ? 'スキップ済み(この起動中)' : dispatchReadiness(todo)
    if (reason === null) {
      if (candidate === null) candidate = todo
    } else if (!todo.sessionState || todo.grillDir) {
      waiting.push({ todo, reason })
    }
  }
  return { capacity, candidate, canPropose: candidate !== null && capacity.free > 0, waiting, running, done }
}
