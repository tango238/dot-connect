import { describe, expect, test } from 'bun:test'
import { completedTodayCount, doneTodayBadge, localDateOf } from '../../public/js/lib/doneToday.js'

const TOKYO = 'Asia/Tokyo'

describe('localDateOf', () => {
  test('converts a SQLite UTC datetime to the local date', () => {
    // 23:30 UTC on the 5th is already the 6th in Tokyo (UTC+9)
    expect(localDateOf('2026-11-05 23:30:00', TOKYO)).toBe('2026-11-06')
    expect(localDateOf('2026-11-05 23:30:00', 'UTC')).toBe('2026-11-05')
    expect(localDateOf('2026-11-06 14:59:59', TOKYO)).toBe('2026-11-06')
    expect(localDateOf('2026-11-06 15:00:00', TOKYO)).toBe('2026-11-07')
  })
  test('null / garbage -> null', () => {
    expect(localDateOf(null, TOKYO)).toBeNull()
    expect(localDateOf('', TOKYO)).toBeNull()
    expect(localDateOf('not a date', TOKYO)).toBeNull()
  })
})

describe('completedTodayCount', () => {
  const todos = [
    { status: 'done', completedAt: '2026-11-06 01:00:00' }, // 10:00 Tokyo, today
    { status: 'done', completedAt: '2026-11-05 23:30:00' }, // 08:30 Tokyo on the 6th, today
    { status: 'done', completedAt: '2026-11-05 10:00:00' }, // yesterday
    { status: 'done', completedAt: null }, // odd data: not counted
    { status: 'open', completedAt: '2026-11-06 01:00:00' }, // not done
  ]
  test('counts done todos whose local completion date is today', () => {
    expect(completedTodayCount(todos, '2026-11-06', TOKYO)).toBe(2)
    expect(completedTodayCount(todos, '2026-11-05', TOKYO)).toBe(1)
    expect(completedTodayCount(todos, '2026-11-06', 'UTC')).toBe(1)
  })
  test('empty list -> 0', () => {
    expect(completedTodayCount([], '2026-11-06', TOKYO)).toBe(0)
  })
})

describe('doneTodayBadge', () => {
  test('zero is shown but not active', () => {
    expect(doneTodayBadge(0)).toEqual({ text: '✓ 0', title: '今日完了した TODO はまだありません', active: false })
  })
  test('positive counts are active with the count in the title', () => {
    expect(doneTodayBadge(3)).toMatchObject({ text: '✓ 3', active: true })
    expect(doneTodayBadge(3).title).toContain('3 件')
  })
})
