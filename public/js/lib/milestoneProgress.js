// Pure milestone-progress math — no DOM. Shared by the sidebar's
// "アクティブなマイルストーン" list and the milestones page's cards.

/** Completion percentage from a milestone's linked/done counts (0 when
 * nothing is linked yet, rather than dividing by zero). */
export function completionPct(milestone) {
  return milestone.linkedCount ? Math.round((milestone.doneCount / milestone.linkedCount) * 100) : 0
}

/** Active (not-done) milestones annotated with their completion percentage,
 * in the shape the sidebar list renders from. */
export function activeMilestonesWithProgress(milestones) {
  return milestones
    .filter((m) => m.status !== 'done')
    .map((m) => ({ ...m, pct: completionPct(m) }))
}
