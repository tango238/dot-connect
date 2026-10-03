// Pure lookup for how a todo's priority should render as a row badge.
//
// 'none' renders nothing (the common case, so the row list isn't noisy),
// and so does anything this module doesn't recognize — including
// undefined/null, which is what todos created before this feature (or
// while the backend priority rollout is still in flight) will have. That
// makes "no badge" the safe default rather than a thrown error or a
// broken-looking badge.

const BADGES = {
  low: { label: '低', className: 'prio-low' },
  high: { label: '高', className: 'prio-high' },
}

export function priorityBadge(priority) {
  return BADGES[priority] ?? null
}
