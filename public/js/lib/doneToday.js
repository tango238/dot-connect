// サイドバーの「目標」の横に出す「今日完了した TODO の数」。
//
// completedAt は SQLite の UTC datetime("YYYY-MM-DD HH:MM:SS")なので、
// 日付部分をそのまま比べると深夜前後で今日/昨日がずれる。ここでは
// 見ている人のタイムゾーンでローカル日付に直してから今日と比べる。
// DOM も state も触らない。

import { parseSqliteUtc } from './todoDetail.js'

/**
 * UTC 文字列をローカルの 'YYYY-MM-DD' にする。壊れていれば null。
 * `timeZone` はテストだけが渡す(ブラウザでは Intl が見ている人のものを使う)。
 */
export function localDateOf(sqliteUtc, timeZone) {
  const date = parseSqliteUtc(sqliteUtc)
  if (!date) return null
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/**
 * 今日(ローカル日付)に完了にした TODO の数。
 * @param {Array<{status: string, completedAt: string|null}>} todos
 * @param {string} todayIso 'YYYY-MM-DD'(ローカル日付)
 * @param {string} [timeZone]
 */
export function completedTodayCount(todos, todayIso, timeZone) {
  let n = 0
  for (const t of todos) {
    if (t.status !== 'done') continue
    if (localDateOf(t.completedAt, timeZone) === todayIso) n++
  }
  return n
}

/** バッジの表示。0 でも出す(今日まだ何も終えていないことが分かる方がよい)。 */
export function doneTodayBadge(count) {
  return {
    text: `✓ ${count}`,
    title: count === 0 ? '今日完了した TODO はまだありません' : `今日完了した TODO: ${count} 件`,
    active: count > 0,
  }
}
