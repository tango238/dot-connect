// Snippet management modal: list, create, inline-edit, delete. Reachable
// from the prompt-dispatch dialog (see promptDialog.js), but self-contained
// — it owns its own fetch + render and isn't part of the global state
// store, since snippets aren't needed anywhere else in the app.

import { api } from './api.js'
import { truncatePreview } from './lib/promptText.js'
import { isSettingsDialogOpen } from './settingsDialog.js'
import { $, escapeHtml, toast, toastError, twoStepConfirm } from './utils.js'

let snippets = []
let editingId = null // which row is showing its inline edit form, or null
let onCloseCallback = null

function snippetEditRow(s) {
  return `<div class="snippet-row snippet-row-edit" data-snippet-id="${s.id}">
    <div class="form-field grow">
      <label for="sn-edit-title-${s.id}">タイトル</label>
      <input id="sn-edit-title-${s.id}" type="text" required value="${escapeHtml(s.title)}">
    </div>
    <div class="form-field grow">
      <label for="sn-edit-body-${s.id}">本文</label>
      <textarea id="sn-edit-body-${s.id}" rows="3">${escapeHtml(s.body)}</textarea>
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-accent" data-action="save-snippet" data-id="${s.id}">保存</button>
      <button type="button" class="btn btn-ghost" data-action="cancel-edit-snippet">キャンセル</button>
    </div>
    <div class="form-error" id="sn-edit-error-${s.id}" hidden></div>
  </div>`
}

function snippetRow(s) {
  if (editingId === s.id) return snippetEditRow(s)
  return `<div class="snippet-row" data-snippet-id="${s.id}">
    <div class="snippet-row-main">
      <strong>${escapeHtml(s.title)}</strong>
      <span>${escapeHtml(truncatePreview(s.body, 60))}</span>
    </div>
    <div class="snippet-row-actions">
      <button type="button" class="btn btn-ghost" data-action="edit-snippet" data-id="${s.id}">編集</button>
      <button type="button" class="btn btn-ghost del-btn" aria-label="スニペットを削除" title="削除" data-action="delete-snippet" data-id="${s.id}">🗑</button>
    </div>
  </div>`
}

function render() {
  $('#snippet-manager-list').innerHTML = snippets.length
    ? snippets.map(snippetRow).join('')
    : `<p class="prompt-panel-empty">スニペットはまだありません。</p>`
}

async function refresh() {
  try {
    snippets = await api.listPromptSnippets()
    render()
  } catch (err) {
    toastError(err.message)
  }
}

async function createSnippet() {
  const title = $('#sn-new-title').value.trim()
  const body = $('#sn-new-body').value.trim()
  const errorEl = $('#sn-new-error')
  if (!title || !body) {
    errorEl.textContent = 'タイトルと本文は必須です'
    errorEl.hidden = false
    return
  }
  errorEl.hidden = true
  try {
    await api.createPromptSnippet({ title, body })
    toast('スニペットを作成しました')
    $('#sn-new-title').value = ''
    $('#sn-new-body').value = ''
    await refresh()
  } catch (err) {
    toastError(err.message)
  }
}

async function saveSnippet(id) {
  const title = $(`#sn-edit-title-${id}`)?.value.trim()
  const body = $(`#sn-edit-body-${id}`)?.value.trim()
  const errorEl = $(`#sn-edit-error-${id}`)
  if (!title || !body) {
    if (errorEl) {
      errorEl.textContent = 'タイトルと本文は必須です'
      errorEl.hidden = false
    }
    return
  }
  try {
    await api.updatePromptSnippet(id, { title, body })
    toast('スニペットを更新しました')
    editingId = null
    await refresh()
  } catch (err) {
    toastError(err.message)
  }
}

async function deleteSnippet(id) {
  try {
    await api.deletePromptSnippet(id)
    toast('スニペットを削除しました')
    await refresh()
  } catch (err) {
    toastError(err.message)
  }
}

function handleClick(ev) {
  const btn = ev.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  const id = Number(btn.dataset.id)

  if (action === 'create-snippet') {
    createSnippet()
  } else if (action === 'edit-snippet') {
    editingId = id
    render()
  } else if (action === 'cancel-edit-snippet') {
    editingId = null
    render()
  } else if (action === 'save-snippet') {
    saveSnippet(id)
  } else if (action === 'delete-snippet') {
    twoStepConfirm(btn, () => deleteSnippet(id))
  } else if (action === 'close-snippet-manager') {
    closeSnippetManager()
  }
}

export function isSnippetManagerOpen() {
  return !$('#snippet-manager-backdrop').hidden
}

/** Opens the modal, fetching fresh snippets every time (the list is small
 * and can be edited elsewhere in the same session, so no cross-open cache).
 * `onClose` fires once, when the modal is dismissed — the prompt dialog
 * uses it to pick up any edits made here. */
export async function openSnippetManager(onClose) {
  onCloseCallback = onClose ?? null
  editingId = null
  $('#snippet-manager-backdrop').hidden = false
  render()
  await refresh()
}

export function closeSnippetManager() {
  $('#snippet-manager-backdrop').hidden = true
  const cb = onCloseCallback
  onCloseCallback = null
  cb?.()
}

export function initSnippetManager() {
  $('#snippet-manager-backdrop').addEventListener('click', (ev) => {
    if (ev.target.id === 'snippet-manager-backdrop') closeSnippetManager()
  })
  $('#snippet-manager-modal').addEventListener('click', handleClick)
  // Escape belongs to whichever modal is on top: settings can be opened
  // (⌘,) over this dialog, so it must not close underneath it.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !isSnippetManagerOpen()) return
    if (isSettingsDialogOpen()) return
    closeSnippetManager()
  })
}
