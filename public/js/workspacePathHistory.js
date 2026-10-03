// Recently-used workspace paths: the workspacePath counterpart to the
// prompt history panel. Recorded automatically on every successful dispatch
// (never on merely saving a TODO), so this list is "directories herdr has
// actually run in".
//
// Rendered inside the workspace manager modal as a second section below the
// registered directories, and read by the dispatch dialog for its own
// "履歴から選ぶ" panel. Kept in its own module so workspaceManager.js stays
// about the registered list alone.

import { api } from './api.js'
import { escapeHtml, toast, toastError } from './utils.js'

let history = []
// Which history row has its "register this path" form open, or null.
let registeringId = null

export function getWorkspacePathHistory() {
  return history
}

export async function loadWorkspacePathHistory() {
  try {
    history = await api.listWorkspacePathHistory()
  } catch (err) {
    toastError(err.message)
  }
  return history
}

function registerForm(entry) {
  return `<div class="label-row label-row-edit" data-history-id="${entry.id}">
    <div class="form-field grow">
      <label for="wsh-name-${entry.id}">登録名</label>
      <input id="wsh-name-${entry.id}" type="text" required placeholder="例: my-app">
      <p class="field-hint mono">${escapeHtml(entry.path)}</p>
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-accent" data-action="save-history-workspace" data-id="${entry.id}">登録</button>
      <button type="button" class="btn btn-ghost" data-action="cancel-history-workspace">キャンセル</button>
    </div>
    <div class="form-error" id="wsh-error-${entry.id}" hidden></div>
  </div>`
}

function historyRow(entry) {
  if (registeringId === entry.id) return registerForm(entry)
  return `<div class="label-row" data-history-id="${entry.id}">
    <div class="label-row-main">
      <span class="todo-date mono">${escapeHtml(entry.path)}</span>
    </div>
    <div class="label-row-actions">
      <button type="button" class="btn btn-ghost" data-action="register-history-workspace" data-id="${entry.id}">登録済みに追加</button>
    </div>
  </div>`
}

/** Renders the history section's HTML. The caller owns where it goes. */
export function renderWorkspacePathHistory() {
  const rows = history.length
    ? history.map(historyRow).join('')
    : `<p class="prompt-panel-empty">herdrに投入した作業ディレクトリがここに履歴として残ります。</p>`
  return `<div class="prompt-panel-head">
      <span>最近使ったパス(最大50件)</span>
      <button type="button" class="btn btn-ghost del-btn" data-action="clear-workspace-history">履歴をすべて消去</button>
    </div>
    ${rows}`
}

export function openRegisterForm(id) {
  registeringId = id
}

export function closeRegisterForm() {
  registeringId = null
}

/**
 * Promotes a history entry into the registered list. There is no dedicated
 * endpoint for this — a registered workspace is just a name plus a path, so
 * it goes through the ordinary create call (duplicate-name 409 and friends
 * surface as the backend's own message).
 * @returns {Promise<boolean>} whether it was registered
 */
export async function registerHistoryPath(id, name) {
  const entry = history.find((h) => h.id === id)
  if (!entry) return false
  await api.createWorkspace({ name, path: entry.path })
  registeringId = null
  toast(`「${name}」を登録しました`)
  return true
}

export async function clearWorkspacePathHistory() {
  try {
    await api.clearWorkspacePathHistory()
    history = []
    registeringId = null
    toast('作業ディレクトリの履歴を消去しました')
  } catch (err) {
    toastError(err.message)
  }
}
