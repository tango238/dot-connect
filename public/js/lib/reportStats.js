// Pure presentation helpers for the weekly report's statistics (numbers in,
// labels/percentages out). No DOM, no state — tested under tests/frontend.

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

/** '月'…'日' for a local YYYY-MM-DD. */
export function weekdayLabel(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`)
  return WEEKDAYS[d.getDay()] ?? ''
}

/** "45分" / "2時間30分" / "3日4時間"; null (no data) → "–". */
export function formatLeadTime(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '–'
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total}分`
  const hours = Math.floor(total / 60)
  const mins = total % 60
  if (hours < 24) return mins === 0 ? `${hours}時間` : `${hours}時間${mins}分`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}日` : `${days}日${restHours}時間`
}

/**
 * Week-over-week change. `dir` drives the color class: more completions is
 * 'up' (good) — callers that count something bad (overdue) can invert it.
 * @returns {{text: string, dir: 'up' | 'down' | 'flat'}}
 */
export function deltaLabel(current, previous) {
  const diff = current - previous
  if (diff === 0) return { text: '前週と同じ', dir: 'flat' }
  const sign = diff > 0 ? '+' : '−'
  return { text: `前週比 ${sign}${Math.abs(diff)}`, dir: diff > 0 ? 'up' : 'down' }
}

/** Integer percent of part/total, or null when there is no total. */
export function ratioPercent(part, total) {
  if (!total) return null
  return Math.round((part / total) * 100)
}

/**
 * Fill ratio for the "completed out of created" donut, capped at 100. With
 * nothing created, any completion counts as a full circle (the backlog
 * shrank) and none as empty.
 */
export function completionRatio(completed, created) {
  if (!created) return completed > 0 ? 100 : 0
  return Math.min(100, Math.round((completed / created) * 100))
}

/** One sentence on whether the backlog grew or shrank this week. */
export function netFlowLabel(created, completed) {
  if (created === 0 && completed === 0) return 'この週は登録も完了もありませんでした。'
  const diff = completed - created
  if (diff > 0) return `完了が登録を ${diff} 件上回り、未完了が減りました。`
  if (diff < 0) return `登録が完了を ${-diff} 件上回り、未完了が増えました。`
  return '登録と完了が同数で、未完了は横ばいです。'
}

/**
 * Bar heights (0–100) for the daily created/completed chart, scaled to the
 * tallest bar of the week so the chart always uses its full height.
 * @returns {Array<{date: string, created: number, completed: number, createdPct: number, completedPct: number}>}
 */
export function barHeights(daily) {
  const max = Math.max(1, ...daily.map((d) => Math.max(d.created, d.completed)))
  return daily.map((d) => ({
    ...d,
    createdPct: Math.round((d.created / max) * 100),
    completedPct: Math.round((d.completed / max) * 100),
  }))
}

/** Share (0–100) of each entry's count against the largest, for the horizontal bars. */
export function sharePercent(count, counts) {
  const max = Math.max(1, ...counts)
  return Math.round((count / max) * 100)
}
