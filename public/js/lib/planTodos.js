// Plan page: pure grouping of due-dated TODOs under their milestone.
// No DOM — plan.js renders around this, tests exercise it directly.

import { isIsoDate } from './isoDate.js'

/** TODOs that can be placed on the timeline: a well-formed due date only. */
export function dueTodos(todos) {
  return todos.filter((t) => isIsoDate(t.dueDate) && !Number.isNaN(new Date(`${t.dueDate}T00:00:00Z`).getTime()))
}

function byDue(a, b) {
  return Number(a.status === 'done') - Number(b.status === 'done') || (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id - b.id)
}

/**
 * Groups due-dated TODOs by milestone id. TODOs with no milestone (or whose
 * milestone no longer exists in `milestones`) land under the `null` key so the
 * caller can render them as a trailing 「マイルストーンなし」 group.
 *
 * @returns {Map<number|null, object[]>} insertion order is irrelevant; each
 *   list is sorted open-first then by due date.
 */
export function groupDueTodosByMilestone(todos, milestones) {
  const known = new Set(milestones.map((m) => m.id))
  const groups = new Map()
  for (const t of dueTodos(todos)) {
    const key = t.milestoneId !== null && known.has(t.milestoneId) ? t.milestoneId : null
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }
  for (const list of groups.values()) list.sort(byDue)
  return groups
}
