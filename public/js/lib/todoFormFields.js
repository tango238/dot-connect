// TODO の入力欄(新規フォームと詳細ダイアログの編集フォームで共通)。
// 項目は 3 つのまとまりに分けて出す:
//   内容       — タイトル・説明(新規フォームだけマイルストーン)
//   優先度・日程 — 緊急度・重要度・期限 / 予定(日付・開始・終了)
//   herdr 投入 — 作業ディレクトリ・モデル
// 詳細ダイアログの閲覧側(todoDetail.js の detailRows)も同じ見出しで並べる
// ので、「編集」を押しても項目の場所が変わらない。
//
// DOM も state も触らない。id は `${prefix}-title` のように前置詞付きで、
// 新規フォームは new-todo-*、編集フォームは detail-edit-* のまま変えない
// (値の読み取りや下書き復元がその id に依存している)。

import { escapeHtml } from '../utils.js'

/** id の末尾 → 値のキー。EDIT_FIELDS(todoDetailDialog.js)などがこれを使う。 */
export const TODO_FORM_FIELDS = {
  title: 'title',
  desc: 'description',
  ms: 'milestoneId',
  urgency: 'urgency',
  importance: 'importance',
  due: 'dueDate',
  'sched-date': 'schedDate',
  'sched-start': 'schedStart',
  'sched-end': 'schedEnd',
  ws: 'workspacePath',
  model: 'model',
}

/** `${prefix}-<suffix>` → 値のキー の対応表を作る。 */
export function todoFormFieldIds(prefix) {
  const ids = {}
  for (const [suffix, key] of Object.entries(TODO_FORM_FIELDS)) ids[`${prefix}-${suffix}`] = key
  return ids
}

export const SCHEDULE_HINT =
  'スケジュール画面の1日タイムラインに置く時間帯(期限とは別)。終了が空なら開始の1時間後、全部空なら予定なし。'
export const WORKSPACE_HINT = 'herdr 投入時に必須。ここで設定しておくと投入ダイアログに引き継がれます。'

function section(title, body) {
  return `<div class="form-section">
    <div class="form-section-title">${title}</div>
    ${body}
  </div>`
}

/**
 * 入力欄の HTML(セクション 3 つ)。保存/キャンセルのボタン行は含まない。
 * @param {object} p
 * @param {string} p.prefix  'new-todo' | 'detail-edit'
 * @param {object} p.values  title, description, milestoneId, urgency, importance,
 *   dueDate, schedDate, schedStart, schedEnd, workspacePath, model
 * @param {object} p.options  { priority(selected), model(selected), milestone?(selected) }
 *   — <option> 列を返す。milestone が無ければマイルストーン欄は出さない。
 * @param {object} [p.placeholders]  title / description の placeholder
 */
export function todoFormFieldsHtml({ prefix, values, options, placeholders = {} }) {
  const id = (suffix) => `${prefix}-${suffix}`
  const v = (key) => escapeHtml(values[key] ?? '')
  const attr = (text) => (text ? ` placeholder="${escapeHtml(text)}"` : '')
  const milestoneField = options.milestone
    ? `<div class="form-field">
      <label for="${id('ms')}">マイルストーン</label>
      <select id="${id('ms')}">${options.milestone(values.milestoneId ?? null)}</select>
    </div>`
    : ''
  const content = section(
    '内容',
    `<div class="form-field grow">
      <label for="${id('title')}">タイトル</label>
      <input id="${id('title')}" type="text" required value="${v('title')}"${attr(placeholders.title)}>
    </div>
    <div class="form-field grow">
      <label for="${id('desc')}">説明(任意)</label>
      <textarea id="${id('desc')}" rows="${options.milestone ? 10 : 6}"${attr(placeholders.description)}>${v('description')}</textarea>
    </div>
    ${milestoneField}`
  )
  const priorityAndDates = section(
    '優先度・日程',
    `<div class="form-row">
      <div class="form-field">
        <label for="${id('urgency')}">緊急度</label>
        <select id="${id('urgency')}">${options.priority(values.urgency)}</select>
      </div>
      <div class="form-field">
        <label for="${id('importance')}">重要度</label>
        <select id="${id('importance')}">${options.priority(values.importance)}</select>
      </div>
      <div class="form-field">
        <label for="${id('due')}">期限(任意)</label>
        <input id="${id('due')}" type="date" value="${v('dueDate')}">
      </div>
    </div>
    <div class="form-field">
      <label for="${id('sched-date')}">予定(任意)</label>
      <div class="schedule-fields">
        <input id="${id('sched-date')}" type="date" aria-label="予定の日付" value="${v('schedDate')}">
        <input id="${id('sched-start')}" type="time" step="300" aria-label="開始時刻" value="${v('schedStart')}">
        <span>–</span>
        <input id="${id('sched-end')}" type="time" step="300" aria-label="終了時刻" value="${v('schedEnd')}">
      </div>
      <p class="field-hint">${SCHEDULE_HINT}</p>
    </div>`
  )
  const dispatch = section(
    'herdr 投入',
    `<div class="form-row">
      <div class="form-field grow">
        <label for="${id('ws')}">作業ディレクトリ(任意)</label>
        <input id="${id('ws')}" type="text" list="workspace-datalist" value="${v('workspacePath')}" placeholder="例: /Users/you/projects/my-app (登録済みから選択、または自由入力)">
      </div>
      <div class="form-field">
        <label for="${id('model')}">モデル(任意)</label>
        <select id="${id('model')}">${options.model(values.model ?? '')}</select>
      </div>
    </div>
    <p class="field-hint">${WORKSPACE_HINT}</p>`
  )
  return `${content}${priorityAndDates}${dispatch}`
}
