// Pure date/week-math helpers — no DOM, safe to unit test directly.
// weekStart convention (Monday) matches the backend's mostRecentMonday().

/** Monday of the ISO week containing `dateStr` (YYYY-MM-DD, UTC-based). */
export function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDay() // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? 6 : day - 1
  d.setUTCDate(d.getUTCDate() - diffToMonday)
  return d.toISOString().slice(0, 10)
}

/** Adds (or subtracts, for negative `days`) whole days to a YYYY-MM-DD string. */
export function addDaysToDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The later (chronologically) of two YYYY-MM-DD week starts. `current` may
 * be null, meaning "no known latest yet" — `candidate` always wins then. */
export function laterWeekStart(current, candidate) {
  if (current === null) return candidate
  return current > candidate ? current : candidate
}
