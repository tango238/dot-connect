import { describe, expect, test } from 'bun:test'
import {
  ACTIVITY_WINDOW_DAYS,
  groupByRecentActivity,
  isRecentlyActive,
  lastActivityAt,
} from '../../public/js/lib/todoActivity.js'

const TODAY = '2026-09-04'

// 日付だけ渡せば済むようにしておく。時刻部分は判定に使われない(日単位で
// 比べる既存方針)ので、テストでは 00:00:00 固定でよい。
function todo(id, { at, createdAt, status = 'open' } = {}) {
  return {
    id,
    status,
    createdAt: `${createdAt ?? '2026-01-01'} 00:00:00`,
    updatedAt: at ? `${at} 00:00:00` : null,
  }
}

describe('lastActivityAt', () => {
  test('updatedAt を返す', () => {
    expect(lastActivityAt(todo(1, { at: '2026-09-01' }))).toBe('2026-09-01 00:00:00')
  })

  test('updatedAt が無いTODOは createdAt にフォールバックする', () => {
    // 作成直後、および updated_at 導入前から居座っている既存TODO。
    for (const updatedAt of [null, undefined]) {
      expect(lastActivityAt({ createdAt: '2026-02-01 00:00:00', updatedAt })).toBe(
        '2026-02-01 00:00:00'
      )
    }
  })
})

describe('isRecentlyActive', () => {
  test('最終更新が今日なら通す', () => {
    expect(isRecentlyActive(todo(1, { at: TODAY }), TODAY)).toBe(true)
  })

  test('境界: 29日前は通り、30日前は落ちる', () => {
    // 「直近30日」は今日を含む30日間(今日から29日前まで) —— 既存の
    // isRecentlyCompleted の数え方と揃える。
    expect(ACTIVITY_WINDOW_DAYS).toBe(30)
    expect(isRecentlyActive(todo(1, { at: '2026-08-06' }), TODAY)).toBe(true)
    expect(isRecentlyActive(todo(2, { at: '2026-08-05' }), TODAY)).toBe(false)
  })

  test('完了TODOは最終更新が新しくても落とす', () => {
    expect(isRecentlyActive(todo(1, { at: TODAY, status: 'done' }), TODAY)).toBe(false)
  })

  test('updatedAt が無いTODOは createdAt で判定する', () => {
    expect(isRecentlyActive(todo(1, { createdAt: '2026-09-03' }), TODAY)).toBe(true)
    expect(isRecentlyActive(todo(2, { createdAt: '2026-01-01' }), TODAY)).toBe(false)
  })
})

describe('groupByRecentActivity', () => {
  const labelsOf = (groups) => groups.map((g) => `${g.label}:${g.todos.map((t) => t.id).join(',')}`)

  test('直近1/3/7/14/30日の区切りに、狭い方から順に振り分ける', () => {
    const groups = groupByRecentActivity(
      [
        todo(1, { at: TODAY }), // 今日 → 1日
        todo(2, { at: '2026-09-02' }), // 2日前 → 3日
        todo(3, { at: '2026-08-30' }), // 5日前 → 7日
        todo(4, { at: '2026-08-25' }), // 10日前 → 14日
        todo(5, { at: '2026-08-15' }), // 20日前 → 30日
      ],
      TODAY
    )
    expect(labelsOf(groups)).toEqual([
      '直近1日以内:1',
      '直近3日以内:2',
      '直近7日以内:3',
      '直近14日以内:4',
      '直近30日以内:5',
    ])
  })

  test('区切りの境界は「以内」なので、ちょうどN日目は狭い方に入る', () => {
    // 「直近3日以内」= 今日を含む3日間(今日から2日前まで)
    const groups = groupByRecentActivity(
      [todo(1, { at: '2026-09-02' }), todo(2, { at: '2026-09-01' })],
      TODAY
    )
    expect(labelsOf(groups)).toEqual(['直近3日以内:1', '直近7日以内:2'])
  })

  test('空の区切りは出さない', () => {
    const groups = groupByRecentActivity([todo(1, { at: '2026-08-25' })], TODAY)
    expect(labelsOf(groups)).toEqual(['直近14日以内:1'])
  })

  test('区切りの中は最終更新の降順、同着は id 降順', () => {
    const groups = groupByRecentActivity(
      [
        todo(1, { at: '2026-09-02' }),
        todo(9, { at: '2026-09-03' }),
        todo(5, { at: '2026-09-03' }),
        todo(7, { at: '2026-09-04' }),
      ],
      TODAY
    )
    expect(labelsOf(groups)).toEqual(['直近1日以内:7', '直近3日以内:9,5,1'])
  })

  test('30日より古いものと完了TODOは、そもそも区切りに入らない', () => {
    const groups = groupByRecentActivity(
      [
        todo(1, { at: TODAY }),
        todo(2, { at: '2026-01-01' }),
        todo(3, { at: TODAY, status: 'done' }),
      ],
      TODAY
    )
    expect(labelsOf(groups)).toEqual(['直近1日以内:1'])
  })

  test('全部落ちれば空配列', () => {
    expect(groupByRecentActivity([todo(1, { at: '2026-01-01' })], TODAY)).toEqual([])
  })

  test('元の配列を書き換えない', () => {
    const list = [todo(1, { at: '2026-09-01' }), todo(2, { at: TODAY })]
    groupByRecentActivity(list, TODAY)
    expect(list.map((t) => t.id)).toEqual([1, 2])
  })
})
