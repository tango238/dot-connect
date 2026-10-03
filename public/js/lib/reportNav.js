// Pure boundary logic for the weekly report's ← → navigation.

/**
 * Whether the "→ (next week)" action should be enabled.
 * `latestWeekStart` is null when no report has ever been generated (there is
 * nothing to advance to yet).
 */
export function canGoNext(weekStart, latestWeekStart) {
  if (!weekStart) return false
  if (latestWeekStart === null) return false
  return weekStart < latestWeekStart
}
