import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MINUTES,
  DEFAULT_VOLUME,
  POMODORO_VOLUME_STORAGE_KEY,
  MAX_MINUTES,
  POMODORO_STORAGE_KEY,
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
  volumeToGain,
} from '../../public/js/lib/pomodoro.js'

const MIN = 60_000

function fakeStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    },
    data,
  }
}

describe('normalizeMinutes', () => {
  test('整数の分数はそのまま', () => {
    expect(normalizeMinutes('25')).toBe(25)
    expect(normalizeMinutes(1)).toBe(1)
    expect(normalizeMinutes(MAX_MINUTES)).toBe(MAX_MINUTES)
  })
  test('範囲外・非整数・空は null', () => {
    expect(normalizeMinutes('0')).toBeNull()
    expect(normalizeMinutes(MAX_MINUTES + 1)).toBeNull()
    expect(normalizeMinutes('2.5')).toBeNull()
    expect(normalizeMinutes('')).toBeNull()
    expect(normalizeMinutes('abc')).toBeNull()
    expect(normalizeMinutes(null)).toBeNull()
  })
})

describe('startTimer', () => {
  test('指定分数で走り出し、TODOを保持する', () => {
    const t = startTimer({ minutes: 10, todoId: 3, todoTitle: '調査' }, 1000)
    expect(t).toEqual({
      status: 'running',
      durationMs: 10 * MIN,
      remainingMs: 10 * MIN,
      endsAt: 1000 + 10 * MIN,
      todoId: 3,
      todoTitle: '調査',
    })
  })
  test('TODOなしでも開始できる', () => {
    const t = startTimer({ minutes: DEFAULT_MINUTES }, 0)
    expect(t.todoId).toBeNull()
    expect(t.todoTitle).toBeNull()
  })
  test('不正な分数は例外', () => {
    expect(() => startTimer({ minutes: 0 }, 0)).toThrow()
  })
})

describe('pause / resume / reset', () => {
  const running = startTimer({ minutes: 25 }, 0)

  test('一時停止すると残り時間が固定される', () => {
    const paused = pauseTimer(running, 5 * MIN)
    expect(paused.status).toBe('paused')
    expect(remainingMs(paused, 999 * MIN)).toBe(20 * MIN)
    expect(running.status).toBe('running') // 元の値は変えない
  })
  test('再開すると残り時間から走り直す', () => {
    const resumed = resumeTimer(pauseTimer(running, 5 * MIN), 100 * MIN)
    expect(resumed.status).toBe('running')
    expect(resumed.endsAt).toBe(120 * MIN)
    expect(remainingMs(resumed, 110 * MIN)).toBe(10 * MIN)
  })
  test('リセットは設定時間に戻して一時停止にする', () => {
    const reset = resetTimer(running)
    expect(reset.status).toBe('paused')
    expect(reset.remainingMs).toBe(25 * MIN)
  })
  test('走っていないものに pause しても変わらない', () => {
    const paused = pauseTimer(running, MIN)
    expect(pauseTimer(paused, 2 * MIN)).toBe(paused)
    expect(resumeTimer(running, MIN)).toBe(running)
  })
})

describe('remainingMs / isExpired / finishTimer', () => {
  const running = startTimer({ minutes: 1 }, 0)
  test('走行中は endsAt までの差、下限は0', () => {
    expect(remainingMs(running, 15_000)).toBe(45_000)
    expect(remainingMs(running, 2 * MIN)).toBe(0)
  })
  test('期限を過ぎた走行中のタイマーだけが expired', () => {
    expect(isExpired(running, MIN - 1)).toBe(false)
    expect(isExpired(running, MIN)).toBe(true)
    expect(isExpired(pauseTimer(running, 10), 10 * MIN)).toBe(false)
  })
  test('finishTimer は残り0の finished にする', () => {
    const done = finishTimer(running)
    expect(done.status).toBe('finished')
    expect(remainingMs(done, 0)).toBe(0)
    expect(isActive(done)).toBe(false)
  })
  test('idle は何も持たない', () => {
    expect(idleTimer().status).toBe('idle')
    expect(isActive(idleTimer())).toBe(false)
    expect(isActive(running)).toBe(true)
  })
})

describe('formatRemaining', () => {
  test('MM:SS で、秒は切り上げ', () => {
    expect(formatRemaining(25 * MIN)).toBe('25:00')
    expect(formatRemaining(349_000)).toBe('05:49')
    expect(formatRemaining(348_001)).toBe('05:49')
    expect(formatRemaining(0)).toBe('00:00')
  })
  test('60分以上も分で表す', () => {
    expect(formatRemaining(90 * MIN)).toBe('90:00')
  })
})

describe('filledSegments', () => {
  const running = startTimer({ minutes: 10 }, 0)
  test('経過に応じて埋まる', () => {
    expect(filledSegments(running, 0)).toBe(0)
    expect(filledSegments(running, 5 * MIN)).toBe(PROGRESS_SEGMENTS / 2)
    expect(filledSegments(running, 10 * MIN)).toBe(PROGRESS_SEGMENTS)
  })
  test('idle は0', () => {
    expect(filledSegments(idleTimer(), 0)).toBe(0)
  })
})

describe('loadTimer / saveTimer', () => {
  test('保存したものを読み戻せる', () => {
    const storage = fakeStorage()
    const t = startTimer({ minutes: 5, todoId: 1, todoTitle: 'x' }, 0)
    saveTimer(storage, t)
    expect(loadTimer(storage)).toEqual(t)
  })
  test('未保存・壊れた値は idle', () => {
    expect(loadTimer(fakeStorage())).toEqual(idleTimer())
    expect(loadTimer(fakeStorage({ [POMODORO_STORAGE_KEY]: '{bad' }))).toEqual(idleTimer())
    expect(loadTimer(fakeStorage({ [POMODORO_STORAGE_KEY]: '{"status":"running"}' }))).toEqual(
      idleTimer()
    )
  })
  test('ストレージが例外を投げても落ちない', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadTimer(broken)).toEqual(idleTimer())
    expect(() => saveTimer(broken, idleTimer())).not.toThrow()
  })
})

describe('normalizeVolume', () => {
  test('0〜100 の整数はそのまま', () => {
    expect(normalizeVolume(0)).toBe(0)
    expect(normalizeVolume('60')).toBe(60)
    expect(normalizeVolume(100)).toBe(100)
  })

  test('範囲外は 0〜100 に丸め、小数は四捨五入', () => {
    expect(normalizeVolume(-5)).toBe(0)
    expect(normalizeVolume(250)).toBe(100)
    expect(normalizeVolume(33.6)).toBe(34)
  })

  test('数値でないものは null', () => {
    expect(normalizeVolume('abc')).toBeNull()
    expect(normalizeVolume('')).toBeNull()
    expect(normalizeVolume(null)).toBeNull()
    expect(normalizeVolume(undefined)).toBeNull()
  })
})

describe('volumeToGain', () => {
  test('0 は無音、100 が最大、単調増加', () => {
    expect(volumeToGain(0)).toBe(0)
    expect(volumeToGain(100)).toBeCloseTo(0.5)
    expect(volumeToGain(50)).toBeGreaterThan(0)
    expect(volumeToGain(50)).toBeLessThan(volumeToGain(100))
  })

  test('聴感に合わせて二乗カーブ(50% は最大の 1/4)', () => {
    expect(volumeToGain(50)).toBeCloseTo(volumeToGain(100) / 4)
  })
})

describe('loadVolume / saveVolume', () => {
  test('未保存ならデフォルト', () => {
    expect(loadVolume(fakeStorage())).toBe(DEFAULT_VOLUME)
  })

  test('保存した値を読み戻せる(0 のミュートも保持)', () => {
    const storage = fakeStorage()
    saveVolume(storage, 0)
    expect(storage.data[POMODORO_VOLUME_STORAGE_KEY]).toBe('0')
    expect(loadVolume(storage)).toBe(0)
    saveVolume(storage, 80)
    expect(loadVolume(storage)).toBe(80)
  })

  test('壊れた値や storage 例外はデフォルトに戻る', () => {
    expect(loadVolume(fakeStorage({ [POMODORO_VOLUME_STORAGE_KEY]: 'loud' }))).toBe(DEFAULT_VOLUME)
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadVolume(throwing)).toBe(DEFAULT_VOLUME)
    expect(() => saveVolume(throwing, 50)).not.toThrow()
  })
})
