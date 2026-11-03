// TODO とマイルストーンに共通の優先順位(緊急度・重要度、各 1〜5)の純粋
// ロジック。サーバーの src/services/priority.ts と同じ規則:
//   - 1 が最低(未設定と同じ)、5 が最高
//   - 並びは「合計点(緊急度+重要度)が高い順、同点なら緊急度が高い順」
// バッジは両方 1(既定)のときは出さない —— 一覧が騒がしくならないよう、
// 旧 priority の「なし」と同じ扱い。

export const PRIORITY_MIN = 1
export const PRIORITY_MAX = 5
export const PRIORITY_DEFAULT = 1

/** 1〜5 の整数に正規化する。不正・未設定(旧データ)は既定の 1。 */
export function priorityLevel(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < PRIORITY_MIN || n > PRIORITY_MAX) return PRIORITY_DEFAULT
  return n
}

export function priorityScore(item) {
  return priorityLevel(item?.urgency) + priorityLevel(item?.importance)
}

/** 高い順。最後の決着(日付・id)は呼び出し側で付ける。 */
export function comparePriority(a, b) {
  return priorityScore(b) - priorityScore(a) || priorityLevel(b?.urgency) - priorityLevel(a?.urgency)
}

/** 旧 priority の「高」「低」に相当する粗い区分。一覧の段分け(todoOrder)用。 */
export function isPrioritized(item) {
  return priorityScore(item) > PRIORITY_DEFAULT * 2
}

/**
 * 行・カードに出す小さなバッジ。両方 1 なら null(出さない)。
 * className は高い方のレベルで色を決める(prio-5 が最も目立つ)。
 * @returns {{ label: string, title: string, className: string } | null}
 */
export function priorityBadge(item) {
  const urgency = priorityLevel(item?.urgency)
  const importance = priorityLevel(item?.importance)
  if (urgency === PRIORITY_DEFAULT && importance === PRIORITY_DEFAULT) return null
  return {
    label: `緊${urgency} 重${importance}`,
    title: `緊急度 ${urgency} / 重要度 ${importance}`,
    className: `prio-${Math.max(urgency, importance)}`,
  }
}

/** 詳細行などの読みやすい表記: "緊急度 5 / 重要度 3"。 */
export function formatPriority(item) {
  return `緊急度 ${priorityLevel(item?.urgency)} / 重要度 ${priorityLevel(item?.importance)}`
}

/** <select> の中身(1〜5)。5 が最高である旨を 1 と 5 に添える。 */
export function levelOptions(selected) {
  const current = priorityLevel(selected)
  const options = []
  for (let level = PRIORITY_MIN; level <= PRIORITY_MAX; level++) {
    const note = level === PRIORITY_MIN ? '(低)' : level === PRIORITY_MAX ? '(高)' : ''
    options.push(`<option value="${level}" ${level === current ? 'selected' : ''}>${level}${note}</option>`)
  }
  return options.join('')
}
