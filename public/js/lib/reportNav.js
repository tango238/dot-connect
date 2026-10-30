// Pure boundary logic for the weekly report's ← → navigation.

/**
 * Whether the "→ (next week)" action should be enabled.
 * `latestWeekStart` is the newest week that can be shown (the current week,
 * since the statistics are live); null means it isn't known yet.
 */
export function canGoNext(weekStart, latestWeekStart) {
  if (!weekStart) return false
  if (latestWeekStart === null) return false
  return weekStart < latestWeekStart
}
