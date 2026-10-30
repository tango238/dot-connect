import { describe, expect, test } from 'bun:test'
import {
  barHeights,
  completionRatio,
  deltaLabel,
  formatLeadTime,
  netFlowLabel,
  ratioPercent,
  sharePercent,
  weekdayLabel,
} from '../../public/js/lib/reportStats.js'

describe('weekdayLabel', () => {
  test('maps a local date to its Japanese weekday', () => {
    expect(weekdayLabel('2026-07-20')).toBe('月')
    expect(weekdayLabel('2026-07-26')).toBe('日')
  })
})

describe('formatLeadTime', () => {
  test('minutes, hours and days', () => {
    expect(formatLeadTime(0)).toBe('0分')
    expect(formatLeadTime(45)).toBe('45分')
    expect(formatLeadTime(60)).toBe('1時間')
    expect(formatLeadTime(150)).toBe('2時間30分')
    expect(formatLeadTime(1440)).toBe('1日')
    expect(formatLeadTime(1440 * 3 + 240)).toBe('3日4時間')
  })

  test('drops the minutes once past an hour and the hours once past a day', () => {
    expect(formatLeadTime(1440 * 2 + 5)).toBe('2日')
  })

  test('null / NaN / negative are shown as no data or zero', () => {
    expect(formatLeadTime(null)).toBe('–')
    expect(formatLeadTime(undefined)).toBe('–')
    expect(formatLeadTime(Number.NaN)).toBe('–')
    expect(formatLeadTime(-10)).toBe('0分')
  })
})

describe('deltaLabel', () => {
  test('up, down and flat with a proper minus sign', () => {
    expect(deltaLabel(5, 2)).toEqual({ text: '前週比 +3', dir: 'up' })
    expect(deltaLabel(1, 4)).toEqual({ text: '前週比 −3', dir: 'down' })
    expect(deltaLabel(3, 3)).toEqual({ text: '前週と同じ', dir: 'flat' })
  })
})

describe('ratioPercent / completionRatio', () => {
  test('ratioPercent rounds and returns null without a total', () => {
    expect(ratioPercent(2, 3)).toBe(67)
    expect(ratioPercent(0, 0)).toBeNull()
  })

  test('completionRatio caps at 100 and treats "nothing created" as full or empty', () => {
    expect(completionRatio(3, 4)).toBe(75)
    expect(completionRatio(6, 4)).toBe(100)
    expect(completionRatio(2, 0)).toBe(100)
    expect(completionRatio(0, 0)).toBe(0)
  })
})

describe('netFlowLabel', () => {
  test('describes the direction of the backlog', () => {
    expect(netFlowLabel(0, 0)).toContain('ありませんでした')
    expect(netFlowLabel(2, 5)).toBe('完了が登録を 3 件上回り、未完了が減りました。')
    expect(netFlowLabel(5, 2)).toBe('登録が完了を 3 件上回り、未完了が増えました。')
    expect(netFlowLabel(3, 3)).toContain('横ばい')
  })
})

describe('barHeights', () => {
  test('scales to the tallest bar across both series', () => {
    const out = barHeights([
      { date: '2026-07-20', created: 4, completed: 1 },
      { date: '2026-07-21', created: 0, completed: 2 },
    ])
    expect(out[0]).toMatchObject({ createdPct: 100, completedPct: 25 })
    expect(out[1]).toMatchObject({ createdPct: 0, completedPct: 50 })
  })

  test('an all-zero week does not divide by zero', () => {
    expect(barHeights([{ date: '2026-07-20', created: 0, completed: 0 }])[0]).toMatchObject({ createdPct: 0, completedPct: 0 })
  })
})

describe('sharePercent', () => {
  test('relative to the largest count', () => {
    expect(sharePercent(2, [4, 2, 1])).toBe(50)
    expect(sharePercent(0, [])).toBe(0)
  })
})
