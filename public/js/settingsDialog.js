// "Settings" modal: connection info for reaching dot-connect from outside
// tools (MCP clients, scripts) on this machine, plus the one editable
// preference — where uploaded attachments are stored. Superseded the
// sidebar's standalone MCP row (a single, always-visible copy button) —
// this dialog holds that row plus the API base URL, and works whether or
// not a bundled MCP binary is present (see buildSettingsRows).
//
// Opened via the native "File > 設定…" (⌘,) menu item, which the Rust menu
// handler reaches by eval'ing window.__dotConnect.openSettings() (see
// main.js — the window has no Tauri IPC to a remote origin, so this eval
// hook is the only channel). Also reachable directly from the browser
// console via openSettingsDialog().

import { herdrCompatibilityHtml } from './lib/herdrCompatibility.js'
import { api } from './api.js'
import { buildSettingsRows } from './lib/settingsInfo.js'
import { getState, subscribe } from './state.js'
import { $, escapeHtml, toast, toastError } from './utils.js'

let open = false
// Last known GET /api/settings response, or null before the first load.
let settings = null
// What's in the text box. Kept apart from `settings` so a rejected save can
// leave the typed path in place instead of making the user retype it.
let draft = null
let saving = false
let herdrInfo = null
let checkingHerdr = false
let herdrError = ''

function renderHerdr() {
  const host = $('#settings-herdr')
  if (host) host.innerHTML = herdrCompatibilityHtml(herdrInfo, checkingHerdr, herdrError)
}

async function loadHerdr(force = false) {
  if (checkingHerdr) return
  checkingHerdr = true
  herdrError = ''
  renderHerdr()
  try {
    herdrInfo = await (force ? api.checkHerdrCompatibility() : api.herdrCompatibility())
  } catch (err) {
    herdrError = err.message
  } finally {
    checkingHerdr = false
    if (open) renderHerdr()
  }
}

function rows() {
  return buildSettingsRows(getState().capabilities, window.location.origin)
}

function rowHtml(row, index) {
  const copyBtn = row.copyable
    ? `<button type="button" class="btn btn-ghost" data-action="copy-setting" data-index="${index}">コピー</button>`
    : ''
  return `<div class="settings-row">
    <div class="settings-label">${escapeHtml(row.label)}</div>
    <div class="settings-value">${escapeHtml(row.value)}</div>
    ${copyBtn}
  </div>`
}

function uploadDirValue() {
  return draft ?? settings?.uploadDir ?? ''
}

// Rendered into its own container, separate from the read-only rows above:
// those re-render on every state change (the 10s herdr poll included), and
// rebuilding this row's <input> along with them would drop the caret — and
// any unsaved path — mid-typing.
function renderUploadRow() {
  const host = $('#settings-upload-dir-row')
  if (!host) return
  const loading = settings === null
  const flag =
    !loading && settings.uploadDirIsDefault
      ? '<span class="settings-flag">(既定)</span>'
      : ''
  host.innerHTML = `
    <div class="settings-row">
      <div class="settings-label">アップロード先フォルダ</div>
      <div class="settings-value settings-edit">
        <input type="text" id="settings-upload-dir" value="${escapeHtml(uploadDirValue())}"
          placeholder="${loading ? '読み込み中…' : '/Users/you/Documents/dot-connect'}"
          spellcheck="false" autocomplete="off" aria-label="アップロード先フォルダ"
          ${loading || saving ? 'disabled' : ''}>
        ${flag}
      </div>
      <button type="button" class="btn" data-action="save-upload-dir" ${loading || saving ? 'disabled' : ''}>保存</button>
    </div>
    <p class="field-hint">添付ファイルの保存先です。絶対パスで、既に存在する書き込み可能なフォルダを指定してください。変更しても既にアップロード済みのファイルは移動しません(元のフォルダに残ります)。</p>`
}

function renderDialog() {
  const backdrop = $('#settings-backdrop')
  if (!open) {
    backdrop.hidden = true
    return
  }
  backdrop.hidden = false
  $('#settings-dialog').innerHTML = `
    <div class="modal-head">
      <h2>設定</h2>
      <button type="button" class="btn btn-ghost" data-action="close-settings" aria-label="閉じる">×</button>
    </div>
    <div class="modal-sub">外部ツール(MCPクライアントやスクリプト)から dot-connect につなぐための情報です。</div>
    <div id="settings-info-rows">${rows().map(rowHtml).join('')}</div>
    <p class="field-hint">書き込み系のAPI(POST / PATCH / DELETE)には <code>Origin: ${escapeHtml(window.location.origin)}</code> ヘッダーが必要です。加えて、body を伴う POST / PATCH には <code>Content-Type: application/json</code> も必要です(無いと415)。</p>
    <div id="settings-upload-dir-row" class="settings-section"></div>
    <section id="settings-herdr" class="settings-section" aria-live="polite"></section>
    <div class="modal-footer">
      <button type="button" class="btn btn-ghost" data-action="close-settings">閉じる</button>
    </div>`
  renderUploadRow()
  renderHerdr()
}

async function loadSettings() {
  try {
    settings = await api.getSettings()
    // Only adopt the server's value if the user hasn't started typing while
    // the request was in flight.
    if (draft === null) draft = settings.uploadDir
  } catch (err) {
    toastError(err.message)
  }
  renderUploadRow()
}

export function openSettingsDialog() {
  if (open) return
  open = true
  // A draft left over from a rejected save belongs to the previous visit;
  // reopening should show what the server actually has.
  draft = null
  renderDialog()
  void loadSettings()
  void loadHerdr()
}

/**
 * Saves a new upload directory and reflects the result in the open dialog.
 * Also the target of window.__dotConnect.setUploadDir (see main.js), which
 * the native "アップロード先フォルダを選択…" menu item eval's — so it has to
 * work with the dialog closed too.
 * @param {string} path
 */
export async function applyUploadDir(path) {
  if (saving) return
  saving = true
  draft = path
  renderUploadRow()
  try {
    settings = await api.updateSettings({ uploadDir: path })
    draft = settings.uploadDir
    toast('アップロード先フォルダを変更しました')
  } catch (err) {
    // The server's message names the specific problem (絶対パス / 見つかりません
    // / 書き込みできません); `draft` keeps the rejected path in the box.
    toastError(err.message)
  } finally {
    saving = false
    renderUploadRow()
  }
}

function saveUploadDir() {
  const input = $('#settings-upload-dir')
  if (!input) return
  void applyUploadDir(input.value.trim())
}

// Settings sits at the top of the modal stack (see #settings-backdrop's
// z-index in index.html), so other modules' Escape handlers need to check
// this and bail rather than close underneath it — same pattern promptDialog
// uses for the snippet/workspace managers.
export function isSettingsDialogOpen() {
  return open
}

function closeDialog() {
  open = false
  renderDialog()
}

async function copyRow(index) {
  const row = rows()[index]
  if (!row) return
  try {
    await navigator.clipboard.writeText(row.value)
    toast(`${escapeHtml(row.label)}をコピーしました`)
  } catch {
    toastError('クリップボードにコピーできませんでした')
  }
}

function handleDialogClick(ev) {
  const btn = ev.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  if (action === 'close-settings') {
    closeDialog()
  } else if (action === 'check-herdr') {
    void loadHerdr(true)
  } else if (action === 'copy-setting') {
    void copyRow(Number(btn.dataset.index))
  } else if (action === 'save-upload-dir') {
    saveUploadDir()
  }
}

export function initSettingsDialog() {
  $('#herdr-compatibility-settings')?.addEventListener('click', openSettingsDialog)
  window.addEventListener('focus', () => { if (open) void loadHerdr() })
  document.addEventListener('visibilitychange', () => {
    if (open && !document.hidden) void loadHerdr()
  })
  setInterval(() => { if (open && !document.hidden) void loadHerdr() }, 60_000)
  $('#settings-backdrop').addEventListener('click', (ev) => {
    if (ev.target.id === 'settings-backdrop') closeDialog()
  })
  $('#settings-dialog').addEventListener('click', handleDialogClick)
  // Mirrors every keystroke into `draft` so a re-render triggered from
  // elsewhere (a settings load resolving, the menu picking a folder) can
  // never silently discard a half-typed path.
  $('#settings-dialog').addEventListener('input', (ev) => {
    if (ev.target.id === 'settings-upload-dir') draft = ev.target.value
  })
  $('#settings-dialog').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.id === 'settings-upload-dir') saveUploadDir()
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open) closeDialog()
  })
  // capabilities lands asynchronously (see state.js) — if the dialog is
  // opened before GET /api/capabilities resolves, this keeps the MCP row
  // from staying stuck on its "not present yet" read once it does. Only the
  // read-only rows are rebuilt; see renderUploadRow for why the edit row is
  // deliberately left alone here.
  subscribe(() => {
    const host = open ? $('#settings-info-rows') : null
    if (host) host.innerHTML = rows().map(rowHtml).join('')
  })
}
