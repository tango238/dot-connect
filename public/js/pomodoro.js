// Sidebar pomodoro timer: one focus timer at a time, optionally tied to a
// TODO (started from the TODO detail dialog). No iterations, so no breaks.
//
// The timer object itself is pure data (lib/pomodoro.js) persisted to
// localStorage, so a reload keeps a running timer running. The full widget
// is re-rendered only on status changes; the 1s tick patches the digits and
// the progress blocks in place, so the minutes input is never rebuilt under
// the user mid-typing.

import { api } from './api.js'
import { refreshTodos } from './data.js'
import {
  DEFAULT_MINUTES,
  DEFAULT_VOLUME,
  MAX_MINUTES,
  PROGRESS_SEGMENTS,
  filledSegments,
  finishTimer,
  formatRemaining,
  idleTimer,
  isActive,
  isExpired,
  loadTimer,
  loadVolume,
  normalizeMinutes,
  normalizeVolume,
  pauseTimer,
  remainingMs,
  resetTimer,
  resumeTimer,
  saveTimer,
  saveVolume,
  startTimer,
} from './lib/pomodoro.js'
import { playChime, primeAudio, primeAudioOnFirstGesture } from './pomodoroSound.js'
import { getState } from './state.js'
import { $, escapeHtml, toast, toastError, toastWarning } from './utils.js'

const TICK_MS = 1000

let timer = idleTimer()
// The idle widget's minutes field, held here so a re-render keeps it.
let idleMinutesValue = String(DEFAULT_MINUTES)
let openTodo = () => {}
const listeners = new Set()
let volume = loadVolume(window.localStorage)
// What the mute button restores to; never 0, so unmuting is always audible.
let volumeBeforeMute = volume > 0 ? volume : DEFAULT_VOLUME

export function currentPomodoro() {
  return timer
}

/** Called on every status change (not every tick) — the detail dialog uses it. */
export function onPomodoroChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setTimer(next) {
  timer = next
  saveTimer(window.localStorage, timer)
  renderPomodoro()
  listeners.forEach((listener) => listener(timer))
}

/** Title from live state when the TODO still exists, else the one saved at start. */
function linkedTitle() {
  if (timer.todoId === null) return null
  const todo = getState().todos.find((t) => t.id === timer.todoId)
  return todo?.title ?? timer.todoTitle
}

function labelHtml() {
  const title = linkedTitle()
  if (title === null) return `<span class="pomo-label">フリー</span>`
  return `<button type="button" class="pomo-label pomo-label-link" data-pomo="open-todo" title="${escapeHtml(title)}">${escapeHtml(title)}</button>`
}

function segmentsHtml(filled) {
  const cells = Array.from(
    { length: PROGRESS_SEGMENTS },
    (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`
  ).join('')
  return `<div class="pomo-bar" aria-hidden="true">${cells}</div>`
}

function controlsHtml() {
  if (timer.status === 'finished') {
    return `<button type="button" class="pomo-btn" data-pomo="restart">↻ もう一度</button>
      <button type="button" class="pomo-btn" data-pomo="dismiss">✓ 閉じる</button>`
  }
  const toggle =
    timer.status === 'running'
      ? `<button type="button" class="pomo-btn" data-pomo="pause">❙❙ 停止</button>`
      : `<button type="button" class="pomo-btn" data-pomo="resume">▶ 再開</button>`
  return `${toggle}
    <button type="button" class="pomo-btn" data-pomo="reset">↺ リセット</button>
    <button type="button" class="pomo-btn" data-pomo="stop">■ 終了</button>`
}

function volumeHtml() {
  const muted = volume === 0
  return `<div class="pomo-volume">
      <button type="button" class="pomo-mute" data-pomo="toggle-mute" id="pomo-mute" aria-pressed="${muted}" title="${muted ? '音をオンにする' : 'ミュート'}">${muted ? '🔕' : '🔔'}</button>
      <input id="pomo-volume" type="range" min="0" max="100" step="5" value="${volume}" aria-label="終了音の音量">
      <span class="pomo-volume-value" id="pomo-volume-value">${volume}%</span>
    </div>`
}

function idleHtml() {
  const minutes = normalizeMinutes(idleMinutesValue) ?? DEFAULT_MINUTES
  return `<div class="pomo-head"><span class="pomo-label">ポモドーロ</span></div>
    <div class="pomo-time" id="pomo-time">${formatRemaining(minutes * 60_000)}</div>
    <div class="pomo-setup">
      <input id="pomo-minutes" type="number" min="1" max="${MAX_MINUTES}" step="1" value="${escapeHtml(idleMinutesValue)}" aria-label="タイマーの分数">
      <span class="pomo-unit">分</span>
      <button type="button" class="pomo-btn pomo-start" data-pomo="start">▶ 開始</button>
    </div>
    ${volumeHtml()}`
}

function activeHtml(now) {
  const minutes = Math.round(timer.durationMs / 60_000)
  const sub = timer.status === 'finished' ? '完了！' : `${minutes}分${timer.status === 'paused' ? ' · 一時停止中' : ''}`
  return `<div class="pomo-head">${labelHtml()}</div>
    <div class="pomo-time" id="pomo-time">${formatRemaining(remainingMs(timer, now))}</div>
    <div class="pomo-sub">${sub}</div>
    <div id="pomo-bar-wrap">${segmentsHtml(filledSegments(timer, now))}</div>
    <div class="pomo-controls">${controlsHtml()}</div>
    ${volumeHtml()}`
}

export function renderPomodoro() {
  const el = $('#pomodoro')
  if (!el) return
  el.dataset.status = timer.status
  el.innerHTML = timer.status === 'idle' ? idleHtml() : activeHtml(Date.now())
  el.title = timer.status === 'idle' ? 'ポモドーロ' : `ポモドーロ ${formatRemaining(remainingMs(timer, Date.now()))}`
}

function tick() {
  if (timer.status !== 'running') return
  const now = Date.now()
  if (isExpired(timer, now)) {
    void complete()
    return
  }
  const timeEl = $('#pomo-time')
  if (timeEl) timeEl.textContent = formatRemaining(remainingMs(timer, now))
  const barWrap = $('#pomo-bar-wrap')
  if (barWrap) barWrap.innerHTML = segmentsHtml(filledSegments(timer, now))
}

/** Finishing a TODO-linked timer leaves a line in that TODO's 作業ログ. */
async function logToTodo(finished) {
  if (finished.todoId === null) return
  const minutes = Math.round(finished.durationMs / 60_000)
  try {
    await api.addTodoComment(finished.todoId, `🍅 ポモドーロ ${minutes}分 完了`)
    await refreshTodos()
  } catch (err) {
    toastWarning(`作業ログに記録できませんでした: ${err.message}`)
  }
}

async function complete() {
  const finished = finishTimer(timer)
  setTimer(finished)
  playChime(volume)
  const title = linkedTitle()
  toast(title === null ? '🍅 ポモドーロ完了' : `🍅 ポモドーロ完了: ${escapeHtml(title)}`)
  await logToTodo(finished)
}

/**
 * Starts a new timer, replacing any current one. Throws on an invalid
 * duration so callers can show the message next to their own input.
 */
export function startPomodoro({ minutes, todoId = null, todoTitle = null }) {
  const next = startTimer({ minutes, todoId, todoTitle }, Date.now())
  primeAudio()
  setTimer(next)
}

function startFromSidebar() {
  try {
    startPomodoro({ minutes: idleMinutesValue })
  } catch (err) {
    toastError(err.message)
  }
}

/** Updates the volume row in place — re-rendering would drop the slider drag. */
function patchVolumeRow() {
  const muted = volume === 0
  const slider = $('#pomo-volume')
  if (slider && Number(slider.value) !== volume) slider.value = String(volume)
  const value = $('#pomo-volume-value')
  if (value) value.textContent = `${volume}%`
  const mute = $('#pomo-mute')
  if (mute) {
    mute.textContent = muted ? '🔕' : '🔔'
    mute.title = muted ? '音をオンにする' : 'ミュート'
    mute.setAttribute('aria-pressed', String(muted))
  }
}

function setVolume(next) {
  const normalized = normalizeVolume(next)
  if (normalized === null) return
  volume = normalized
  if (volume > 0) volumeBeforeMute = volume
  saveVolume(window.localStorage, volume)
  patchVolumeRow()
}

/** A short preview so the user hears the level they picked. */
function previewChime() {
  primeAudio()
  playChime(volume, { rounds: 1 })
}

function toggleMute() {
  setVolume(volume === 0 ? volumeBeforeMute : 0)
  previewChime()
}

const ACTIONS = {
  start: startFromSidebar,
  pause: () => setTimer(pauseTimer(timer, Date.now())),
  resume: () => {
    primeAudio()
    setTimer(resumeTimer(timer, Date.now()))
  },
  reset: () => setTimer(resetTimer(timer)),
  stop: () => setTimer(idleTimer()),
  dismiss: () => setTimer(idleTimer()),
  restart: () =>
    startPomodoro({
      minutes: Math.round(timer.durationMs / 60_000),
      todoId: timer.todoId,
      todoTitle: timer.todoTitle,
    }),
  'toggle-mute': toggleMute,
  'open-todo': () => {
    if (timer.todoId !== null) openTodo(timer.todoId)
  },
}

export function initPomodoro({ onOpenTodo }) {
  openTodo = onOpenTodo
  const el = $('#pomodoro')
  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-pomo]')
    if (btn) ACTIONS[btn.dataset.pomo]?.()
  })
  el.addEventListener('input', (ev) => {
    if (ev.target.id === 'pomo-volume') {
      setVolume(ev.target.value)
      return
    }
    if (ev.target.id !== 'pomo-minutes') return
    idleMinutesValue = ev.target.value
    const minutes = normalizeMinutes(idleMinutesValue)
    const timeEl = $('#pomo-time')
    if (timeEl && minutes !== null) timeEl.textContent = formatRemaining(minutes * 60_000)
  })
  // `change` fires on release, so dragging doesn't spray chimes.
  el.addEventListener('change', (ev) => {
    if (ev.target.id === 'pomo-volume') previewChime()
  })
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.id === 'pomo-minutes') startFromSidebar()
  })

  primeAudioOnFirstGesture()
  timer = loadTimer(window.localStorage)
  // A timer that ran out while the app was closed still counts as done.
  if (isExpired(timer, Date.now())) {
    void complete()
  } else {
    renderPomodoro()
  }
  setInterval(tick, TICK_MS)
}

/** Re-render on app state changes so a renamed linked TODO shows its new title. */
export function refreshPomodoroLabel() {
  if (isActive(timer) || timer.status === 'finished') renderPomodoro()
}
