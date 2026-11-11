// Pure milestone-progress math — no DOM. Shared by the sidebar's
// "アクティブなマイルストーン" list and the milestones page's cards.

import { comparePriority } from './priority.js'

/** Completion percentage from a milestone's linked/done counts (0 when
 * nothing is linked yet, rather than dividing by zero). */
export function completionPct(milestone) {
  return milestone.linkedCount ? Math.round((milestone.doneCount / milestone.linkedCount) * 100) : 0
}

/** 期限の近い順。期限なし(null)は期限ありの後ろ。 */
export function compareTargetDate(a, b) {
  const x = a.targetDate ?? '9999-99-99'
  const y = b.targetDate ?? '9999-99-99'
  return x < y ? -1 : x > y ? 1 : a.id - b.id
}

/** Active (not-done) milestones annotated with their completion percentage,
 * in the shape the sidebar list renders from. Ordered like the plan page:
 * priority (urgency + importance) first, then the nearest target date. */
export function activeMilestonesWithProgress(milestones) {
  return milestones
    .filter((m) => m.status === 'active')
    .map((m) => ({ ...m, pct: completionPct(m) }))
    .sort((a, b) => comparePriority(a, b) || compareTargetDate(a, b))
}
