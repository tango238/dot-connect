// Thin fetch wrapper around the dot-connect REST API.
// Every response is { success, data } or { success: false, error, ...extra }.
// Failures (4xx/5xx or network errors) throw ApiError so callers can toast them.

export class ApiError extends Error {
  constructor(message, status, extra = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.extra = extra
  }
}

// Everything both body shapes share: the network-failure ApiError, the
// success envelope, and the error envelope. Only how the body is encoded
// differs between request() and upload().
async function send(method, path, init) {
  let res
  try {
    res = await fetch(path, { method, ...init })
  } catch (err) {
    throw new ApiError('ネットワークエラー: サーバーに接続できません', 0, {})
  }

  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.success === false) {
    throw new ApiError(json.error ?? `リクエストに失敗しました (${res.status})`, res.status, json)
  }
  return json.data
}

function request(method, path, body) {
  return send(method, path, {
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

// Deliberately sets no Content-Type: the browser writes it itself, with the
// boundary that matches the body it just encoded. Setting one here would name
// a boundary the body doesn't use and the server would parse nothing.
function upload(method, path, formData) {
  return send(method, path, { body: formData })
}

export const api = {
  listTodos: () => request('GET', '/api/todos'),
  createTodo: (input) => request('POST', '/api/todos', input),
  updateTodo: (id, input) => request('PATCH', `/api/todos/${id}`, input),
  completeTodo: (id) => request('POST', `/api/todos/${id}/complete`),
  reopenTodo: (id) => request('POST', `/api/todos/${id}/reopen`),
  deleteTodo: (id) => request('DELETE', `/api/todos/${id}`),
  grillTodo: (id) => request('POST', `/api/todos/${id}/grill`),
  finishGrill: (id) => request('POST', `/api/todos/${id}/grilled`),
  // All three return the updated todo (PR links live on the todo itself),
  // so callers refresh from the response rather than re-fetching the list.
  addTodoPullRequest: (id, url) => request('POST', `/api/todos/${id}/pull-requests`, { url }),
  refreshTodoPullRequest: (id, prId) =>
    request('POST', `/api/todos/${id}/pull-requests/${prId}/refresh`),
  deleteTodoPullRequest: (id, prId) => request('DELETE', `/api/todos/${id}/pull-requests/${prId}`),
  refreshStalePullRequests: () => request('POST', '/api/pull-requests/refresh-stale'),
  // Both return the updated todo, for the same reason as the PR calls above.
  // The field name matches what the upload route reads off the form.
  uploadTodoAttachment: (id, file) => {
    const form = new FormData()
    form.append('file', file)
    return upload('POST', `/api/todos/${id}/attachments`, form)
  },
  deleteTodoAttachment: (id, attachmentId) =>
    request('DELETE', `/api/todos/${id}/attachments/${attachmentId}`),
  // 作業ログ。どちらも更新後のTODOを返す(comments はTODO自身が持つ)。
  addTodoComment: (id, body) => request('POST', `/api/todos/${id}/comments`, { body }),
  deleteTodoComment: (id, commentId) =>
    request('DELETE', `/api/todos/${id}/comments/${commentId}`),
  // `input` is `{ prompt?, workspacePath? }`. `workspacePath`, if given,
  // overrides (and persists onto the todo as the new default) where herdr
  // runs this dispatch; omitted, it falls back to the todo's saved value.
  dispatchTodo: (id, input) => request('POST', `/api/todos/${id}/dispatch`, input),
  openTodoSession: (id) => request('POST', `/api/todos/${id}/open-session`),

  listMilestones: () => request('GET', '/api/milestones'),
  createMilestone: (input) => request('POST', '/api/milestones', input),
  updateMilestone: (id, input) => request('PATCH', `/api/milestones/${id}`, input),
  completeMilestone: (id) => request('POST', `/api/milestones/${id}/complete`),
  reopenMilestone: (id) => request('POST', `/api/milestones/${id}/reopen`),
  deleteMilestone: (id) => request('DELETE', `/api/milestones/${id}`),

  listLabels: () => request('GET', '/api/labels'),
  createLabel: (input) => request('POST', '/api/labels', input),
  updateLabel: (id, input) => request('PATCH', `/api/labels/${id}`, input),
  deleteLabel: (id) => request('DELETE', `/api/labels/${id}`),

  listWorkspaces: () => request('GET', '/api/workspaces'),
  listWorkspacePathHistory: () => request('GET', '/api/workspaces/history'),
  clearWorkspacePathHistory: () => request('DELETE', '/api/workspaces/history'),
  createWorkspace: (input) => request('POST', '/api/workspaces', input),
  updateWorkspace: (id, input) => request('PATCH', `/api/workspaces/${id}`, input),
  deleteWorkspace: (id) => request('DELETE', `/api/workspaces/${id}`),

  listModels: () => request('GET', '/api/models'),

  // What this environment can actually do (herdr/claude present, MCP binary
  // path) — see lib/capabilities.js for how the UI reads it.
  getCapabilities: () => request('GET', '/api/capabilities'),

  // Both return `{ uploadDir, uploadDirIsDefault }`. updateSettings rejects a
  // path that isn't an absolute, existing, writable directory with a 400 whose
  // `error` is the specific Japanese reason — worth surfacing verbatim.
  getSettings: () => request('GET', '/api/settings'),
  updateSettings: (patch) => request('PATCH', '/api/settings', patch),
  // Opens the dot-connect skill's notes folder in Finder (macOS only).
  openNotesDir: () => request('POST', '/api/settings/notes-dir/open'),
  // Writes the bundled dot-connect skill to ~/.claude/skills; returns
  // `{ path, state }` like GET /api/settings' `skill`.
  installSkill: () => request('POST', '/api/settings/skill/install'),

  getLatestReport: () => request('GET', '/api/reports/weekly/latest'),
  getReportByWeek: (weekStart) =>
    request('GET', `/api/reports/weekly?weekStart=${encodeURIComponent(weekStart)}`),
  generateReport: (weekStart) =>
    request('POST', '/api/reports/weekly/generate', weekStart ? { weekStart } : {}),

  herdrCompatibility: () => request('GET', '/api/herdr/compatibility'),
  checkHerdrCompatibility: () => request('POST', '/api/herdr/compatibility/check'),
  herdrSync: () => request('POST', '/api/herdr/sync'),
  herdrStatus: () => request('GET', '/api/herdr/status'),

  listPromptHistory: () => request('GET', '/api/prompts/history'),
  clearPromptHistory: () => request('DELETE', '/api/prompts/history'),

  listPromptSnippets: () => request('GET', '/api/prompts/snippets'),
  createPromptSnippet: (input) => request('POST', '/api/prompts/snippets', input),
  updatePromptSnippet: (id, input) => request('PATCH', `/api/prompts/snippets/${id}`, input),
  deletePromptSnippet: (id) => request('DELETE', `/api/prompts/snippets/${id}`),
}
