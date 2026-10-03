// Pure shaping of registered workspaces into <datalist> option data. The
// path is the value herdr actually receives (dispatch/save writes this
// exact string to workspacePath) — the name is carried alongside purely
// for display, so callers can show "name (path)" or similar. Sorted by
// name so suggestion order matches the management modal's own listing.

/**
 * @param {Array<{ name: string, path: string }>} workspaces
 * @returns {Array<{ value: string, label: string }>}
 */
export function buildWorkspaceDatalistOptions(workspaces) {
  return [...workspaces]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((w) => ({ value: w.path, label: w.name }))
}
