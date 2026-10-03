// Workspace (work directory) management modal: list, create, inline-edit,
// delete. Reachable from the TODO page header ("作業ディレクトリを管理").
// Self-contained like labelManager.js/snippetManager.js — owns its own
// fetch + render, and reports back via an onClose callback so the TODO
// page can refetch workspaces (its create/edit forms and the dispatch
// dialog all read the registered list for their datalist suggestions).
//
// Two sections, both about workspacePath, deliberately in one modal: the
// registered directories (hand-curated, named — the "snippet" side) and the
// recently-used history (automatic, bare paths). The history section itself
// lives in workspacePathHistory.js; this module only hosts it and routes
// its clicks.
//
// Name-uniqueness (409) and non-absolute-path (400) are the backend's own
// validation — this module only checks for blank fields client-side and
// otherwise surfaces the backend's message as-is via toastError.

import { api } from './api.js'
import { isSettingsDialogOpen } from './settingsDialog.js'
import { $, escapeHtml, toast, toastError, twoStepConfirm } from './utils.js'
import {
  clearWorkspacePathHistory,
  closeRegisterForm,
  loadWorkspacePathHistory,
  openRegisterForm,
  registerHistoryPath,
  renderWorkspacePathHistory,
} from './workspacePathHistory.js'

let workspaces = []
let editingId = null // which row is showing its inline edit form, or null
let onCloseCallback = null

function workspaceEditRow(w) {
  return `<div class="label-row label-row-edit" data-workspace-id="${w.id}">
    <div class="form-field grow">
      <label for="ws-edit-name-${w.id}">名前</label>
      <input id="ws-edit-name-${w.id}" type="text" required value="${escapeHtml(w.name)}">
    </div>
    <div class="form-field grow">
      <label for="ws-edit-path-${w.id}">パス(絶対パス)</label>
      <input id="ws-edit-path-${w.id}" type="text" required value="${escapeHtml(w.path)}">
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-accent" data-action="save-workspace" data-id="${w.id}">保存</button>
      <button type="button" class="btn btn-ghost" data-action="cancel-edit-workspace">キャンセル</button>
    </div>
    <div class="form-error" id="ws-edit-error-${w.id}" hidden></div>
  </div>`
}

function workspaceRow(w) {
  if (editingId === w.id) return workspaceEditRow(w)
  return `<div class="label-row" data-workspace-id="${w.id}">
    <div class="label-row-main">
      <strong>${escapeHtml(w.name)}</strong>
      <span class="todo-date">${escapeHtml(w.path)}</span>
    </div>
    <div class="label-row-actions">
      <button type="button" class="btn btn-ghost" data-action="edit-workspace" data-id="${w.id}">編集</button>
      <button type="button" class="btn btn-ghost del-btn" aria-label="作業ディレクトリを削除" title="削除" data-action="delete-workspace" data-id="${w.id}">🗑</button>
    </div>
  </div>`
}

function render() {
  $('#workspace-manager-list').innerHTML = workspaces.length
    ? workspaces.map(workspaceRow).join('')
    : `<p class="prompt-panel-empty">作業ディレクトリはまだ登録されていません。</p>`
  const historyEl = $('#workspace-history-list')
  if (historyEl) historyEl.innerHTML = renderWorkspacePathHistory()
}

async function refresh() {
  try {
    workspaces = await api.listWorkspaces()
  } catch (err) {
    toastError(err.message)
  }
  // Loaded together so one render covers both sections; loadWorkspacePath-
  // History reports its own failures and resolves either way, so a history
  // fetch error never keeps the registered list from rendering.
  await loadWorkspacePathHistory()
  render()
}

async function createWorkspace() {
  const name = $('#ws-new-name').value.trim()
  const path = $('#ws-new-path').value.trim()
  const errorEl = $('#ws-new-error')
  if (!name || !path) {
    errorEl.textContent = '名前とパスは必須です'
    errorEl.hidden = false
    return
  }
  errorEl.hidden = true
  try {
    // Name-uniqueness (409) and non-absolute-path (400) surface via the
    // backend's own message.
    await api.createWorkspace({ name, path })
    toast('作業ディレクトリを登録しました')
    $('#ws-new-name').value = ''
    $('#ws-new-path').value = ''
    await refresh()
  } catch (err) {
    toastError(err.message)
  }
}

async function saveWorkspace(id) {
  const name = $(`#ws-edit-name-${id}`)?.value.trim()
  const path = $(`#ws-edit-path-${id}`)?.value.trim()
  const errorEl = $(`#ws-edit-error-${id}`)
  if (!name || !path) {
    if (errorEl) {
      errorEl.textContent = '名前とパスは必須です'
      errorEl.hidden = false
    }
    return
  }
  try {
    await api.updateWorkspace(id, { name, path })
    toast('作業ディレクトリを更新しました')
    editingId = null
    await refresh()
  } catch (err) {
    toastError(err.message)
  }
}

async function deleteWorkspace(id) {
  const w = workspaces.find((x) => x.id === id)
  try {
    await api.deleteWorkspace(id)
    toast(`「${escapeHtml(w?.name ?? '')}」を削除しました`)
    await refresh()
  } catch (err) {
    toastError(err.message)
  }
}

async function saveHistoryWorkspace(id) {
  const name = $(`#wsh-name-${id}`)?.value.trim()
  const errorEl = $(`#wsh-error-${id}`)
  if (!name) {
    if (errorEl) {
      errorEl.textContent = '登録名は必須です'
      errorEl.hidden = false
    }
    return
  }
  try {
    await registerHistoryPath(id, name)
    await refresh()
  } catch (err) {
    toastError(err.message)
  }
}

async function clearHistory() {
  await clearWorkspacePathHistory()
  render()
}

function handleClick(ev) {
  const btn = ev.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  const id = Number(btn.dataset.id)

  if (action === 'register-history-workspace') {
    openRegisterForm(id)
    render()
    return
  }
  if (action === 'cancel-history-workspace') {
    closeRegisterForm()
    render()
    return
  }
  if (action === 'save-history-workspace') {
    saveHistoryWorkspace(id)
    return
  }
  if (action === 'clear-workspace-history') {
    twoStepConfirm(btn, clearHistory)
    return
  }

  if (action === 'create-workspace') {
    createWorkspace()
  } else if (action === 'edit-workspace') {
    editingId = id
    render()
  } else if (action === 'cancel-edit-workspace') {
    editingId = null
    render()
  } else if (action === 'save-workspace') {
    saveWorkspace(id)
  } else if (action === 'delete-workspace') {
    twoStepConfirm(btn, () => deleteWorkspace(id))
  } else if (action === 'close-workspace-manager') {
    closeWorkspaceManager()
  }
}

export function isWorkspaceManagerOpen() {
  return !$('#workspace-manager-backdrop').hidden
}

/** Opens the modal, fetching fresh workspaces every time. `onClose` fires
 * once, when the modal is dismissed — the TODO page uses it to refetch
 * workspaces so form/datalist suggestions reflect whatever changed here. */
export async function openWorkspaceManager(onClose) {
  onCloseCallback = onClose ?? null
  editingId = null
  closeRegisterForm()
  $('#workspace-manager-backdrop').hidden = false
  render()
  await refresh()
}

export function closeWorkspaceManager() {
  $('#workspace-manager-backdrop').hidden = true
  const cb = onCloseCallback
  onCloseCallback = null
  cb?.()
}

export function initWorkspaceManager() {
  $('#workspace-manager-backdrop').addEventListener('click', (ev) => {
    if (ev.target.id === 'workspace-manager-backdrop') closeWorkspaceManager()
  })
  $('#workspace-manager-modal').addEventListener('click', handleClick)
  // Escape belongs to whichever modal is on top: settings can be opened
  // (⌘,) over this dialog, so it must not close underneath it.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !isWorkspaceManagerOpen()) return
    if (isSettingsDialogOpen()) return
    closeWorkspaceManager()
  })
}
