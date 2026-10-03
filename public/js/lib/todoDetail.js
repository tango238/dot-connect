// Pure display logic for the TODO detail dialog: no DOM, no state access,
// so it can be unit-tested like the other modules under lib/.

import { dueBadge } from './dueBadge.js'
import { modelBadge } from './modelBadge.js'
import { priorityBadge } from './priorityBadge.js'
import { BUCKET_LABEL, todoBucket } from './todoFilter.js'

// Also used by todos.js for the row's session badge — kept here so the
// mapping lives in exactly one place.
export const SESSION_LABEL = {
  working: '実行中',
  done: '完了・未確認',
  blocked: '承認待ち',
  idle: '待機',
}

// Timestamps come from SQLite's datetime('now'): "YYYY-MM-DD HH:MM:SS" in
// UTC, with no timezone marker. Feeding that to `new Date()` directly would
// have the browser read it as *local* time and shift every displayed value.
export function parseSqliteUtc(value) {
  if (!value) return null
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`
  const date = new Date(withZone)
  return Number.isNaN(date.getTime()) ? null : date
}

// `timeZone` is only passed explicitly by tests; in the browser it is left
// undefined so Intl uses the viewer's own timezone.
export function formatDateTime(value, timeZone) {
  const date = parseSqliteUtc(value)
  if (!date) return null
  // 'sv-SE' formats as "YYYY-MM-DD HH:MM", which is what we want to show.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function sessionValue(todo) {
  const label = SESSION_LABEL[todo.sessionState] ?? todo.sessionState
  return todo.herdrPaneId ? `${label} (${todo.herdrPaneId})` : label
}

/**
 * Builds the dialog's metadata rows. Rows whose underlying value is absent
 * are omitted entirely rather than rendered blank.
 * `today` is a local 'YYYY-MM-DD' — passed in rather than read from the
 * clock so the due row is testable.
 * @returns {Array<{label: string, value: string, mono?: boolean}>}
 */
export function detailRows(todo, timeZone, today) {
  // 「未完了」ではなく実際の状態(実行中/レビュー待ち/確認待ち/未着手)を出す。
  // 一覧のタブと同じ分類なので、どのタブで見つかるかが詳細からも分かる。
  const rows = [{ label: 'ステータス', value: BUCKET_LABEL[todoBucket(todo)] }]
  // Reuses the row badge's own wording ("今日", "8/5 (2日超過)"), so the
  // dialog and the list never disagree about how near a deadline is.
  const due = dueBadge(todo.dueDate, today)
  if (due) rows.push({ label: '期限', value: due.label })
  // All three badges return null for the default/unset case (and for todos
  // that predate any of these fields), which lines up with this function's
  // own rule of omitting a row rather than rendering it blank.
  const priority = priorityBadge(todo.priority)
  if (priority) rows.push({ label: '優先度', value: priority.label })
  if (todo.sessionState) rows.push({ label: 'セッション', value: sessionValue(todo) })
  if (todo.workspacePath) {
    rows.push({ label: '作業ディレクトリ', value: todo.workspacePath, mono: true })
  }
  const model = modelBadge(todo.model)
  if (model) rows.push({ label: 'モデル', value: model.label, mono: true })
  for (const [label, value] of [
    ['作成', todo.createdAt],
    ['投入', todo.dispatchedAt],
    ['完了', todo.completedAt],
  ]) {
    const formatted = formatDateTime(value, timeZone)
    if (formatted) rows.push({ label, value: formatted })
  }
  return rows
}
