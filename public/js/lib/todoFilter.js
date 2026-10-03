// Pure TODO filter predicate — shared by the TODO page and its tests.

import { isIsoDate, shiftIsoDate } from './isoDate.js'
import { isRecentlyActive } from './todoActivity.js'

// TODOの状態は保存値ではなく派生表示: status(open/done)と sessionState、
// 紐付いたPRから毎回組み立てる。上から順に判定して最初に一致したものを返す
// ので、5つのバケットは構造的に排他になる——if 連鎖に分類が散らばっていた
// 頃のように「どのタブにも出ない/二重に出る」が起きない。

export const BUCKET_LABEL = {
  done: '完了',
  running: '実行中',
  'pr-review': 'レビュー待ち',
  review: '確認待ち',
  open: '未着手',
}

// レビューを待っているPRか。draft はまだ依頼前なので数えない。state が
// 取れていない(gh 未導入・取得失敗)ものは数える——「PRはあるが状態不明」
// のときは隠すより見せる方が安全。
function isAwaitingReview(pr) {
  if (pr.state === null || pr.state === undefined) return true
  return pr.state === 'open' && pr.isDraft !== true
}

/**
 * @param {{ status: 'open'|'done', sessionState: string|null, pullRequests?: object[] }} todo
 * @returns {'done'|'running'|'pr-review'|'review'|'open'}
 */
export function todoBucket(todo) {
  if (todo.status === 'done') return 'done'
  if (todo.sessionState === 'working') return 'running'
  if ((todo.pullRequests ?? []).some(isAwaitingReview)) return 'pr-review'
  // herdr treats 'idle' as a CLI-side completion signal too, so it belongs
  // in "確認待ち" alongside 'done'/'blocked' — only 'working' is excluded
  // (and 'working' is already handled above).
  if (todo.sessionState) return 'review'
  return 'open'
}

// 期日超過はバケットと違う軸: 実行中のTODOも、PR待ちのTODOも期限は過ぎうる。
// なので todoBucket には混ぜず独立した述語にし、matchesFilter だけが
// 「'overdue' はバケットではなく期限で判定する」ことを知っている。
//
// 比較は文字列のまま行う——YYYY-MM-DD は辞書順と日付順が一致するので、
// Date を経由するとタイムゾーンで1日ずれるだけで得るものがない(dueBadge と
// 同じ方針)。完了TODOは期限を過ぎていても超過に数えない: 終わった仕事を
// 赤く数え続けても行動は変わらない。
/**
 * @param {{ status: 'open'|'done', dueDate?: string|null }} todo
 * @param {string} todayIso 'YYYY-MM-DD'(ローカル日付)
 */
export function isOverdue(todo, todayIso) {
  if (todo.status === 'done') return false
  if (!isIsoDate(todo.dueDate) || !isIsoDate(todayIso)) return false
  return todo.dueDate < todayIso
}

/**
 * @param {object} todo
 * @param {'all'|'recent'|'running'|'pr-review'|'review'|'open'|'overdue'|'done'} filter
 * @param {string} [todayIso] 'YYYY-MM-DD'(ローカル日付) — 'recent'/'overdue' で必要
 */
export function matchesFilter(todo, filter, todayIso) {
  if (filter === 'all') return true
  // 'recent' と 'overdue' はバケットと違う軸(最終更新 / 期限)なので、
  // todoBucket には混ぜず専用の述語に委ねる。
  if (filter === 'recent') return isRecentlyActive(todo, todayIso)
  if (filter === 'overdue') return isOverdue(todo, todayIso)
  return todoBucket(todo) === filter
}

// 完了TODOを一覧に出すかどうか。今日を含む直近7日間(今日から6日前まで)
// だけを残し、それより古い完了は隠す——データは消さないので、週次レポート
// や計画ページの集計には従来どおり全件が使われる。
//
// completedAt は SQLite の UTC datetime 文字列だが、ここでは日付部分だけを
// 見る(時刻まで比べても境界が日単位で揺れるだけで意味がない)。
// completedAt が無い完了TODO(異常データ)は隠さない——見失う方が困る。
const RECENT_COMPLETION_DAYS = 7

/**
 * @param {{ completedAt: string|null }} todo
 * @param {string} todayIso 'YYYY-MM-DD'(ローカル日付)
 */
export function isRecentlyCompleted(todo, todayIso) {
  const completedDate = todo.completedAt?.slice(0, 10)
  if (!completedDate) return true
  return completedDate >= shiftIsoDate(todayIso, -(RECENT_COMPLETION_DAYS - 1))
}
