// Pure predicate for whether a background poll should skip refreshing
// state — used to stop a poll-triggered re-render from wiping out text
// the user is currently typing into an inline edit/add form (F43).
//
// Each marker is a module-local "which row/card has its inline form open"
// id (or null when that form is closed) — e.g. todos.js's editFormTodoId,
// milestones.js's openAddFormMsId.
//
// Uses `!= null` (not `!== null`) so an accidental `undefined` — e.g. a
// future marker that isn't initialized yet — reads as "closed" rather than
// "open", which would otherwise make the poll skip forever.

export function hasOpenForm(...markers) {
  return markers.some((marker) => marker != null)
}
