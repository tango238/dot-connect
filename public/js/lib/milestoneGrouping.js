// Pure grouping logic for the milestones page: buckets milestones by their
// label for display. No DOM — callers pre-filter to just the milestones
// they want grouped (e.g. active-only; completed milestones get their own
// separate, non-grouped section and never go through this).

/**
 * @param {Array<{labelId: number|null, labelName: string|null, labelColor: string|null}>} milestones
 * @returns {Array<{labelId: number|null, labelName: string|null, labelColor: string|null, milestones: Array}>}
 *   Labeled groups first, sorted by label name (ascending); an unlabeled
 *   group (labelId: null) last, only when at least one milestone has no
 *   label. Milestones keep their relative order within each group.
 */
export function groupMilestonesByLabel(milestones) {
  const groupsById = new Map()
  const unlabeled = []

  for (const m of milestones) {
    if (m.labelId === null) {
      unlabeled.push(m)
      continue
    }
    if (!groupsById.has(m.labelId)) {
      groupsById.set(m.labelId, {
        labelId: m.labelId,
        labelName: m.labelName,
        labelColor: m.labelColor,
        milestones: [],
      })
    }
    groupsById.get(m.labelId).milestones.push(m)
  }

  const labeledGroups = [...groupsById.values()].sort((a, b) => a.labelName.localeCompare(b.labelName))

  if (unlabeled.length === 0) return labeledGroups
  return [...labeledGroups, { labelId: null, labelName: null, labelColor: null, milestones: unlabeled }]
}
