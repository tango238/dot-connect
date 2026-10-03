// 「最近の更新」ビューの材料をまとめて持つ。最終更新時刻の取り出し、30日の
// 足切り、直近1/3/7/14/30日への振り分けは、どれも同じ1つの時刻を見ている
// ——別々のファイルに散らすと、足切りは通ったのにどの区切りにも入らない、
// といった食い違いが起きる。
//
// 日数の数え方は既存の isRecentlyCompleted と同じ「今日を含むN日間」
// (直近7日 = 今日と、その前の6日)。日付部分だけを比べるのも同じ理由で、
// 時刻まで見ても境界が日単位で揺れるだけで意味がない。

import { shiftIsoDate } from './isoDate.js'

// TODOが最後に動いた時刻。updatedAt は「一度も動いていない」を NULL で表す
// (todoTouch.ts 参照)ので、ここで createdAt に落とす——空文字にすると、作った
// ばかりのTODOと updated_at 導入前からある既存TODOが軒並み足切りに掛かって
// 「最近の更新」から消える。
/**
 * @param {{ createdAt: string, updatedAt?: string|null }} todo
 * @returns {string} SQLite の "YYYY-MM-DD HH:MM:SS"(UTC)
 */
export function lastActivityAt(todo) {
  return todo.updatedAt ?? todo.createdAt
}

// このビューが遡る上限。これより古いものは出さない——「最近の更新」を名乗る
// 以上、1年前に触ったきりの仕事が混ざっていては名前が嘘になるし、完了TODOが
// 積み上がるにつれて描画する行だけが際限なく増える。
export const ACTIVITY_WINDOW_DAYS = 30

// 見出しに使う区切り。狭い順に並べ、TODOは最初に収まったものに入る。
const ACTIVITY_BUCKETS = [
  { days: 1, label: '直近1日以内' },
  { days: 3, label: '直近3日以内' },
  { days: 7, label: '直近7日以内' },
  { days: 14, label: '直近14日以内' },
  { days: ACTIVITY_WINDOW_DAYS, label: `直近${ACTIVITY_WINDOW_DAYS}日以内` },
]

/**
 * このTODOを「最近の更新」に出すか。完了は出さない——終わった仕事を最近
 * 触った順に眺めても次の行動は変わらない(完了は「完了」チップ側の担当)。
 * @param {{ status: 'open'|'done', createdAt: string, updatedAt?: string|null }} todo
 * @param {string} todayIso 'YYYY-MM-DD'(ローカル日付)
 */
export function isRecentlyActive(todo, todayIso) {
  if (todo.status === 'done') return false
  return withinDays(todo, todayIso, ACTIVITY_WINDOW_DAYS)
}

function withinDays(todo, todayIso, days) {
  return lastActivityAt(todo).slice(0, 10) >= shiftIsoDate(todayIso, -(days - 1))
}

/**
 * 表示対象を区切りごとにまとめる。元の配列は書き換えない。
 * @param {object[]} todos 完了・未完了を問わない全TODO(絞り込みはここで行う)
 * @param {string} todayIso 'YYYY-MM-DD'(ローカル日付)
 * @returns {Array<{ label: string, todos: object[] }>}
 *   狭い区切りから順。該当TODOが無い区切りは含めない。区切りの中は最終更新の
 *   降順で、同着は id 降順(新しいTODOが先)——datetime('now') は秒精度なので
 *   同着はふつうに起きる。
 */
export function groupByRecentActivity(todos, todayIso) {
  const visible = todos.filter((todo) => isRecentlyActive(todo, todayIso))
  const groups = []
  let remaining = visible

  for (const { days, label } of ACTIVITY_BUCKETS) {
    const inBucket = remaining.filter((todo) => withinDays(todo, todayIso, days))
    if (inBucket.length > 0) {
      groups.push({ label, todos: inBucket.sort(compareByRecentActivity) })
      remaining = remaining.filter((todo) => !withinDays(todo, todayIso, days))
    }
  }
  return groups
}

function compareByRecentActivity(a, b) {
  const activityA = lastActivityAt(a)
  const activityB = lastActivityAt(b)
  if (activityA !== activityB) return activityA < activityB ? 1 : -1
  return b.id - a.id
}
