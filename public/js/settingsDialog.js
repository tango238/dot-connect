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
import { getState, setState, subscribe } from './state.js'
import { $, escapeHtml, toast, toastError, toastWarning, twoStepConfirm } from './utils.js'

let open = false
// Last known GET /api/settings response, or null before the first load.
let settings = null
// What's in the text box. Kept apart from `settings` so a rejected save can
// leave the typed path in place instead of making the user retype it.
let draft = null
let saving = false
// Same split for the idle-recap minutes box: what's typed vs. what's saved.
let idleDraft = null
let savingIdle = false
// And for the WIP limit (checkbox + slot count, saved together).
let wipEnabledDraft = null
let wipLimitDraft = null
let savingWip = false
// Google カレンダーの一覧(GET /api/calendar/sources)。null は未取得。
// 追加フォームの入力は DOM が正だが、再描画で消えないよう下書きも持つ。
let calendars = null
let calendarsError = ''
let calendarBusy = false
let newCalendarDraft = { name: '', url: '' }
let openingNotes = false
let installingSkill = false
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

function idleMinutesValue() {
  return idleDraft ?? (settings?.idleRecapMinutes != null ? String(settings.idleRecapMinutes) : '')
}

// herdr 上の Claude Code セッションが GET /api/settings で読む値。dot-connect
// 自身はこの値で何もしない(セッション側のループが判断に使う)。
function renderIdleRow() {
  const host = $('#settings-idle-recap-row')
  if (!host) return
  const loading = settings === null
  host.innerHTML = `
    <div class="settings-row">
      <div class="settings-label">アイドル監視(分)</div>
      <div class="settings-value settings-edit">
        <input type="number" id="settings-idle-recap" class="settings-number" value="${escapeHtml(idleMinutesValue())}"
          min="1" max="1440" step="1" inputmode="numeric"
          placeholder="${loading ? '…' : '180'}" aria-label="アイドル監視(分)"
          ${loading || savingIdle ? 'disabled' : ''}>
      </div>
      <button type="button" class="btn" data-action="save-idle-recap" ${loading || savingIdle ? 'disabled' : ''}>保存</button>
    </div>
    <p class="field-hint">herdr のセッションが、ユーザーからの応答がこの時間途絶えたときに recap を作業ログへ自動記録します。1〜1440分。セッション側は次回のチェック時にこの値を読み直します。</p>`
}

function wipEnabledValue() {
  return wipEnabledDraft ?? settings?.wipLimitEnabled ?? false
}

function wipLimitValue() {
  return wipLimitDraft ?? (settings?.wipLimit != null ? String(settings.wipLimit) : '')
}

function renderWipRow() {
  const host = $('#settings-wip-row')
  if (!host) return
  const loading = settings === null
  const disabled = loading || savingWip ? 'disabled' : ''
  host.innerHTML = `
    <div class="settings-row">
      <div class="settings-label">WIP制限</div>
      <div class="settings-value settings-edit">
        <label class="settings-check"><input type="checkbox" id="settings-wip-enabled" ${wipEnabledValue() ? 'checked' : ''} ${disabled}> 有効</label>
        <input type="number" id="settings-wip-limit" class="settings-number" value="${escapeHtml(wipLimitValue())}"
          min="1" max="30" step="1" inputmode="numeric"
          placeholder="${loading ? '…' : '10'}" aria-label="WIP可能数" ${disabled}>
        <span class="settings-flag">件</span>
      </div>
      <button type="button" class="btn" data-action="save-wip" ${disabled}>保存</button>
    </div>
    <p class="field-hint">有効にすると、herdr のセッションが残っている未完了TODOが WIP可能数(1〜30件)に達した時点で、それ以上 herdr へ投入できなくなります。投入するには実行中のTODOを完了にするか削除してください。左のメニューに使用状況が表示されます。</p>`
}

function formatCalendarStatus(status) {
  if (!status) return ''
  if (status.error) return `⚠ ${status.error}`
  if (!status.fetchedAt) return '取得中…'
  const at = new Date(status.fetchedAt)
  const pad = (n) => String(n).padStart(2, '0')
  return `${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())} 取得 · ${status.eventCount}件`
}

function calendarRowHtml(cal) {
  const disabled = calendarBusy ? 'disabled' : ''
  const statusText = formatCalendarStatus(cal.status)
  return `<div class="settings-calendar" data-calendar-id="${cal.id}">
    <div class="settings-row">
      <div class="settings-label">
        <input type="color" class="settings-cal-color" data-field="color" value="${escapeHtml(cal.color)}" aria-label="色" title="色(変えるとすぐ保存)" ${disabled}>
      </div>
      <div class="settings-value settings-edit settings-cal-fields">
        <input type="text" data-field="name" value="${escapeHtml(cal.name)}" placeholder="名前" aria-label="名前" maxlength="50" ${disabled}>
        <input type="url" data-field="url" value="${escapeHtml(cal.url)}" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" aria-label="iCal 形式の非公開 URL" spellcheck="false" autocomplete="off" ${disabled}>
      </div>
      <div class="settings-cal-actions">
        <button type="button" class="btn" data-action="save-calendar" data-id="${cal.id}" ${disabled}>保存</button>
        <button type="button" class="btn btn-ghost" data-action="refresh-one-calendar" data-id="${cal.id}" title="いま取り直す" ${disabled}>更新</button>
        <button type="button" class="btn btn-ghost" data-action="delete-calendar" data-id="${cal.id}" title="このカレンダーを外す" ${disabled}>🗑</button>
      </div>
    </div>
    ${statusText ? `<p class="field-hint settings-calendar-status ${cal.status?.error ? 'is-error' : ''}">${escapeHtml(statusText)}</p>` : ''}
  </div>`
}

// Google カレンダー(iCal 非公開 URL)の一覧。カレンダーごとに名前・URL・色を
// 持ち、スケジュール画面ではその色で予定が出る。追加・URL 変更のときは
// サーバーがその場で取りに行き、結果(件数かエラー)が各行の下に出る。
function renderCalendarRow() {
  const host = $('#settings-calendar-row')
  if (!host) return
  const loading = calendars === null
  const disabled = loading || calendarBusy ? 'disabled' : ''
  const rows = loading
    ? `<p class="field-hint">${calendarsError ? escapeHtml(calendarsError) : '読み込み中…'}</p>`
    : calendars.length
      ? calendars.map(calendarRowHtml).join('')
      : `<p class="field-hint">まだ登録されていません。</p>`
  host.innerHTML = `
    <div class="settings-row">
      <div class="settings-label">Google カレンダー</div>
      <div class="settings-value"></div>
    </div>
    ${rows}
    <div class="settings-row settings-calendar-add">
      <div class="settings-label">追加</div>
      <div class="settings-value settings-edit settings-cal-fields">
        <input type="text" id="settings-calendar-new-name" value="${escapeHtml(newCalendarDraft.name)}" placeholder="名前(例: 仕事)" aria-label="名前" maxlength="50" ${disabled}>
        <input type="url" id="settings-calendar-new-url" value="${escapeHtml(newCalendarDraft.url)}" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" aria-label="iCal 形式の非公開 URL" spellcheck="false" autocomplete="off" ${disabled}>
      </div>
      <button type="button" class="btn btn-accent" data-action="add-calendar" ${disabled}>${calendarBusy ? '取得中…' : '追加'}</button>
    </div>
    <p class="field-hint">Google カレンダーの「設定」→ 対象のカレンダー →「iCal 形式の非公開 URL」を貼り付けると、スケジュール画面のタイムラインにその色で予定が重なります(読み取り専用、15分ごとに取得。Google 側の更新が反映されるまで数分〜数時間かかることがあります)。複数登録でき、色は左の色をクリックして変えられます。この URL を知っている人は誰でも予定を読めるので、共有しないでください。</p>`
}

async function loadCalendars() {
  try {
    calendars = await api.listCalendars()
    calendarsError = ''
  } catch (err) {
    calendars = null
    calendarsError = `カレンダー一覧を取得できませんでした: ${err.message}`
  }
  if (open) renderCalendarRow()
}

// 一覧を書き換える操作の共通部分: busy にして描き、終わったら一覧を取り直す。
async function withCalendarBusy(run) {
  if (calendarBusy) return
  calendarBusy = true
  renderCalendarRow()
  try {
    await run()
  } catch (err) {
    toastError(err.message)
  } finally {
    calendarBusy = false
    await loadCalendars()
  }
}

function reportCalendarStatus(status, verb) {
  if (status.error) toastWarning(`${status.name} を${verb}しましたが取得に失敗しました: ${status.error}`)
  else toast(`${status.name} を${verb}し、予定を取得しました(${status.eventCount}件)`)
}

function addCalendar() {
  const name = $('#settings-calendar-new-name')?.value.trim() ?? ''
  const url = $('#settings-calendar-new-url')?.value.trim() ?? ''
  if (!name || !url) {
    toastError('カレンダーの名前と iCal の URL を入力してください')
    return
  }
  newCalendarDraft = { name, url }
  void withCalendarBusy(async () => {
    const status = await api.createCalendar({ name, url })
    newCalendarDraft = { name: '', url: '' }
    reportCalendarStatus(status, '追加')
  })
}

function calendarFields(id) {
  const row = $(`.settings-calendar[data-calendar-id="${id}"]`)
  if (!row) return null
  return {
    name: $('[data-field="name"]', row)?.value.trim() ?? '',
    url: $('[data-field="url"]', row)?.value.trim() ?? '',
    color: $('[data-field="color"]', row)?.value ?? '',
  }
}

function saveCalendar(id) {
  const fields = calendarFields(id)
  const current = calendars?.find((c) => c.id === id)
  if (!fields || !current) return
  if (!fields.name || !fields.url) {
    toastError('カレンダーの名前と iCal の URL を入力してください')
    return
  }
  const patch = {}
  if (fields.name !== current.name) patch.name = fields.name
  if (fields.url !== current.url) patch.url = fields.url
  if (fields.color && fields.color !== current.color) patch.color = fields.color
  if (Object.keys(patch).length === 0) {
    toast('変更はありません')
    return
  }
  void withCalendarBusy(async () => {
    const status = await api.updateCalendar(id, patch)
    if (patch.url !== undefined) reportCalendarStatus(status, '更新')
    else toast(`${status.name} を更新しました`)
  })
}

// 色は選んだ瞬間に保存する(名前・URL と違って「保存」を待つ理由がない)。
function recolorCalendar(id, color) {
  const current = calendars?.find((c) => c.id === id)
  if (!current || current.color === color) return
  void withCalendarBusy(async () => {
    await api.updateCalendar(id, { color })
  })
}

function deleteCalendar(id) {
  const current = calendars?.find((c) => c.id === id)
  if (!current) return
  void withCalendarBusy(async () => {
    await api.deleteCalendar(id)
    toast(`${current.name} を外しました`)
  })
}

function refreshOneCalendar(id) {
  void withCalendarBusy(async () => {
    const status = await api.refreshOneCalendar(id)
    if (status.error) toastWarning(`${status.name} の取得に失敗しました: ${status.error}`)
    else toast(`${status.name} の予定を取り直しました(${status.eventCount}件)`)
  })
}

const SKILL_STATE_TEXT = {
  not_installed: '未インストール',
  installed: 'インストール済み(最新)',
  outdated: '同梱版と内容が異なります',
}

// The dot-connect skill (TODO decomposition for Claude Code) and the notes
// it learns from. Both buttons act immediately; nothing here is a draft.
function renderSkillRow() {
  const host = $('#settings-skill-row')
  if (!host) return
  const loading = settings === null
  const skill = settings?.skill
  const installLabel = installingSkill ? 'インストール中…' : skill?.state === 'not_installed' ? 'インストール' : '再インストール'
  host.innerHTML = `
    <div class="settings-row">
      <div class="settings-label">dot-connect スキル</div>
      <div class="settings-value" title="${escapeHtml(skill?.path ?? '')}">${loading ? '…' : escapeHtml(SKILL_STATE_TEXT[skill.state] ?? skill.state)}</div>
      <button type="button" class="btn" data-action="install-skill" ${loading || installingSkill ? 'disabled' : ''}>${installLabel}</button>
    </div>
    <p class="field-hint">Claude Code 用のスキルを <code>${escapeHtml(skill?.path ?? '~/.claude/skills/dot-connect/SKILL.md')}</code> に書き出します。依頼文を TODO に分解し、モデルと作業ディレクトリを提案して、承認後に dot-connect へ登録します。${skill?.state === 'outdated' ? '<br>再インストールすると、手で編集した内容は同梱版で上書きされます。' : ''}</p>
    <div class="settings-row">
      <div class="settings-label">スキルの記録</div>
      <div class="settings-value">${escapeHtml(settings?.notesDir ?? '…')}</div>
      <button type="button" class="btn" data-action="open-notes-dir" ${loading || openingNotes ? 'disabled' : ''}>Finderで開く</button>
    </div>
    <p class="field-hint">スキルがモデル・作業ディレクトリを決めるときに読む記録(<code>workspaces.md</code> / <code>models.md</code> / <code>history.md</code>)です。テキストを直接編集すると次回の提案に反映されます。</p>`
}

async function installSkillNow() {
  if (installingSkill) return
  installingSkill = true
  renderSkillRow()
  try {
    const skill = await api.installSkill()
    settings = { ...settings, skill }
    toast('dot-connect スキルをインストールしました。Claude Code で使えます')
  } catch (err) {
    toastError(err.message)
  } finally {
    installingSkill = false
    renderSkillRow()
  }
}

async function openNotesDir() {
  if (openingNotes) return
  openingNotes = true
  renderSkillRow()
  try {
    await api.openNotesDir()
  } catch (err) {
    toastError(err.message)
  } finally {
    openingNotes = false
    renderSkillRow()
  }
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
    <div id="settings-idle-recap-row" class="settings-section"></div>
    <div id="settings-wip-row" class="settings-section"></div>
    <div id="settings-calendar-row" class="settings-section"></div>
    <div id="settings-skill-row" class="settings-section"></div>
    <section id="settings-herdr" class="settings-section" aria-live="polite"></section>
    <div class="modal-footer">
      <button type="button" class="btn btn-ghost" data-action="close-settings">閉じる</button>
    </div>`
  renderUploadRow()
  renderIdleRow()
  renderWipRow()
  renderCalendarRow()
  renderSkillRow()
  renderHerdr()
}

async function loadSettings() {
  try {
    settings = await api.getSettings()
    // Only adopt the server's value if the user hasn't started typing while
    // the request was in flight.
    if (draft === null) draft = settings.uploadDir
    if (idleDraft === null) idleDraft = String(settings.idleRecapMinutes)
    setState({ settings })
  } catch (err) {
    toastError(err.message)
  }
  renderUploadRow()
  renderIdleRow()
  renderWipRow()
  renderCalendarRow()
  renderSkillRow()
}

export function openSettingsDialog() {
  if (open) return
  open = true
  // A draft left over from a rejected save belongs to the previous visit;
  // reopening should show what the server actually has.
  draft = null
  idleDraft = null
  wipEnabledDraft = null
  wipLimitDraft = null
  calendars = null
  newCalendarDraft = { name: '', url: '' }
  renderDialog()
  void loadSettings()
  void loadCalendars()
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

async function saveIdleRecap() {
  const input = $('#settings-idle-recap')
  if (!input || savingIdle) return
  const minutes = Number(input.value.trim())
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    toastError('アイドル監視は1〜1440の整数(分)で指定してください')
    return
  }
  savingIdle = true
  idleDraft = String(minutes)
  renderIdleRow()
  try {
    settings = await api.updateSettings({ idleRecapMinutes: minutes })
    idleDraft = String(settings.idleRecapMinutes)
    toast(`アイドル監視を${minutes}分に変更しました`)
  } catch (err) {
    toastError(err.message)
  } finally {
    savingIdle = false
    renderIdleRow()
  }
}

async function saveWip() {
  const input = $('#settings-wip-limit')
  const checkbox = $('#settings-wip-enabled')
  if (!input || !checkbox || savingWip) return
  const limit = Number(input.value.trim())
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
    toastError('WIP可能数は1〜30の整数で指定してください')
    return
  }
  const enabled = checkbox.checked
  savingWip = true
  wipEnabledDraft = enabled
  wipLimitDraft = String(limit)
  renderWipRow()
  try {
    settings = await api.updateSettings({ wipLimitEnabled: enabled, wipLimit: limit })
    wipEnabledDraft = null
    wipLimitDraft = null
    setState({ settings })
    toast(enabled ? `WIP制限を有効にしました(${limit}件)` : 'WIP制限を無効にしました')
  } catch (err) {
    toastError(err.message)
  } finally {
    savingWip = false
    renderWipRow()
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
  } else if (action === 'save-idle-recap') {
    void saveIdleRecap()
  } else if (action === 'save-wip') {
    void saveWip()
  } else if (action === 'add-calendar') {
    addCalendar()
  } else if (action === 'save-calendar') {
    saveCalendar(Number(btn.dataset.id))
  } else if (action === 'delete-calendar') {
    twoStepConfirm(btn, () => deleteCalendar(Number(btn.dataset.id)), { armedText: '外す？', restoreText: '🗑' })
  } else if (action === 'refresh-one-calendar') {
    refreshOneCalendar(Number(btn.dataset.id))
  } else if (action === 'install-skill') {
    void installSkillNow()
  } else if (action === 'open-notes-dir') {
    void openNotesDir()
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
    if (ev.target.id === 'settings-idle-recap') idleDraft = ev.target.value
    if (ev.target.id === 'settings-wip-limit') wipLimitDraft = ev.target.value
    if (ev.target.id === 'settings-wip-enabled') wipEnabledDraft = ev.target.checked
    if (ev.target.id === 'settings-calendar-new-name') newCalendarDraft = { ...newCalendarDraft, name: ev.target.value }
    if (ev.target.id === 'settings-calendar-new-url') newCalendarDraft = { ...newCalendarDraft, url: ev.target.value }
  })
  // 色は <input type="color"> の change(ピッカーを閉じたとき)で保存する。
  $('#settings-dialog').addEventListener('change', (ev) => {
    if (ev.target.classList?.contains('settings-cal-color')) {
      recolorCalendar(Number(ev.target.closest('.settings-calendar')?.dataset.calendarId), ev.target.value)
    }
  })
  $('#settings-dialog').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.id === 'settings-upload-dir') saveUploadDir()
    if (ev.key === 'Enter' && ev.target.id === 'settings-idle-recap') void saveIdleRecap()
    if (ev.key === 'Enter' && ev.target.id === 'settings-wip-limit') void saveWip()
    if (ev.key === 'Enter' && (ev.target.id === 'settings-calendar-new-name' || ev.target.id === 'settings-calendar-new-url')) addCalendar()
    if (ev.key === 'Enter' && ev.target.closest?.('.settings-calendar')) saveCalendar(Number(ev.target.closest('.settings-calendar').dataset.calendarId))
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
