import { describe, expect, test } from 'bun:test'
import { detailRows, formatDateTime, parseSqliteUtc, SESSION_LABEL } from '../../public/js/lib/todoDetail.js'

function todo(overrides) {
  return {
    id: 1,
    title: 'T',
    description: '',
    milestoneId: null,
    status: 'open',
    priority: 'none',
    dueDate: null,
    model: null,
    workspacePath: null,
    herdrPaneId: null,
    sessionState: null,
    dispatchedAt: null,
    completedAt: null,
    createdAt: '2026-07-31 01:44:05',
    ...overrides,
  }
}

function labels(rows) {
  return rows.map((r) => r.label)
}

function valueOf(rows, label) {
  return rows.find((r) => r.label === label)?.value
}

describe('SESSION_LABEL', () => {
  test('covers every SessionState the API can return', () => {
    expect(SESSION_LABEL).toEqual({
      working: '実行中',
      done: '完了・未確認',
      blocked: '承認待ち',
      idle: '待機',
    })
  })
})

describe('parseSqliteUtc', () => {
  test('reads SQLite datetime() output as UTC, not local time', () => {
    expect(parseSqliteUtc('2026-07-31 01:44:05').toISOString()).toBe('2026-07-31T01:44:05.000Z')
  })

  test('also accepts a full ISO8601 string', () => {
    expect(parseSqliteUtc('2026-07-31T01:44:05Z').toISOString()).toBe('2026-07-31T01:44:05.000Z')
  })

  test('returns null for null, empty, and unparseable input', () => {
    expect(parseSqliteUtc(null)).toBe(null)
    expect(parseSqliteUtc('')).toBe(null)
    expect(parseSqliteUtc('not-a-date')).toBe(null)
  })
})

describe('formatDateTime', () => {
  test('converts UTC to the given timezone', () => {
    expect(formatDateTime('2026-07-31 01:44:05', 'Asia/Tokyo')).toBe('2026-07-31 10:44')
  })

  test('crosses the date boundary correctly', () => {
    expect(formatDateTime('2026-07-30 16:30:00', 'Asia/Tokyo')).toBe('2026-07-31 01:30')
  })

  test('leaves the value alone when the timezone is UTC', () => {
    expect(formatDateTime('2026-07-31 01:44:05', 'UTC')).toBe('2026-07-31 01:44')
  })

  test('drops seconds', () => {
    expect(formatDateTime('2026-07-31 01:44:59', 'UTC')).toBe('2026-07-31 01:44')
  })

  test('returns null for missing values', () => {
    expect(formatDateTime(null, 'UTC')).toBe(null)
    expect(formatDateTime('', 'UTC')).toBe(null)
  })
})

describe('detailRows', () => {
  test('a bare open todo shows only status and created', () => {
    expect(labels(detailRows(todo(), 'UTC'))).toEqual(['ステータス', '作成'])
  })

  test('a fully populated todo shows every row in a fixed order', () => {
    const rows = detailRows(
      todo({
        status: 'done',
        priority: 'high',
        dueDate: '2026-09-30',
        model: 'opus',
        sessionState: 'working',
        herdrPaneId: 'w1:p1',
        workspacePath: '/Users/you/projects/my-app',
        dispatchedAt: '2026-07-31 02:00:00',
        completedAt: '2026-07-31 03:00:00',
      }),
      'UTC',
      '2026-08-07'
    )
    expect(labels(rows)).toEqual([
      'ステータス',
      '期限',
      '優先度',
      'セッション',
      '作業ディレクトリ',
      'モデル',
      '作成',
      '投入',
      '完了',
    ])
  })

  test('status reads 未着手 when open and 完了 when done', () => {
    expect(valueOf(detailRows(todo({ status: 'open' }), 'UTC'), 'ステータス')).toBe('未着手')
    expect(valueOf(detailRows(todo({ status: 'done' }), 'UTC'), 'ステータス')).toBe('完了')
  })

  test('priority reuses the row badge labels', () => {
    expect(valueOf(detailRows(todo({ priority: 'high' }), 'UTC'), '優先度')).toBe('高')
    expect(valueOf(detailRows(todo({ priority: 'low' }), 'UTC'), '優先度')).toBe('低')
  })

  test('期限があれば「期限」行を出す', () => {
    const rows = detailRows(todo({ dueDate: '2026-09-30' }), 'UTC', '2026-08-07')
    expect(valueOf(rows, '期限')).toContain('9/30')
  })

  test('期限は行バッジと同じ相対表現を使う', () => {
    expect(valueOf(detailRows(todo({ dueDate: '2026-08-07' }), 'UTC', '2026-08-07'), '期限')).toBe('今日')
    expect(valueOf(detailRows(todo({ dueDate: '2026-08-05' }), 'UTC', '2026-08-07'), '期限')).toBe(
      '8/5 (2日超過)'
    )
  })

  test('期限が無ければ行を出さない', () => {
    expect(labels(detailRows(todo({ dueDate: null }), 'UTC', '2026-08-07'))).not.toContain('期限')
    expect(labels(detailRows(todo({ dueDate: undefined }), 'UTC', '2026-08-07'))).not.toContain('期限')
  })

  test('there is no priority row for none, or for a todo predating the field', () => {
    expect(labels(detailRows(todo({ priority: 'none' }), 'UTC'))).not.toContain('優先度')
    expect(labels(detailRows(todo({ priority: undefined }), 'UTC'))).not.toContain('優先度')
  })

  test('model is flagged mono and dropped when the todo uses the default', () => {
    const rows = detailRows(todo({ model: 'claude-opus-5' }), 'UTC')
    expect(rows.find((r) => r.label === 'モデル')).toEqual({
      label: 'モデル',
      value: 'claude-opus-5',
      mono: true,
    })
    expect(labels(detailRows(todo({ model: null }), 'UTC'))).not.toContain('モデル')
    expect(labels(detailRows(todo({ model: undefined }), 'UTC'))).not.toContain('モデル')
  })

  test('session appends the pane id when herdr has one', () => {
    const rows = detailRows(todo({ sessionState: 'working', herdrPaneId: 'w1:p1' }), 'UTC')
    expect(valueOf(rows, 'セッション')).toBe('実行中 (w1:p1)')
  })

  test('session omits the pane suffix when there is no pane id', () => {
    const rows = detailRows(todo({ sessionState: 'blocked', herdrPaneId: null }), 'UTC')
    expect(valueOf(rows, 'セッション')).toBe('承認待ち')
  })

  test('an unknown sessionState falls back to the raw value', () => {
    const rows = detailRows(todo({ sessionState: 'mystery' }), 'UTC')
    expect(valueOf(rows, 'セッション')).toBe('mystery')
  })

  test('there is no session row when the todo has no session', () => {
    expect(labels(detailRows(todo({ sessionState: null }), 'UTC'))).not.toContain('セッション')
  })

  test('workspacePath is flagged mono and dropped when blank', () => {
    const rows = detailRows(todo({ workspacePath: '/tmp/proj' }), 'UTC')
    expect(rows.find((r) => r.label === '作業ディレクトリ')).toEqual({
      label: '作業ディレクトリ',
      value: '/tmp/proj',
      mono: true,
    })
    expect(labels(detailRows(todo({ workspacePath: '' }), 'UTC'))).not.toContain('作業ディレクトリ')
    expect(labels(detailRows(todo({ workspacePath: null }), 'UTC'))).not.toContain('作業ディレクトリ')
  })

  test('timestamps are formatted in the given timezone', () => {
    const rows = detailRows(todo({ createdAt: '2026-07-31 01:44:05' }), 'Asia/Tokyo')
    expect(valueOf(rows, '作成')).toBe('2026-07-31 10:44')
  })

  test('null timestamps drop their row entirely', () => {
    const rows = detailRows(todo({ dispatchedAt: null, completedAt: null }), 'UTC')
    expect(labels(rows)).not.toContain('投入')
    expect(labels(rows)).not.toContain('完了')
  })

  test('returns a fresh array and never mutates the todo', () => {
    const input = todo({ workspacePath: '/tmp/proj' })
    const snapshot = { ...input }
    detailRows(input, 'UTC')
    expect(input).toEqual(snapshot)
  })
})

describe('detailRows status row', () => {
  test('open な PR があると「レビュー待ち」', () => {
    const rows = detailRows(
      todo({ status: 'open', sessionState: null, pullRequests: [{ state: 'open', isDraft: false }] }),
      'UTC',
      '2026-08-07'
    )
    expect(rows.find((r) => r.label === 'ステータス').value).toBe('レビュー待ち')
  })

  test('セッションだけなら「確認待ち」', () => {
    const rows = detailRows(
      todo({ status: 'open', sessionState: 'idle', pullRequests: [] }),
      'UTC',
      '2026-08-07'
    )
    expect(rows.find((r) => r.label === 'ステータス').value).toBe('確認待ち')
  })

  test('完了は「完了」', () => {
    const rows = detailRows(
      todo({ status: 'done', sessionState: null, pullRequests: [] }),
      'UTC',
      '2026-08-07'
    )
    expect(rows.find((r) => r.label === 'ステータス').value).toBe('完了')
  })

  test('何もなければ「未着手」', () => {
    const rows = detailRows(
      todo({ status: 'open', sessionState: null, pullRequests: [] }),
      'UTC',
      '2026-08-07'
    )
    expect(rows.find((r) => r.label === 'ステータス').value).toBe('未着手')
  })
})
