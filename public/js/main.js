// Entry point: wires navigation, loads initial data, and drives the 10s
// herdr status poll. Each page module owns its own rendering + actions.

import { loadInitial, refreshHerdrStatus, refreshStalePullRequests, syncHerdrThenRefreshTodos } from './data.js'
import { initLabelManager } from './labelManager.js'
import { isSidebarCollapsed, persistSidebarCollapsed } from './lib/sidebarState.js'
import { hasOpenMilestoneForm, initMilestones, renderMilestones, renderSideMilestones } from './milestones.js'
import { initPromptDialog } from './promptDialog.js'
import { ensureReportLoaded, initReport, regenerateLatestReport, renderReport } from './report.js'
import { initPlan, renderPlan } from './plan.js'
import { initPomodoro, refreshPomodoroLabel } from './pomodoro.js'
import { applyUploadDir, initSettingsDialog, openSettingsDialog } from './settingsDialog.js'
import { initSnippetManager } from './snippetManager.js'
import { getState, hasLinkedSession, managedSessionCount, subscribe } from './state.js'
import { initTodoDetailDialog, openTodoDetail } from './todoDetailDialog.js'
import { hasOpenTodoForm, initTodos, renderTodos, renderWorkspaceDatalist } from './todos.js'
import { initWorkspaceManager } from './workspaceManager.js'
import { $, $all, toastError } from './utils.js'

const POLL_MS = 10_000
const PR_REFRESH_MS = 5 * 60_000

const PAGE_RENDERERS = {
  todos: renderTodos,
  milestones: renderMilestones,
  plan: renderPlan,
  report: renderReport,
}

function activePageName() {
  const el = document.querySelector('.page.active')
  return el ? el.id.replace('page-', '') : 'todos'
}

function renderActivePage() {
  const name = activePageName()
  PAGE_RENDERERS[name]?.()
}

function renderSidebar() {
  const { todos, milestones, herdr } = getState()
  $('#count-todos').textContent = todos.filter((t) => t.status !== 'done').length
  $('#count-ms').textContent = milestones.filter((m) => m.status !== 'done').length
  const count = managedSessionCount()
  $('#hs-count').textContent = count
  $('#hs-conn').textContent = herdr.connected ? '接続中' : '未接続'
  $('#hs-pulse').classList.toggle('disconnected', !herdr.connected)
  // The detail text is hidden while the sidebar is collapsed (see
  // .sidebar-collapsed .hs-detail), so mirror it into a title attribute —
  // that's the only way to still see connection status at a glance.
  $('#herdr-status').title = `herdr ${herdr.connected ? '接続中' : '未接続'} / ${count}件を管理中`
  renderSideMilestones()
  refreshPomodoroLabel()
}

// Icon-only collapsed rail (vs. hiding the sidebar outright) so nav stays
// usable and the state is trivial to reverse. Persisted so it survives a
// reload — see lib/sidebarState.js. The class lives on <html>, not
// `.sidebar`, so the inline pre-paint script in index.html's <head> can
// apply it before `.sidebar` exists in the DOM and avoid a flash of the
// expanded sidebar.
function applySidebarCollapsed(collapsed) {
  document.documentElement.classList.toggle('sidebar-collapsed', collapsed)
  const toggle = $('#sidebar-toggle')
  toggle.textContent = collapsed ? '»' : '«'
  toggle.setAttribute('aria-expanded', String(!collapsed))
  toggle.title = collapsed ? 'メニューを展開' : 'メニューを折りたたむ'
}

function initSidebarToggle() {
  let collapsed = isSidebarCollapsed(window.localStorage)
  applySidebarCollapsed(collapsed)
  $('#sidebar-toggle').addEventListener('click', () => {
    collapsed = !collapsed
    persistSidebarCollapsed(window.localStorage, collapsed)
    applySidebarCollapsed(collapsed)
  })
}

function switchToPage(name) {
  $all('.nav-btn').forEach((btn) => {
    if (btn.dataset.page === name) btn.setAttribute('aria-current', 'page')
    else btn.removeAttribute('aria-current')
  })
  $all('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`))
  if (name === 'report') {
    ensureReportLoaded().then(renderActivePage)
  }
  renderActivePage()
}

function initNav() {
  $all('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchToPage(btn.dataset.page))
  })
}

async function pollTick() {
  // Skip the whole tick while an inline edit/add form is open anywhere —
  // its poll-driven state update would trigger a re-render that rebuilds
  // the form from state and wipes out whatever the user is mid-typing
  // (F43). User-triggered refreshes (save, delete, ...) are untouched by
  // this — they call refreshBoth()/refreshTodos() directly, not pollTick.
  if (hasOpenTodoForm() || hasOpenMilestoneForm()) return
  try {
    if (hasLinkedSession()) {
      await syncHerdrThenRefreshTodos()
    }
    await refreshHerdrStatus()
  } catch (err) {
    toastError(err.message)
  }
}

// Same open-form guard as pollTick (F43): refreshStalePullRequests() also
// ends in refreshTodos() → setState → renderTodoList() rebuilding
// #todo-list from state, which would wipe an open inline form's unsaved
// input if this fired mid-edit.
async function prRefreshTick() {
  if (hasOpenTodoForm() || hasOpenMilestoneForm()) return
  await refreshStalePullRequests()
}

async function bootstrap() {
  initSidebarToggle()
  initNav()
  initTodos()
  initMilestones()
  initPlan()
  initReport()
  initPromptDialog()
  initTodoDetailDialog()
  initSettingsDialog()
  initSnippetManager()
  initLabelManager()
  initWorkspaceManager()
  initPomodoro({ onOpenTodo: openTodoDetail })

  subscribe(() => {
    renderSidebar()
    // Safe to run unconditionally on every state change, regardless of the
    // active page or any open inline form — see index.html's comment on
    // the <datalist> element for why this can never wipe form input.
    renderWorkspaceDatalist()
    renderActivePage()
  })

  try {
    await loadInitial()
  } catch (err) {
    toastError(err.message)
  }

  void refreshStalePullRequests()
  setInterval(pollTick, POLL_MS)
  setInterval(() => void prRefreshTick(), PR_REFRESH_MS)
}

// ネイティブメニュー(Rust)からの一方向シグナルの受け口。ウィンドウは
// リモートoriginで Tauri IPC を持たないため、Rust 側は eval でここを叩く。
// bootstrap の完了を待たずに定義するのは、起動直後にメニューを選ばれても
// 取りこぼさないようにするため。
window.__dotConnect = {
  openSettings: () => openSettingsDialog(),
  regenerateWeeklyReport: () => void regenerateLatestReport(),
  // 「アップロード先フォルダを選択…」で選ばれたパスが渡ってくる。設定
  // ダイアログが開いていなくても保存できる(開いていれば描画も追従する)。
  setUploadDir: (path) => void applyUploadDir(path),
}

bootstrap()
