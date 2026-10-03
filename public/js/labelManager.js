// Label management modal: list, create, inline-edit, delete. Reachable
// from the milestones page header ("ラベルを管理"). Self-contained like
// snippetManager.js — owns its own fetch + render, and reports back via an
// onClose callback so the milestones page can refetch labels/milestones
// (every milestone's labelName/labelColor is a JOIN snapshot that a rename
// or delete here would otherwise leave stale).

import { api } from './api.js'
import { isSettingsDialogOpen } from './settingsDialog.js'
import { $, escapeHtml, toast, toastError, twoStepConfirm } from './utils.js'

let labels = []
let editingId = null // which row is showing its inline edit form, or null
let onCloseCallback = null

function labelEditRow(l) {
  return `<div class="label-row label-row-edit" data-label-id="${l.id}">
    <div class="form-field grow">
      <label for="lb-edit-name-${l.id}">名前</label>
      <input id="lb-edit-name-${l.id}" type="text" required value="${escapeHtml(l.name)}">
    </div>
    <div class="form-field">
      <label for="lb-edit-color-${l.id}">色</label>
      <input id="lb-edit-color-${l.id}" type="color" value="${escapeHtml(l.color)}">
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-accent" data-action="save-label" data-id="${l.id}">保存</button>
      <button type="button" class="btn btn-ghost" data-action="cancel-edit-label">キャンセル</button>
    </div>
    <div class="form-error" id="lb-edit-error-${l.id}" hidden></div>
  </div>`
}

function labelRow(l) {
  if (editingId === l.id) return labelEditRow(l)
  return `<div class="label-row" data-label-id="${l.id}">
    <div class="label-row-main">
      <span class="ms-dot" style="background:${escapeHtml(l.color)}"></span>
      <strong>${escapeHtml(l.name)}</strong>
    </div>
    <div class="label-row-actions">
      <button type="button" class="btn btn-ghost" data-action="edit-label" data-id="${l.id}">編集</button>
      <button type="button" class="btn btn-ghost del-btn" aria-label="ラベルを削除" title="削除" data-action="delete-label" data-id="${l.id}">🗑</button>
    </div>
  </div>`
}

function render() {
  $('#label-manager-list').innerHTML = labels.length
    ? labels.map(labelRow).join('')
    : `<p class="prompt-panel-empty">ラベルはまだありません。</p>`
}

async function refresh() {
  try {
    labels = await api.listLabels()
    render()
  } catch (err) {
    toastError(err.message)
  }
}

async function createLabel() {
  const name = $('#lb-new-name').value.trim()
  const color = $('#lb-new-color').value
  const errorEl = $('#lb-new-error')
  if (!name) {
    errorEl.textContent = '名前は必須です'
    errorEl.hidden = false
    return
  }
  errorEl.hidden = true
  try {
    // Name-uniqueness (409) surfaces via the backend's own message.
    await api.createLabel({ name, color })
    toast('ラベルを作成しました')
    $('#lb-new-name').value = ''
    await refresh()
  } catch (err) {
    toastError(err.message)
  }
}

async function saveLabel(id) {
  const name = $(`#lb-edit-name-${id}`)?.value.trim()
  const color = $(`#lb-edit-color-${id}`)?.value
  const errorEl = $(`#lb-edit-error-${id}`)
  if (!name) {
    if (errorEl) {
      errorEl.textContent = '名前は必須です'
      errorEl.hidden = false
    }
    return
  }
  try {
    await api.updateLabel(id, { name, color })
    toast('ラベルを更新しました')
    editingId = null
    await refresh()
  } catch (err) {
    toastError(err.message)
  }
}

async function deleteLabel(id) {
  const l = labels.find((x) => x.id === id)
  try {
    const result = await api.deleteLabel(id)
    const suffix = result.unlinkedMilestones
      ? `(${result.unlinkedMilestones}件のマイルストーンからラベルが外れました)`
      : ''
    toast(`「${escapeHtml(l?.name ?? '')}」を削除しました${suffix}`)
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

  if (action === 'create-label') {
    createLabel()
  } else if (action === 'edit-label') {
    editingId = id
    render()
  } else if (action === 'cancel-edit-label') {
    editingId = null
    render()
  } else if (action === 'save-label') {
    saveLabel(id)
  } else if (action === 'delete-label') {
    twoStepConfirm(btn, () => deleteLabel(id))
  } else if (action === 'close-label-manager') {
    closeLabelManager()
  }
}

export function isLabelManagerOpen() {
  return !$('#label-manager-backdrop').hidden
}

/** Opens the modal, fetching fresh labels every time. `onClose` fires once,
 * when the modal is dismissed — the milestones page uses it to refetch
 * labels/milestones so cards and forms reflect whatever changed here. */
export async function openLabelManager(onClose) {
  onCloseCallback = onClose ?? null
  editingId = null
  $('#label-manager-backdrop').hidden = false
  render()
  await refresh()
}

export function closeLabelManager() {
  $('#label-manager-backdrop').hidden = true
  const cb = onCloseCallback
  onCloseCallback = null
  cb?.()
}

export function initLabelManager() {
  $('#label-manager-backdrop').addEventListener('click', (ev) => {
    if (ev.target.id === 'label-manager-backdrop') closeLabelManager()
  })
  $('#label-manager-modal').addEventListener('click', handleClick)
  // Escape belongs to whichever modal is on top: settings can be opened
  // (⌘,) over this dialog, so it must not close underneath it.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !isLabelManagerOpen()) return
    if (isSettingsDialogOpen()) return
    closeLabelManager()
  })
}
