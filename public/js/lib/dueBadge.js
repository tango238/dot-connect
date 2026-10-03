// TODOの期限を行バッジ用の表示に変換する純粋関数。
//
// due_date は時刻もタイムゾーンも持たない YYYY-MM-DD なので、比較は
// 呼び出し側から渡されたローカル日付(utils.js の todayIso())との文字列
// 比較で行う。UTC 変換を挟むと日付が1日ずれる。
// 未設定・不正値はどちらも null(バッジなし)を返し、行を壊さない。

import { isIsoDate } from './isoDate.js'

const MS_PER_DAY = 86_400_000

function toUtcMs(iso) {
  // 日付同士の差だけが欲しいので、両方を同じ規則(UTC 正午)で数値化する。
  // 正午にするのは、夏時間のある地域でも日付境界の丸めがずれないため。
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d, 12)
}

function diffInDays(fromIso, toIso) {
  return Math.round((toUtcMs(toIso) - toUtcMs(fromIso)) / MS_PER_DAY)
}

function monthDay(iso) {
  const [, m, d] = iso.split('-').map(Number)
  return `${m}/${d}`
}

/**
 * @param {string|null|undefined} dueDate 'YYYY-MM-DD'
 * @param {string} todayIso 'YYYY-MM-DD'(ローカル日付)
 * @returns {{ label: string, className: string }|null}
 */
export function dueBadge(dueDate, todayIso) {
  if (!isIsoDate(dueDate)) return null
  if (!todayIso) return null

  const days = diffInDays(todayIso, dueDate)
  if (days < 0) {
    return { label: `${monthDay(dueDate)} (${-days}日超過)`, className: 'due-overdue' }
  }
  if (days === 0) return { label: '今日', className: 'due-soon' }
  if (days === 1) return { label: '明日', className: 'due-soon' }
  return { label: monthDay(dueDate), className: 'due-normal' }
}
