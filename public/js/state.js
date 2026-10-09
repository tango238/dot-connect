// Central, immutable app state. Every update replaces the whole object and
// notifies subscribers: the top-level render in main.js, plus any module
// that needs to re-render itself on state changes (todoDetailDialog.js).

import { hasLinkedSession as todosHaveLinkedSession } from './lib/sessionPolling.js'
import { wipCount } from './lib/wipLimit.js'

let state = {
  todos: [],
  milestones: [],
  labels: [],
  // Registered work directories (name + absolute path) offered as
  // datalist suggestions on the TODO forms and the dispatch dialog; models
  // is the allowlisted Claude Code model names from GET /api/models.
  workspaces: [],
  models: [],
  // GET /api/capabilities, or null while it hasn't landed (or its fetch
  // failed) — null means "assume everything works", so a capabilities
  // hiccup never greys out a perfectly good environment.
  capabilities: null,
  // GET /api/settings, or null before it lands. The WIP meter and dispatch
  // buttons read wipLimitEnabled/wipLimit from here; null hides the meter
  // and leaves dispatch to the server's own check.
  settings: null,
  // 既定は「最近の更新」——一覧を開いて最初に見たいのは、いま動いている
  // 仕事だから。全件は「すべて」チップに退避している。
  filter: 'recent',
  herdr: { connected: false, totalPanes: 0 },
  report: null,
  reportStatus: 'idle', // 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'generating'
  // The week currently displayed (YYYY-MM-DD, Monday) and the latest week a
  // report actually exists for — the latter bounds the "→" nav button.
  reportWeekStart: null,
  reportLatestWeekStart: null,
  loaded: { todos: false, milestones: false, herdr: false, labels: false, workspaces: false, models: false },
}

const listeners = new Set()

export function getState() {
  return state
}

/** Merges `patch` into state (shallow) and notifies subscribers. */
export function setState(patch) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener(state)
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function activeMilestones() {
  return state.milestones.filter((m) => m.status !== 'done')
}

export function milestoneById(id) {
  return state.milestones.find((m) => m.id === id) ?? null
}

export function hasLinkedSession() {
  return todosHaveLinkedSession(state.todos)
}

// Also the WIP count — the WIP limit counts exactly these sessions.
export function managedSessionCount() {
  return wipCount(state.todos)
}
