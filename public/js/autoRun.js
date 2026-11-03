// 自動投入(auto mode): 「今週終わらせるタスク」の並びから、空き枠がある間
// 上から順に herdr への投入を提案する。提案は確認ダイアログで、ユーザーが
// 「投入する」を押したときだけ投入する —— 勝手に始めると herdr 側で権限の
// 確認に引っかかることがあるため、通知して許可をもらうのが約束。
//
// 動く条件は lib/weekQueue.js の autoRunPlan が決める(未完了・セッション無し・
// Grilled 済み・作業ディレクトリあり、空き枠 = WIP可能数 − バッファ)。
// バッファぶんの枠は手動投入(目標ページの一覧の「投入」)のために空けて
// おく —— 自動はそこまで使わない。
//
// 今週の並びは state.weekQueue(weekQueue.js が今日の属する週を読んで置く)
// を見る。どのページを見ていても動くよう、state の変化と 30 秒おきの tick
// で読み直す。

import { api } from './api.js'
import { refreshTodos } from './data.js'
import { shouldWarnAboutDelivery } from './lib/dispatchResult.js'
import { autoRunPlan } from './lib/weekQueue.js'
import { getState, setState, subscribe } from './state.js'
import { $, escapeHtml, toast, toastError, toastWarning } from './utils.js'
import { currentWeekStart, QUEUE_CHANGED_EVENT, refreshCurrentWeekQueue } from './weekQueue.js'

const QUEUE_POLL_MS = 30_000

// この起動中に「スキップ」した id。再起動で忘れる(また提案される)。
const skipped = new Set()
// 開いている提案(todo の id)。一度に 1 件しか出さない。
let proposal = null
let dispatching = false

function queueTodosLive() {
  const { weekQueue, todos } = getState()
  if (!weekQueue || weekQueue.weekStart !== currentWeekStart()) return []
  const byId = new Map(todos.map((t) => [t.id, t]))
  // 行の「herdr」印(dispatch)は週の並び側の情報なので、state.todos の最新に
  // 差し替えても持ち越す。
  return weekQueue.todos.map((t) => ({ ...(byId.get(t.id) ?? t), queueDispatch: t.dispatch !== false }))
}

function isEnabled() {
  return getState().settings?.autoRunEnabled === true
}

function otherModalOpen() {
  return !!document.querySelector('.modal-backdrop:not([hidden]):not(#auto-run-backdrop)')
}

function renderDialog() {
  const backdrop = $('#auto-run-backdrop')
  if (proposal === null) {
    backdrop.hidden = true
    return
  }
  const todo = queueTodosLive().find((t) => t.id === proposal)
  if (!todo) {
    proposal = null
    backdrop.hidden = true
    return
  }
  const plan = autoRunPlan(queueTodosLive(), getState().todos, getState().settings, skipped)
  backdrop.hidden = false
  $('#auto-run-dialog').innerHTML = `
    <div class="modal-head">
      <h2>自動投入: 次の TODO を herdr に投入しますか？</h2>
      <button type="button" class="btn btn-ghost" data-action="auto-skip" aria-label="閉じる(スキップ)">×</button>
    </div>
    <div class="modal-sub">「今週終わらせるタスク」の並びの先頭で、Grilled 済みの TODO です。投入すると herdr に新しいセッションが開き、Claude Code がこの TODO に取りかかります。</div>
    <div class="auto-run-todo">
      <div class="auto-run-title"><span class="todo-id">#${todo.id}</span> ${escapeHtml(todo.title)}</div>
      <div class="auto-run-meta">
        <span>作業ディレクトリ: <code>${escapeHtml(todo.workspacePath ?? '')}</code></span>
        <span>モデル: <code>${escapeHtml(todo.model ?? '既定')}</code></span>
        <span>空き枠 ${plan.capacity.free} / 同時 ${plan.capacity.slots}(実行中 ${plan.capacity.running})</span>
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn btn-accent" data-action="auto-approve" ${dispatching ? 'disabled' : ''}>${dispatching ? '投入中…' : '▶ 投入する'}</button>
      <button type="button" class="btn" data-action="auto-skip" ${dispatching ? 'disabled' : ''}>今回はスキップ</button>
      <button type="button" class="btn btn-ghost" data-action="auto-stop" ${dispatching ? 'disabled' : ''}>自動投入を止める</button>
    </div>`
}

function notifyProposal(todo) {
  toast(`自動投入の確認: #${todo.id} ${escapeHtml(todo.title)} を herdr に投入します。ダイアログで許可してください`)
  // 画面を見ていないときのために OS の通知も出す(許可済みのときだけ。
  // 許可を求めるのはユーザー操作の中でないと弾かれるので、ここでは求めない)。
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      new Notification('dot-connect: 自動投入の確認', { body: `#${todo.id} ${todo.title} を herdr に投入します。許可してください` })
    }
  } catch {
    // 通知が使えない環境(Tauri の WebView など)では黙って諦める。
  }
}

function maybePropose() {
  if (!isEnabled()) {
    if (proposal !== null && !dispatching) {
      proposal = null
      renderDialog()
    }
    return
  }
  const plan = autoRunPlan(queueTodosLive(), getState().todos, getState().settings, skipped)
  if (proposal !== null) {
    // 提案中の TODO が(別の手で投入されるなどして)候補でなくなったら閉じる。
    if (!dispatching && plan.candidate?.id !== proposal) {
      proposal = null
      renderDialog()
    } else {
      renderDialog()
    }
    return
  }
  if (!plan.canPropose || otherModalOpen()) return
  proposal = plan.candidate.id
  renderDialog()
  notifyProposal(plan.candidate)
}

async function approve() {
  if (proposal === null || dispatching) return
  const id = proposal
  const todo = queueTodosLive().find((t) => t.id === id)
  dispatching = true
  renderDialog()
  try {
    const result = await api.dispatchTodo(id, {})
    if (shouldWarnAboutDelivery(result)) {
      toastWarning(`「${todo?.title ?? `#${id}`}」を投入しましたが、プロンプトの到達を確認できませんでした。セッションを開いて確認してください。`)
    } else {
      toast(`「${escapeHtml(todo?.title ?? `#${id}`)}」を herdr に投入しました`)
    }
    proposal = null
    await refreshTodos()
  } catch (err) {
    // 失敗した TODO はこの起動中は飛ばす —— 同じ失敗を繰り返し提案しない。
    skipped.add(id)
    proposal = null
    toastError(`自動投入に失敗しました: ${err.message}(#${id} は以後スキップします)`)
  } finally {
    dispatching = false
    renderDialog()
    maybePropose()
  }
}

function skip() {
  if (proposal === null || dispatching) return
  skipped.add(proposal)
  proposal = null
  renderDialog()
  maybePropose()
}

async function stop() {
  if (dispatching) return
  proposal = null
  renderDialog()
  try {
    const settings = await api.updateSettings({ autoRunEnabled: false })
    setState({ settings })
    toast('自動投入を止めました')
  } catch (err) {
    toastError(err.message)
  }
}

export function initAutoRun() {
  $('#auto-run-dialog').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]')
    if (!btn) return
    if (btn.dataset.action === 'auto-approve') void approve()
    else if (btn.dataset.action === 'auto-skip') skip()
    else if (btn.dataset.action === 'auto-stop') void stop()
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && proposal !== null && !dispatching) skip()
  })
  document.addEventListener(QUEUE_CHANGED_EVENT, () => void refreshCurrentWeekQueue())
  subscribe(() => maybePropose())
  // 起動直後に今週の並びを読み(TODO 一覧の「目標に登録」の既登録判定にも使う)、
  // 以降は 30 秒おきに読み直す。
  void refreshCurrentWeekQueue()
  setInterval(() => void refreshCurrentWeekQueue(), QUEUE_POLL_MS)
}
