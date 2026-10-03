import { describe, expect, test } from 'bun:test'
import { dueBadge } from '../../public/js/lib/dueBadge.js'

const TODAY = '2026-08-07'

describe('dueBadge', () => {
  test('未設定は null', () => {
    expect(dueBadge(null, TODAY)).toBeNull()
    expect(dueBadge(undefined, TODAY)).toBeNull()
    expect(dueBadge('', TODAY)).toBeNull()
  })

  test('今日は「今日」', () => {
    expect(dueBadge('2026-08-07', TODAY)).toEqual({ label: '今日', className: 'due-soon' })
  })

  test('明日は「明日」', () => {
    expect(dueBadge('2026-08-08', TODAY)).toEqual({ label: '明日', className: 'due-soon' })
  })

  test('明後日以降は M/D 表記', () => {
    expect(dueBadge('2026-08-09', TODAY)).toEqual({ label: '8/9', className: 'due-normal' })
    expect(dueBadge('2026-12-31', TODAY)).toEqual({ label: '12/31', className: 'due-normal' })
  })

  test('過期は超過日数つきで overdue', () => {
    expect(dueBadge('2026-08-06', TODAY)).toEqual({ label: '8/6 (1日超過)', className: 'due-overdue' })
    expect(dueBadge('2026-08-01', TODAY)).toEqual({ label: '8/1 (6日超過)', className: 'due-overdue' })
  })

  test('月をまたぐ超過日数も正しい', () => {
    expect(dueBadge('2026-07-31', TODAY)).toEqual({ label: '7/31 (7日超過)', className: 'due-overdue' })
  })

  test('不正な日付は null', () => {
    expect(dueBadge('2026/08/07', TODAY)).toBeNull()
    expect(dueBadge('not-a-date', TODAY)).toBeNull()
  })

  test('todayIso 未指定は例外を投げず null', () => {
    expect(dueBadge('2026-09-30', undefined)).toBeNull()
  })
})
