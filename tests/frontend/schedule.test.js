import { describe, expect, test } from 'bun:test'
import {
  buildSchedulePatch,
  dueTodosOn,
  formatDayHeading,
  formatSchedule,
  formatTimeRange,
  hasSchedule,
  isLocalDateTime,
  layoutBlocks,
  minutesOfTime,
  scheduleFields,
  scheduledTodosOn,
  splitLocalDateTime,
  timeOfMinutes,
} from '../../public/js/lib/schedule.js'

function todo(id, scheduledStart, scheduledEnd, extra = {}) {
  return { id, title: `T${id}`, status: 'open', priority: 'none', dueDate: null, scheduledStart, scheduledEnd, ...extra }
}

describe('isLocalDateTime / splitLocalDateTime', () => {
  test('accepts YYYY-MM-DDTHH:MM only', () => {
    expect(isLocalDateTime('2026-10-30T10:00')).toBe(true)
    expect(isLocalDateTime('2026-10-30 10:00')).toBe(false)
    expect(isLocalDateTime('2026-10-30T10:00:00')).toBe(false)
    expect(isLocalDateTime('2026-10-30T24:00')).toBe(false)
    expect(isLocalDateTime('2026-10-30T10:60')).toBe(false)
    expect(isLocalDateTime(null)).toBe(false)
    expect(isLocalDateTime(undefined)).toBe(false)
  })

  test('splits into date and time', () => {
    expect(splitLocalDateTime('2026-10-30T10:05')).toEqual({ date: '2026-10-30', time: '10:05' })
    expect(splitLocalDateTime('nope')).toBeNull()
  })
})

describe('minutesOfTime / timeOfMinutes', () => {
  test('round-trips and rejects bad times', () => {
    expect(minutesOfTime('00:00')).toBe(0)
    expect(minutesOfTime('10:30')).toBe(630)
    expect(minutesOfTime('23:59')).toBe(1439)
    expect(minutesOfTime('24:00')).toBeNull()
    expect(minutesOfTime('9:30')).toBeNull()
    expect(timeOfMinutes(630)).toBe('10:30')
    expect(timeOfMinutes(1440)).toBe('24:00')
    expect(timeOfMinutes(-5)).toBe('00:00')
  })
})

describe('hasSchedule / formatSchedule / formatTimeRange', () => {
  test('requires both ends', () => {
    expect(hasSchedule(todo(1, '2026-10-30T10:00', '2026-10-30T11:30'))).toBe(true)
    expect(hasSchedule(todo(1, '2026-10-30T10:00', null))).toBe(false)
    expect(hasSchedule(todo(1, null, null))).toBe(false)
    expect(hasSchedule({})).toBe(false)
  })

  test('formats as M/D HH:MM–HH:MM', () => {
    expect(formatSchedule(todo(1, '2026-10-30T10:00', '2026-10-30T11:30'))).toBe('10/30 10:00–11:30')
    expect(formatSchedule(todo(1, '2026-01-05T09:00', '2026-01-05T09:15'))).toBe('1/5 09:00–09:15')
    expect(formatSchedule(todo(1, null, null))).toBeNull()
    expect(formatTimeRange(todo(1, '2026-10-30T10:00', '2026-10-30T11:30'))).toBe('10:00–11:30')
  })
})

describe('scheduledTodosOn', () => {
  test('keeps the day’s scheduled TODOs sorted by start then id', () => {
    const todos = [
      todo(3, '2026-10-30T13:00', '2026-10-30T14:00'),
      todo(1, '2026-10-30T09:00', '2026-10-30T10:00'),
      todo(2, '2026-10-30T09:00', '2026-10-30T09:30'),
      todo(4, '2026-10-31T09:00', '2026-10-31T10:00'),
      todo(5, null, null),
      todo(6, '2026-10-30T09:00', null),
    ]
    expect(scheduledTodosOn(todos, '2026-10-30').map((t) => t.id)).toEqual([1, 2, 3])
  })
})

describe('dueTodosOn', () => {
  test('lists the day’s due TODOs open-first, then by priority, then id', () => {
    const todos = [
      todo(1, null, null, { dueDate: '2026-10-30', status: 'done' }),
      todo(2, null, null, { dueDate: '2026-10-30', priority: 'low' }),
      todo(3, null, null, { dueDate: '2026-10-30', priority: 'high' }),
      todo(4, null, null, { dueDate: '2026-10-31' }),
      todo(5, null, null, { dueDate: null }),
      todo(6, null, null, { dueDate: '2026-10-30' }),
    ]
    expect(dueTodosOn(todos, '2026-10-30').map((t) => t.id)).toEqual([3, 2, 6, 1])
  })
})

describe('layoutBlocks', () => {
  test('non-overlapping blocks each take the full width', () => {
    const blocks = layoutBlocks(scheduledTodosOn([
      todo(1, '2026-10-30T09:00', '2026-10-30T10:00'),
      todo(2, '2026-10-30T10:00', '2026-10-30T11:00'),
    ], '2026-10-30'))
    expect(blocks.map((b) => [b.startMin, b.endMin, b.col, b.cols])).toEqual([
      [540, 600, 0, 1],
      [600, 660, 0, 1],
    ])
  })

  test('overlapping blocks share the width side by side', () => {
    const blocks = layoutBlocks(scheduledTodosOn([
      todo(1, '2026-10-30T09:00', '2026-10-30T11:00'),
      todo(2, '2026-10-30T09:30', '2026-10-30T10:00'),
      todo(3, '2026-10-30T10:00', '2026-10-30T10:30'), // 2 の後ろに入り、列0は1が塞ぐので列1を再利用
      todo(4, '2026-10-30T13:00', '2026-10-30T14:00'), // 別の塊
    ], '2026-10-30'))
    expect(blocks.map((b) => [b.todo.id, b.col, b.cols])).toEqual([
      [1, 0, 2],
      [2, 1, 2],
      [3, 1, 2],
      [4, 0, 1],
    ])
  })

  test('three-way overlap gets three columns', () => {
    const blocks = layoutBlocks(scheduledTodosOn([
      todo(1, '2026-10-30T09:00', '2026-10-30T10:00'),
      todo(2, '2026-10-30T09:15', '2026-10-30T10:00'),
      todo(3, '2026-10-30T09:30', '2026-10-30T10:00'),
    ], '2026-10-30'))
    expect(blocks.map((b) => [b.col, b.cols])).toEqual([[0, 3], [1, 3], [2, 3]])
  })
})

describe('buildSchedulePatch', () => {
  test('all blank clears the schedule', () => {
    expect(buildSchedulePatch({ date: '', start: '', end: '' })).toEqual({ scheduledStart: null, scheduledEnd: null })
    expect(buildSchedulePatch({})).toEqual({ scheduledStart: null, scheduledEnd: null })
  })

  test('date + start + end builds the pair', () => {
    expect(buildSchedulePatch({ date: '2026-10-30', start: '10:00', end: '11:30' })).toEqual({
      scheduledStart: '2026-10-30T10:00',
      scheduledEnd: '2026-10-30T11:30',
    })
  })

  test('a blank end defaults to one hour after the start, clamped inside the day', () => {
    expect(buildSchedulePatch({ date: '2026-10-30', start: '10:00', end: '' })).toEqual({
      scheduledStart: '2026-10-30T10:00',
      scheduledEnd: '2026-10-30T11:00',
    })
    expect(buildSchedulePatch({ date: '2026-10-30', start: '23:30', end: '' })).toEqual({
      scheduledStart: '2026-10-30T23:30',
      scheduledEnd: '2026-10-30T23:59',
    })
    expect(buildSchedulePatch({ date: '2026-10-30', start: '23:59', end: '' })).toHaveProperty('error')
  })

  test('partial or inconsistent input is an error', () => {
    expect(buildSchedulePatch({ date: '', start: '10:00', end: '11:00' }).error).toContain('日付')
    expect(buildSchedulePatch({ date: '2026-10-30', start: '', end: '11:00' }).error).toContain('開始')
    expect(buildSchedulePatch({ date: '2026-10-30', start: '11:00', end: '10:00' }).error).toContain('後')
    expect(buildSchedulePatch({ date: '2026-10-30', start: '11:00', end: '11:00' }).error).toContain('後')
    expect(buildSchedulePatch({ date: '2026-13-30', start: '11:00', end: '12:00' })).toHaveProperty('error')
  })
})

describe('scheduleFields', () => {
  test('splits a scheduled TODO into the three form fields, blank otherwise', () => {
    expect(scheduleFields(todo(1, '2026-10-30T10:00', '2026-10-30T11:30'))).toEqual({ date: '2026-10-30', start: '10:00', end: '11:30' })
    expect(scheduleFields(todo(1, null, null))).toEqual({ date: '', start: '', end: '' })
  })
})

describe('formatDayHeading', () => {
  test('renders the Japanese date with weekday', () => {
    expect(formatDayHeading('2026-10-30')).toBe('2026年10月30日(金)')
    expect(formatDayHeading('2026-01-04')).toBe('2026年1月4日(日)')
  })
})
