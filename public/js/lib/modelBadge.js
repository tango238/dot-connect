// Pure lookup for whether a todo's model override should render as a row
// badge — only when it deviates from the default (unspecified), mirroring
// priorityBadge.js's "nothing for the common case" approach so the row
// list isn't noisy for todos that never set one.

export function modelBadge(model) {
  if (!model) return null
  return { label: model }
}
