// Data loading glue: fetches from the API and writes results into state.
// Centralized here so action handlers in the page modules stay about
// rendering/wiring, not fetch-then-setState boilerplate.

import { api } from './api.js'
import { getState, setState } from './state.js'
import { escapeHtml, toast, toastError } from './utils.js'

export async function refreshTodos() {
  const todos = await api.listTodos()
  setState({ todos })
}

export async function refreshMilestones() {
  const milestones = await api.listMilestones()
  setState({ milestones })
}

export async function refreshLabels() {
  const labels = await api.listLabels()
  setState({ labels })
}

export async function refreshWorkspaces() {
  const workspaces = await api.listWorkspaces()
  setState({ workspaces })
}

/** Todo and milestone progress are entangled (linked counts), so most
 * mutations need to refresh both to keep every page in sync. */
export async function refreshBoth() {
  const [todos, milestones] = await Promise.all([api.listTodos(), api.listMilestones()])
  setState({ todos, milestones })
}

/** Toggles a todo's done/not-done status. Shared by the row's own
 * checkbox/complete button (todos.js) and the detail dialog's complete
 * button (todoDetailDialog.js) — both just need "call the API, then update
 * state", which is what this module is for. */
export async function toggleTodoComplete(id) {
  const todo = getState().todos.find((t) => t.id === id)
  if (!todo) return
  try {
    if (todo.status === 'done') {
      await api.reopenTodo(id)
      toast(`「${escapeHtml(todo.title)}」を未完了に戻しました`)
    } else {
      await api.completeTodo(id)
      toast(`「${escapeHtml(todo.title)}」を完了にしました`)
    }
    await refreshBoth()
  } catch (err) {
    toastError(err.message)
  }
}

/** A label CRUD mutation (rename, recolor, delete) invalidates the
 * milestones list too — every milestone's labelName/labelColor is a JOIN
 * snapshot, and a delete auto-unlinks whichever milestones had it. */
export async function refreshLabelsAndMilestones() {
  const [labels, milestones] = await Promise.all([api.listLabels(), api.listMilestones()])
  setState({ labels, milestones })
}

export async function refreshHerdrStatus() {
  const status = await api.herdrStatus()
  setState({ herdr: status })
}

export async function loadInitial() {
  const [todos, milestones, herdr, labels, workspaces, models, capabilities] = await Promise.all([
    api.listTodos(),
    api.listMilestones(),
    api.herdrStatus(),
    api.listLabels(),
    api.listWorkspaces(),
    api.listModels(),
    // Capabilities only decide whether some buttons are greyed out, so a
    // failure here degrades to null (everything enabled) rather than
    // rejecting the Promise.all and taking the whole initial load with it.
    api.getCapabilities().catch(() => null),
  ])
  setState({
    todos,
    milestones,
    herdr,
    labels,
    workspaces,
    models,
    capabilities,
    loaded: { todos: true, milestones: true, herdr: true, labels: true, workspaces: true, models: true },
  })
}

export async function syncHerdrThenRefreshTodos() {
  await api.herdrSync()
  const todos = await api.listTodos()
  setState({ todos })
}

// gh の呼び出しを伴うので10秒ポーリングには載せず、専用の長い間隔で回す。
// 失敗は握り潰す——PR状態が古いままでも一覧は動くし、原因は各PRの
// fetchError として画面に出る。
export async function refreshStalePullRequests() {
  try {
    const { refreshed } = await api.refreshStalePullRequests()
    if (refreshed > 0) await refreshTodos()
  } catch {
    // 意図的に無視(トーストを出さない)
  }
}

// A background snapshot is fetched separately from applying it so the caller
// can recheck whether a draft was opened while these requests were in flight.
export async function loadLiveSnapshot() {
  const [todos, milestones, labels, workspaces] = await Promise.all([
    api.listTodos(), api.listMilestones(), api.listLabels(), api.listWorkspaces(),
  ])
  return { todos, milestones, labels, workspaces }
}

export function applyLiveSnapshot(snapshot) {
  const state = getState()
  if (Object.keys(snapshot).some((key) => JSON.stringify(state[key]) !== JSON.stringify(snapshot[key]))) {
    setState(snapshot)
  }
}
