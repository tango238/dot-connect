// 未完了TODOの表示順を決める純粋関数。
//
// サーバ(todoRepo)の ORDER BY は「期限昇順 → 優先度」で、期日超過が必ず
// 最上部に来る。それは一覧の先頭が“もう手遅れなもの”で埋まるということで、
// 今日これから動かす仕事が下に押し出されてしまう。そこで一覧側では、
// まだ間に合う期日つきの仕事を先頭に、超過ぶんは優先度つきの後ろへ回す:
//
//   1. 期日設定済(未超過)  — 優先度 高 > 低 > なし、同順位は期日の近い順
//   2. 優先度 高(期日なし)
//   3. 優先度 低(期日なし)
//   4. 期日超過            — 優先度に関係なくまとまり、超過の古い順
//   5. 優先度未設定(期日なし)
//
// 期限の判定にはローカル日付が要るので SQL 側では決められない——「今日」を
// 知っているのは画面だけ。並べ替えはここ(表示層)の責務になる。

import { isIsoDate } from './isoDate.js'
import { isOverdue } from './todoFilter.js'

const TIER_SCHEDULED = 0
const TIER_HIGH = 1
const TIER_LOW = 2
const TIER_OVERDUE = 3
const TIER_UNSET = 4

const PRIORITY_RANK = { high: 0, low: 1 }

// 未知の優先度値は「なし」と同じ最下位に落とす——不正データで並びが
// 壊れるより、末尾に静かに積まれる方がよい。
function priorityRank(priority) {
  return PRIORITY_RANK[priority] ?? 2
}

function tierOf(todo, todayIso) {
  if (isOverdue(todo, todayIso)) return TIER_OVERDUE
  if (isIsoDate(todo.dueDate)) return TIER_SCHEDULED
  if (todo.priority === 'high') return TIER_HIGH
  if (todo.priority === 'low') return TIER_LOW
  return TIER_UNSET
}

// 同じ tier 内は「期日設定済なら優先度が先、期日超過なら期日が先」。
// 前者は何から手を付けるかの話、後者はどれだけ放置したかの話なので、
// 並びの主キーが入れ替わる。最後は id 昇順で必ず決着させる。
function compareWithinTier(tier, a, b) {
  if (tier === TIER_SCHEDULED) {
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority)
    if (byPriority !== 0) return byPriority
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1
  } else if (tier === TIER_OVERDUE) {
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority)
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
