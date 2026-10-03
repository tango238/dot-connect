// Decides what (if anything) to send for workspacePath from the TODO
// create/edit form's optional workspace field.
//
// Confirmed backend contract for POST/PATCH /api/todos(/:id):
//   - omitted            -> no change (POST: left unset)
//   - a path string      -> trimmed and saved
//   - "" or whitespace   -> treated as null (never a 400)
//   - explicit null (PATCH only) -> clears a previously-set path
//
// Create and edit need different behavior for an emptied field: on
// create there's nothing to clear, so omit the key entirely (same as
// never having touched the field). On edit, an emptied field is a
// deliberate "remove the saved path" — omitting would mean "leave it
// unchanged", which is the wrong request-shape for a clear even though
// the backend would coerce a bare '' to null the same way; sending an
// explicit `null` makes the intent unambiguous at the call site.

export function buildWorkspacePathCreatePatch(rawValue) {
  const trimmed = rawValue.trim()
  return trimmed ? { workspacePath: trimmed } : {}
}

export function buildWorkspacePathEditPatch(rawValue) {
  const trimmed = rawValue.trim()
  return { workspacePath: trimmed || null }
}
