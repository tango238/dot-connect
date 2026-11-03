// 未完了TODOの表示順を決める純粋関数。
//
// サーバ(todoRepo)の ORDER BY は「期限昇順 → 優先度」で、期日超過が必ず
// 最上部に来る。それは一覧の先頭が“もう手遅れなもの”で埋まるということで、
// 今日これから動かす仕事が下に押し出されてしまう。そこで一覧側では、
// まだ間に合う期日つきの仕事を先頭に、超過ぶんは優先度つきの後ろへ回す:
//
//   1. 期日設定済(未超過)  — 優先順位の高い順、同順位は期日の近い順
//   2. 優先順位あり(期日なし) — 緊急度か重要度のどちらかが 2 以上
//   3. 期日超過            — 優先順位に関係なくまとまり、超過の古い順
//   4. 優先順位未設定(期日なし) — 緊急度・重要度とも 1
//
// 優先順位は緊急度+重要度の合計点(同点なら緊急度)で、lib/priority.js の
// comparePriority が決める。
//
// 期限の判定にはローカル日付が要るので SQL 側では決められない——「今日」を
// 知っているのは画面だけ。並べ替えはここ(表示層)の責務になる。

import { isIsoDate } from './isoDate.js'
import { comparePriority, isPrioritized } from './priority.js'
import { isOverdue } from './todoFilter.js'

const TIER_SCHEDULED = 0
const TIER_PRIORITIZED = 1
const TIER_OVERDUE = 2
const TIER_UNSET = 3

function tierOf(todo, todayIso) {
  if (isOverdue(todo, todayIso)) return TIER_OVERDUE
  if (isIsoDate(todo.dueDate)) return TIER_SCHEDULED
  if (isPrioritized(todo)) return TIER_PRIORITIZED
  return TIER_UNSET
}

// 同じ tier 内は「期日設定済なら優先順位が先、期日超過なら期日が先」。
// 前者は何から手を付けるかの話、後者はどれだけ放置したかの話なので、
// 並びの主キーが入れ替わる。最後は id 昇順で必ず決着させる。
function compareWithinTier(tier, a, b) {
  if (tier === TIER_SCHEDULED || tier === TIER_PRIORITIZED) {
    const byPriority = comparePriority(a, b)
    if (byPriority !== 0) return byPriority
    if (tier === TIER_SCHEDULED && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1
  } else if (tier === TIER_OVERDUE) {
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1
    const byPriority = comparePriority(a, b)
    if (byPriority !== 0) return byPriority
  }
  return a.id - b.id
}

/**
 * 元の配列は書き換えない(state.todos をそのまま渡せる)。
 * @param {object[]} todos 未完了TODO
 * @param {string} todayIso 'YYYY-MM-DD'(ローカル日付)
 * @returns {object[]} 新しい配列
 */
export function sortActiveTodos(todos, todayIso) {
  return [...todos].sort((a, b) => {
    const tierA = tierOf(a, todayIso)
    const tierB = tierOf(b, todayIso)
    if (tierA !== tierB) return tierA - tierB
    return compareWithinTier(tierA, a, b)
  })
}
