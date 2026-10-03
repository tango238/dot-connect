// Decides what (if anything) to send for `model` from a <select> whose
// blank option means "use the default (unspecified)".
//
// Mirrors workspacePathPatch.js's create/edit split:
//   - create: nothing to clear yet, so blank omits the key entirely (same
//     as never having touched the field)
//   - edit: blank is a deliberate "clear back to default" — sent as an
//     explicit null, same reasoning as workspacePathPatch's edit case
//   - dispatch: shaped like create, not edit — a blank selection here means
//     "no override for this dispatch" (fall back to the todo's own saved
//     model), not "clear the todo's saved model"

export function buildModelCreatePatch(rawValue) {
  return rawValue ? { model: rawValue } : {}
}

export function buildModelEditPatch(rawValue) {
  return { model: rawValue || null }
}

export function buildModelDispatchPatch(rawValue) {
  return rawValue ? { model: rawValue } : {}
}

// The dispatch endpoint has no null-clear for `model` (only override-or-omit,
// same as workspacePath) — so picking "既定(未指定)" in the dispatch dialog
// while the todo already has a saved model can't be expressed in the
// dispatch request alone: omitting just falls back to the saved model,
// silently ignoring what looks like an explicit "use the default" choice.
// The dialog resolves this by issuing a separate PATCH (model: null) right
// before dispatching whenever this returns true — but only then, so picking
// the default for a todo that's already unset doesn't fire a no-op write.
export function needsModelResetBeforeDispatch(rawValue, savedModel) {
  return rawValue === '' && Boolean(savedModel)
}
