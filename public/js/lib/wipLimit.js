// Pure helpers for the kanban WIP limit — shared by the sidebar meter, the
// dispatch buttons, and their tests. The server enforces the limit on its
// own (wipLimitService.ts); these only mirror it so the UI can say so first.

/**
 * Counts todos occupying a WIP slot: linked to a herdr session and not done.
 * Same definition as the server's and as the sidebar's "管理中" count.
 *
 * @param {{ sessionState: string|null, status: 'open'|'done' }[]} todos
 */
export function wipCount(todos) {
  return todos.filter((t) => t.sessionState !== null && t.status !== 'done').length
}

/**
 * The sidebar meter, e.g. "■■■■■■□□□□" + "6/10". One cell per slot; a count
 * above the limit (the limit was lowered while sessions were running) just
 * fills every cell — the number still shows the real count.
 *
 * @returns {{ cells: string, label: string, full: boolean, over: boolean }}
 */
export function wipMeter(count, limit) {
  const filled = Math.min(count, limit)
  return {
    cells: '■'.repeat(filled) + '□'.repeat(limit - filled),
    label: `${count}/${limit}`,
    full: count >= limit,
    over: count > limit,
  }
}

/**
 * Why a new dispatch would be refused, or null when it may go ahead.
 * `settings` is GET /api/settings (null while unknown: assume allowed and
 * let the server decide).
 */
export function wipBlockedReason(settings, todos) {
  if (!settings?.wipLimitEnabled) return null
  const count = wipCount(todos)
  if (count < settings.wipLimit) return null
  return `WIP制限(${settings.wipLimit}件)に達しています。実行中のTODOを完了にするか削除してください`
}
