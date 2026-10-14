// Pure plan-timeline math: date validation, range computation, positioning.
// No DOM — the plan page renders around these, tests exercise them directly.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/** Rejects anything that isn't a well-formed YYYY-MM-DD that Date can parse
 * (guards against a single bad milestone taking the whole plan page down). */
export function hasValidRange(m) {
  if (!DATE_RE.test(m.startDate) || !DATE_RE.test(m.targetDate)) return false
  const start = new Date(`${m.startDate}T00:00:00Z`)
  const end = new Date(`${m.targetDate}T00:00:00Z`)
  return !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
}

/** Date range spanning every milestone and every extra date (TODO due
 * dates), plus today, with a one-week margin on each side. Callers must
 * pre-filter milestones with hasValidRange() and pass only valid YYYY-MM-DD
 * strings in `extraDates`. */
export function computeRange(milestones, todayStr, extraDates = []) {
  const today = new Date(`${todayStr}T00:00:00Z`)
  const extras = extraDates.map((d) => new Date(`${d}T00:00:00Z`).getTime())
  if (milestones.length === 0 && extras.length === 0) {
    return { start: new Date(today.getTime() - WEEK_MS), end: new Date(today.getTime() + 3 * WEEK_MS) }
  }
  const starts = milestones.map((m) => new Date(`${m.startDate}T00:00:00Z`).getTime())
  const ends = milestones.map((m) => new Date(`${m.targetDate}T00:00:00Z`).getTime())
  const minStart = Math.min(...starts, ...extras, today.getTime())
  const maxEnd = Math.max(...ends, ...extras, today.getTime())
  return { start: new Date(minStart - WEEK_MS), end: new Date(maxEnd + WEEK_MS) }
}

/** Where `dateStr` falls within [start, end], as a 0-100 clamped percentage. */
export function posPct(dateStr, start, end) {
  const t = new Date(`${dateStr}T00:00:00Z`).getTime()
  const pct = ((t - start.getTime()) / (end.getTime() - start.getTime())) * 100
  return Math.max(0, Math.min(100, pct))
}
