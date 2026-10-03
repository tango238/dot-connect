// Pure helpers for the Claude Code model <select>: building its option
// list (always prefixed with an explicit "default/unspecified" choice,
// since omitting a model entirely is a valid and common choice) and
// resolving which value should be preselected from a todo's saved model.

const DEFAULT_VALUE = ''
const DEFAULT_LABEL = '既定(未指定)'

/**
 * @param {string[]} models - allowed model names from GET /api/models
 * @returns {Array<{value: string, label: string}>}
 */
export function buildModelSelectChoices(models) {
  return [{ value: DEFAULT_VALUE, label: DEFAULT_LABEL }, ...models.map((m) => ({ value: m, label: m }))]
}

// Resolved against the current allowlist, not just null-checked (F2): a
// todo can carry a model that used to be allowed but was since dropped from
// DOT_CONNECT_ALLOWED_MODELS. Without this, the <select> would render with
// no `selected` option at all (the saved value has no matching <option>),
// so the browser silently falls back to displaying the first choice
// ("既定(未指定)") while this function kept returning the stale value —
// meaning the visible selection and the value about to be submitted
// disagree, and picking "既定(未指定)" by hand did nothing (it was already
// the DOM's value, so no change event fired) — a 400 the user couldn't
// back out of. Resolving to the blank/default value up front keeps what's
// shown and what's submitted in sync from the start.
/**
 * @param {string|null|undefined} model - e.g. todo.model
 * @param {string[]} models - allowed model names from GET /api/models
 */
export function resolveModelSelectValue(model, models) {
  if (model == null) return DEFAULT_VALUE
  return models.includes(model) ? model : DEFAULT_VALUE
}
