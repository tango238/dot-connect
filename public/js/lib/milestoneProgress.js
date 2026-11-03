// Pure milestone-progress math — no DOM. Shared by the sidebar's
// "アクティブなマイルストーン" list and the milestones page's cards.

import { comparePriority } from './priority.js'

/** Completion percentage from a milestone's linked/done counts (0 when
 * nothing is linked yet, rather than dividing by zero). */
export function completionPct(milestone) {
  return milestone.linkedCount ? Math.round((milestone.doneCount / milestone.linkedCount) * 100) : 0
}

/** Active (not-done) milestones annotated with their completion percentage,
 * in the shape the sidebar list renders from. Ordered like the plan page:
 * priority (urgency + importance) first, then the nearest target date. */
export function activeMilestonesWithProgress(milestones) {
  return milestones
    .filter((m) => m.status !== 'done')
    .map((m) => ({ ...m, pct: completionPct(m) }))
    .sort((a, b) => comparePriority(a, b) || (a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : a.id - b.id))
}
