// Pure state logic for the sidebar pomodoro timer. A single, one-shot focus
// timer — no iterations, so no breaks and no session counter.
//
// Every transition takes `now` (epoch ms) and returns a new timer object, so
// this is testable without a clock or a DOM. A running timer is stored as its
// absolute end time rather than a countdown, so a reload (or a throttled
// background tab) never drifts: the remaining time is always `endsAt - now`.

export const POMODORO_STORAGE_KEY = 'dc.pomodoro'
export const DEFAULT_MINUTES = 25
export const MAX_MINUTES = 180
export const PROGRESS_SEGMENTS = 10
export const POMODORO_VOLUME_STORAGE_KEY = 'dc.pomodoro.volume'
export const DEFAULT_VOLUME = 60
// Gain at volume 100. Kept below 1 so the stacked chime notes never clip.
const MAX_GAIN = 0.5

const MINUTE_MS = 60_000
const STATUSES = new Set(['idle', 'running', 'paused', 'finished'])

export function idleTimer() {
  return { status: 'idle', durationMs: 0, remainingMs: 0, endsAt: null, todoId: null, todoTitle: null }
}

/** Whole minutes in 1..MAX_MINUTES, or null for anything else. */
export function normalizeMinutes(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > MAX_MINUTES) return null
  return n
}

export function startTimer({ minutes, todoId = null, todoTitle = null }, now) {
  const valid = normalizeMinutes(minutes)
  if (valid === null) throw new Error(`時間は1〜${MAX_MINUTES}分で指定してください`)
  const durationMs = valid * MINUTE_MS
  return { status: 'running', durationMs, remainingMs: durationMs, endsAt: now + durationMs, todoId, todoTitle }
}

export function remainingMs(timer, now) {
  if (timer.status === 'running') return Math.max(0, timer.endsAt - now)
  return timer.remainingMs
}

export function pauseTimer(timer, now) {
  if (timer.status !== 'running') return timer
  return { ...timer, status: 'paused', remainingMs: remainingMs(timer, now), endsAt: null }
}

export function resumeTimer(timer, now) {
  if (timer.status !== 'paused') return timer
  return { ...timer, status: 'running', endsAt: now + timer.remainingMs }
}

/** Back to the full duration, paused — the user decides when to go again. */
export function resetTimer(timer) {
  if (!isActive(timer) && timer.status !== 'finished') return timer
  return { ...timer, status: 'paused', remainingMs: timer.durationMs, endsAt: null }
}

export function finishTimer(timer) {
  return { ...timer, status: 'finished', remainingMs: 0, endsAt: null }
}

export function isActive(timer) {
  return timer.status === 'running' || timer.status === 'paused'
}

export function isExpired(timer, now) {
  return timer.status === 'running' && now >= timer.endsAt
}

/** "MM:SS", seconds rounded up so the display only reads 00:00 at the end. */
export function formatRemaining(ms) {
  const totalSec = Math.ceil(Math.max(0, ms) / 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(totalSec / 60))}:${pad(totalSec % 60)}`
}

/** How many of the PROGRESS_SEGMENTS blocks the elapsed time fills. */
export function filledSegments(timer, now) {
  if (timer.durationMs <= 0) return 0
  const elapsed = timer.durationMs - remainingMs(timer, now)
  return Math.min(PROGRESS_SEGMENTS, Math.floor((elapsed / timer.durationMs) * PROGRESS_SEGMENTS))
}

function isValidStored(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    STATUSES.has(value.status) &&
    Number.isFinite(value.durationMs) &&
    Number.isFinite(value.remainingMs) &&
    (value.status !== 'running' || Number.isFinite(value.endsAt))
  )
}

/** Storage can be unavailable or hold anything — both read as idle. */
export function loadTimer(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(POMODORO_STORAGE_KEY) ?? 'null')
    if (!isValidStored(parsed)) return idleTimer()
    return { ...idleTimer(), ...parsed }
  } catch {
    return idleTimer()
  }
}

export function saveTimer(storage, timer) {
  try {
    storage.setItem(POMODORO_STORAGE_KEY, JSON.stringify(timer))
  } catch {
    // Persistence is a convenience; the in-memory timer keeps working.
  }
}

/** Volume as an integer percent clamped to 0..100, or null when not a number. */
export function normalizeVolume(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(100, Math.max(0, Math.round(n)))
}

/**
 * Percent → Web Audio gain. Squared because loudness is perceived roughly
 * logarithmically: a linear map makes the whole top half of the slider sound
 * the same.
 */
export function volumeToGain(volume) {
  const ratio = (normalizeVolume(volume) ?? 0) / 100
  return ratio * ratio * MAX_GAIN
}

export function loadVolume(storage) {
  try {
    return normalizeVolume(storage.getItem(POMODORO_VOLUME_STORAGE_KEY)) ?? DEFAULT_VOLUME
  } catch {
    return DEFAULT_VOLUME
  }
}

export function saveVolume(storage, volume) {
  try {
    storage.setItem(POMODORO_VOLUME_STORAGE_KEY, String(volume))
  } catch {
    // Same as saveTimer: the in-memory volume still applies this session.
  }
}
