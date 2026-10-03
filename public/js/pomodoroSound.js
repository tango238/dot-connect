// Finish chime for the pomodoro timer, synthesized with Web Audio so there is
// no sound file to ship.
//
// Browsers (and the Tauri WebView) keep an AudioContext suspended until a user
// gesture resumes it. The timer usually ends with no gesture in flight, so the
// context is primed ahead of time: on start/resume clicks and on the first
// pointer/key event after page load, so a timer restored from localStorage
// still rings.

import { volumeToGain } from './lib/pomodoro.js'

// C6 → E6 → G6, played twice: bright enough to notice, short enough not to nag.
const NOTES_HZ = [1047, 1319, 1568]
const NOTE_GAP_S = 0.18
const NOTE_LENGTH_S = 0.45
const ROUNDS = 2
const ROUND_GAP_S = 0.8

let audioContext = null

export function primeAudio() {
  try {
    const Ctor = window.AudioContext ?? window.webkitAudioContext
    if (!Ctor) return
    audioContext ??= new Ctor()
    if (audioContext.state === 'suspended') void audioContext.resume()
  } catch {
    audioContext = null
  }
}

/** Prime on the first interaction anywhere, for timers restored after a reload. */
export function primeAudioOnFirstGesture() {
  const prime = () => {
    primeAudio()
    document.removeEventListener('pointerdown', prime, true)
    document.removeEventListener('keydown', prime, true)
  }
  document.addEventListener('pointerdown', prime, true)
  document.addEventListener('keydown', prime, true)
}

function playNote(ctx, frequency, at, peakGain) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = frequency
  // Short attack avoids the click a gain jump from 0 would make.
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(peakGain, at + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_LENGTH_S)
  osc.connect(gain).connect(ctx.destination)
  osc.start(at)
  osc.stop(at + NOTE_LENGTH_S)
}

/** Plays the chime at `volume` (0..100). Silent at 0 or when audio is unavailable. */
export function playChime(volume, { rounds = ROUNDS } = {}) {
  const peakGain = volumeToGain(volume)
  if (!audioContext || peakGain <= 0) return
  try {
    const start = audioContext.currentTime + 0.02
    for (let round = 0; round < rounds; round += 1) {
      const roundStart = start + round * ROUND_GAP_S
      NOTES_HZ.forEach((hz, i) => playNote(audioContext, hz, roundStart + i * NOTE_GAP_S, peakGain))
    }
  } catch {
    // Sound is a nicety; the toast already tells the user.
  }
}
