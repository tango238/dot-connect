import { describe, expect, test } from 'bun:test'
import { BUCKET_LABEL, isOverdue, isRecentlyCompleted, matchesFilter, todoBucket } from '../../public/js/lib/todoFilter.js'

function todo(overrides) {
  return { sessionState: null, status: 'open', ...overrides }
}

describe('matchesFilter', () => {
  test('"all" matches everything regardless of state', () => {
    expect(matchesFilter(todo(), 'all')).toBe(true)
    expect(matchesFilter(todo({ status: 'done' }), 'all')).toBe(true)
    expect(matchesFilter(todo({ sessionState: 'working' }), 'all')).toBe(true)
  })

  describe('"running"', () => {
    test('matches an in-progress session', () => {
      expect(matchesFilter(todo({ sessionState: 'working' }), 'running')).toBe(true)
    })
    test('excludes a completed todo even if session is still working', () => {
      expect(matchesFilter(todo({ sessionState: 'working', status: 'done' }), 'running')).toBe(false)
    })
    test('excludes idle/blocked/done sessions and no-session todos', () => {
      for (const sessionState of ['idle', 'blocked', 'done', null]) {
        expect(matchesFilter(todo({ sessionState }), 'running')).toBe(false)
      }
    })
  })

  describe('"review" (確認待ち) — includes idle, per F15', () => {
    test.each(['done', 'blocked', 'idle'])('matches sessionState=%s', (sessionState) => {
      expect(matchesFilter(todo({ sessionState }), 'review')).toBe(true)
    })
    test('excludes a working session', () => {
      expect(matchesFilter(todo({ sessionState: 'working' }), 'review')).toBe(false)
    })
    test('excludes a todo with no session at all', () => {
      expect(matchesFilter(todo({ sessionState: null }), 'review')).toBe(false)
    })
    test('excludes an already-completed todo', () => {
      expect(matchesFilter(todo({ sessionState: 'idle', status: 'done' }), 'review')).toBe(false)
    })
  })

  describe('"open" (未着手) — sessionState-less only', () => {
    test('matches a todo with no session', () => {
      expect(matchesFilter(todo({ sessionState: null }), 'open')).toBe(true)
    })
    test('excludes idle sessions (those belong to "review" per F15)', () => {
      expect(matchesFilter(todo({ sessionState: 'idle' }), 'open')).toBe(false)
    })
    test('excludes completed todos', () => {
      expect(matchesFilter(todo({ sessionState: null, status: 'done' }), 'open')).toBe(false)
    })
  })

  describe('"done"', () => {
    test('matches only completed todos regardless of session state', () => {
      expect(matchesFilter(todo({ status: 'done' }), 'done')).toBe(true)
      expect(matchesFilter(todo({ status: 'done', sessionState: 'working' }), 'done')).toBe(true)
      expect(matchesFilter(todo({ status: 'open' }), 'done')).toBe(false)
    })
  })
})

describe('todoBucket', () => {
  const base = { status: 'open', sessionState: null, pullRequests: [] }
  const openPr = { state: 'open', isDraft: false }

  test('完了が最優先(PRやセッションがあっても done)', () => {
    expect(todoBucket({ ...base, status: 'done', sessionState: 'working', pullRequests: [openPr] })).toBe('done')
  })

  test('実行中はレビュー待ちより優先', () => {
    expect(todoBucket({ ...base, sessionState: 'working', pullRequests: [openPr] })).toBe('running')
  })

  test('open な非draft PR があればレビュー待ち', () => {
    expect(todoBucket({ ...base, pullRequests: [openPr] })).toBe('pr-review')
  })

  test('レビュー待ちはセッションの確認待ちより優先', () => {
    expect(todoBucket({ ...base, sessionState: 'idle', pullRequests: [openPr] })).toBe('pr-review')
  })

  test('draft PR だけならレビュー待ちにしない', () => {
    expect(todoBucket({ ...base, pullRequests: [{ state: 'open', isDraft: true }] })).toBe('open')
  })

  test('merged / closed だけならレビュー待ちにしない', () => {
    expect(todoBucket({ ...base, pullRequests: [{ state: 'merged', isDraft: false }] })).toBe('open')
    expect(todoBucket({ ...base, pullRequests: [{ state: 'closed', isDraft: false }] })).toBe('open')
  })

  test('状態不明(state: null)はレビュー待ちにする', () => {
    expect(todoBucket({ ...base, pullRequests: [{ state: null, isDraft: null }] })).toBe('pr-review')
  })

  test('複数PRのうち1つでも open ならレビュー待ち', () => {
    expect(
      todoBucket({ ...base, pullRequests: [{ state: 'merged', isDraft: false }, openPr] })
    ).toBe('pr-review')
  })

  test('PRなし・セッションありは確認待ち', () => {
    expect(todoBucket({ ...base, sessionState: 'idle' })).toBe('review')
    expect(todoBucket({ ...base, sessionState: 'blocked' })).toBe('review')
  })

  test('PRなし・セッションなしは未着手', () => {
    expect(todoBucket(base)).toBe('open')
  })

  test('pullRequests が undefined でも落ちない', () => {
    expect(todoBucket({ status: 'open', sessionState: null })).toBe('open')
  })
})

describe('matchesFilter with buckets', () => {
  const withOpenPr = { status: 'open', sessionState: 'idle', pullRequests: [{ state: 'open', isDraft: false }] }

  test('all は常に true', () => {
    expect(matchesFilter(withOpenPr, 'all')).toBe(true)
  })

  test('pr-review フィルタはレビュー待ちだけを通す', () => {
    expect(matchesFilter(withOpenPr, 'pr-review')).toBe(true)
    expect(matchesFilter(withOpenPr, 'review')).toBe(false)
    expect(matchesFilter(withOpenPr, 'open')).toBe(false)
  })
})

describe('BUCKET_LABEL', () => {
  test('全バケットに日本語ラベルがある', () => {
    for (const bucket of ['done', 'running', 'pr-review', 'review', 'open']) {
      expect(typeof BUCKET_LABEL[bucket]).toBe('string')
      expect(BUCKET_LABEL[bucket].length).toBeGreaterThan(0)
    }
    expect(BUCKET_LABEL['pr-review']).toBe('レビュー待ち')
  })
})

describe('isRecentlyCompleted', () => {
  const TODAY = '2026-08-07'
  const at = (date) => ({ completedAt: `${date} 09:30:00` })

  // Boundary: today − 6 days inclusive (7-day window: today + 6 prior days)
  test('今日の完了は表示', () => {
    expect(isRecentlyCompleted(at('2026-08-07'), TODAY)).toBe(true)
  })

  test('6日前は表示(直近7日間の端)', () => {
    expect(isRecentlyCompleted(at('2026-08-01'), TODAY)).toBe(true)
  })

  test('7日前は非表示', () => {
    expect(isRecentlyCompleted(at('2026-07-31'), TODAY)).toBe(false)
  })

  test('8日前は非表示', () => {
    expect(isRecentlyCompleted(at('2026-07-30'), TODAY)).toBe(false)
  })

  test('completedAt が null なら表示する', () => {
    expect(isRecentlyCompleted({ completedAt: null }, TODAY)).toBe(true)
  })

  test('未来日付(時計ずれ)も表示する', () => {
    expect(isRecentlyCompleted(at('2026-08-09'), TODAY)).toBe(true)
  })
})

describe('isOverdue', () => {
  const TODAY = '2026-08-07'
  const due = (dueDate, overrides) => todo({ dueDate, ...overrides })

  test('昨日が期限なら超過', () => {
    expect(isOverdue(due('2026-08-06'), TODAY)).toBe(true)
  })

  test('今日が期限はまだ超過ではない', () => {
    expect(isOverdue(due('2026-08-07'), TODAY)).toBe(false)
  })

  test('明日が期限は超過ではない', () => {
    expect(isOverdue(due('2026-08-08'), TODAY)).toBe(false)
  })

  test('期限なしは超過ではない', () => {
    expect(isOverdue(due(null), TODAY)).toBe(false)
    expect(isOverdue(todo(), TODAY)).toBe(false)
  })

  test('完了済みは期限を過ぎていても超過ではない', () => {
    expect(isOverdue(due('2026-08-06', { status: 'done' }), TODAY)).toBe(false)
  })

  test('不正な日付値は超過にしない(行を壊さない)', () => {
    expect(isOverdue(due('2026-8-6'), TODAY)).toBe(false)
    expect(isOverdue(due('昨日'), TODAY)).toBe(false)
  })

  test('todayIso が無ければ判定しない', () => {
    expect(isOverdue(due('2026-08-06'), '')).toBe(false)
  })
})

describe('matchesFilter with "overdue"', () => {
  const TODAY = '2026-08-07'

  test('期限を過ぎた未完了TODOだけが一致する', () => {
    expect(matchesFilter(todo({ dueDate: '2026-08-06' }), 'overdue', TODAY)).toBe(true)
    expect(matchesFilter(todo({ dueDate: '2026-08-07' }), 'overdue', TODAY)).toBe(false)
    expect(matchesFilter(todo({ dueDate: null }), 'overdue', TODAY)).toBe(false)
    expect(matchesFilter(todo({ dueDate: '2026-08-06', status: 'done' }), 'overdue', TODAY)).toBe(false)
  })

  // 期日超過はバケット(未着手/実行中/…)と直交する軸なので、セッションやPRの
  // 有無で外れてはいけない——「実行中だが期限切れ」こそ見たいものだから。
  test('セッション中・PR待ちでも期限超過なら一致する', () => {
    expect(matchesFilter(todo({ dueDate: '2026-08-06', sessionState: 'working' }), 'overdue', TODAY)).toBe(true)
    expect(
      matchesFilter(
        todo({ dueDate: '2026-08-06', pullRequests: [{ state: 'open', isDraft: false }] }),
        'overdue',
        TODAY
      )
    ).toBe(true)
  })

  test('他のフィルタは期限超過でも従来どおりバケットで判定する', () => {
    const overdueOpen = todo({ dueDate: '2026-08-06' })
    expect(matchesFilter(overdueOpen, 'open', TODAY)).toBe(true)
    expect(matchesFilter(overdueOpen, 'all', TODAY)).toBe(true)
    expect(matchesFilter(overdueOpen, 'running', TODAY)).toBe(false)
  })
})

describe('"recent" (最近の更新)', () => {
  // バケットではなく最終更新で判定する軸。境界と区切りの網羅は
  // tests/frontend/todoActivity.test.js 側で、ここでは matchesFilter が
  // その述語に委ねていることだけを見る。
  const TODAY = '2026-09-04'
  const active = (overrides) =>
    todo({ createdAt: '2026-09-03 00:00:00', updatedAt: null, ...overrides })

  test('最終更新が30日以内の未完了TODOを通す', () => {
    expect(matchesFilter(active(), 'recent', TODAY)).toBe(true)
    expect(matchesFilter(active({ sessionState: 'working' }), 'recent', TODAY)).toBe(true)
    // 期限やセッション状態は関係しない
    expect(matchesFilter(active({ dueDate: '2020-01-01' }), 'recent', TODAY)).toBe(true)
  })

  test('完了TODOと、30日より古いTODOは落とす', () => {
    expect(matchesFilter(active({ status: 'done' }), 'recent', TODAY)).toBe(false)
    expect(matchesFilter(active({ createdAt: '2026-01-01 00:00:00' }), 'recent', TODAY)).toBe(false)
  })
})
