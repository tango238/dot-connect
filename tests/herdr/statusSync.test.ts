import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import type { HerdrClient, HerdrSnapshot } from '../../src/herdr/herdrClient'
import { parseSqliteUtcMs, syncStatuses } from '../../src/herdr/statusSync'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

function fakeClient(snapshot: HerdrSnapshot): HerdrClient {
  return {
    snapshot: async () => snapshot,
    createWorkspace: async () => {
      throw new Error('not used in this test')
    },
    runInPane: async () => undefined,
    sendText: async () => undefined,
    sendKeys: async () => undefined,
    readPane: async () => '',
    focusTab: async () => undefined,
    closeWorkspace: async () => undefined,
  }
}

describe('syncStatuses', () => {
  test('updates session_state for todos whose pane matches the snapshot', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })

    const client = fakeClient({
      panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'blocked' }],
    })

    const result = await syncStatuses(db, client)

    expect(result.updatedCount).toBe(1)
    expect(todoRepo.getById(db, todo.id)?.sessionState).toBe('blocked')
  })

  test('does not update todos without a herdr_pane_id', async () => {
    todoRepo.create(db, { title: 'no pane' })
    const client = fakeClient({ panes: [] })
    const result = await syncStatuses(db, client)
    expect(result.updatedCount).toBe(0)
  })

  test('leaves session_state untouched when the snapshot agent_status is unknown', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })
    const client = fakeClient({
      panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'unknown' }],
    })
    const result = await syncStatuses(db, client)
    expect(result.updatedCount).toBe(0)
    expect(todoRepo.getById(db, todo.id)?.sessionState).toBe('working')
  })

  test('clears the herdr session linkage entirely when the pane is no longer in the snapshot', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })
    const client = fakeClient({ panes: [] })
    const result = await syncStatuses(db, client)
    expect(result.updatedCount).toBe(1)
    const updated = todoRepo.getById(db, todo.id)
    expect(updated?.sessionState).toBeNull()
    expect(updated?.herdrWorkspaceId).toBeNull()
    expect(updated?.herdrTabId).toBeNull()
    expect(updated?.herdrPaneId).toBeNull()
    expect(updated?.dispatchedAt).toBeNull()
  })

  test('does not count a no-op update where status already matches', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })
    const client = fakeClient({
      panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'working' }],
    })
    const result = await syncStatuses(db, client)
    expect(result.updatedCount).toBe(0)
  })

  test('clears the herdr session linkage when a still-present pane reports unknown well past the dispatch grace period', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    const dispatched = todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })
    const dispatchedMs = parseSqliteUtcMs(dispatched.dispatchedAt)
    if (dispatchedMs === null) throw new Error('expected dispatchedAt to be set')

    const client = fakeClient({
      panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'unknown' }],
    })
    const result = await syncStatuses(db, client, () => dispatchedMs + 61_000)

    expect(result.updatedCount).toBe(1)
    const updated = todoRepo.getById(db, todo.id)
    expect(updated?.sessionState).toBeNull()
    expect(updated?.herdrWorkspaceId).toBeNull()
    expect(updated?.herdrTabId).toBeNull()
    expect(updated?.herdrPaneId).toBeNull()
    expect(updated?.dispatchedAt).toBeNull()
  })

  test('does not clear an unknown status within the dispatch grace period (avoids a false-positive race)', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    const dispatched = todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })
    const dispatchedMs = parseSqliteUtcMs(dispatched.dispatchedAt)
    if (dispatchedMs === null) throw new Error('expected dispatchedAt to be set')

    const client = fakeClient({
      panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'unknown' }],
    })
    const result = await syncStatuses(db, client, () => dispatchedMs + 10_000)

    expect(result.updatedCount).toBe(0)
    const updated = todoRepo.getById(db, todo.id)
    expect(updated?.sessionState).toBe('working')
    expect(updated?.herdrPaneId).toBe('w1:p1')
    expect(updated?.dispatchedAt).not.toBeNull()
  })

  test('clears an unknown status with a null dispatchedAt (fails toward cleaning up stale state)', async () => {
    const todo = todoRepo.create(db, { title: 'x' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })
    db.run(`UPDATE todos SET dispatched_at = NULL WHERE id = ?`, [todo.id])

    const client = fakeClient({
      panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'unknown' }],
    })
    const result = await syncStatuses(db, client)

    expect(result.updatedCount).toBe(1)
    expect(todoRepo.getById(db, todo.id)?.sessionState).toBeNull()
  })
})

describe('parseSqliteUtcMs', () => {
  test('reads SQLite datetime() output as UTC, not local time', () => {
    expect(parseSqliteUtcMs('2026-07-31 01:44:05')).toBe(Date.parse('2026-07-31T01:44:05.000Z'))
  })

  test('also accepts a full ISO8601 string', () => {
    expect(parseSqliteUtcMs('2026-07-31T01:44:05Z')).toBe(Date.parse('2026-07-31T01:44:05.000Z'))
  })

  test('returns null for null, empty, and unparseable input', () => {
    expect(parseSqliteUtcMs(null)).toBeNull()
    expect(parseSqliteUtcMs('')).toBeNull()
    expect(parseSqliteUtcMs('not-a-date')).toBeNull()
  })
})

// 「最近の更新」がバックグラウンド同期に荒らされないことは、syncStatuses が
// 状態の変わっていないTODOに書き込まないことに全面的に乗っている。ここが
// 外れると、投入済みのTODOがポーリングのたびに一覧の先頭を占拠して機能が
// 無意味になるので、updated_at 側から直接ガードを守る。
describe('syncStatuses と updated_at', () => {
  function dispatch(title: string) {
    const todo = todoRepo.create(db, { title })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w1',
      herdrTabId: 'w1:t1',
      herdrPaneId: 'w1:p1',
    })
    // markDispatched が入れた値を消して、以降の書き込みだけを観測する
    db.run('UPDATE todos SET updated_at = NULL WHERE id = ?', [todo.id])
    return todo.id
  }

  const workingSnapshot = {
    panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'working' as const }],
  }

  test('状態が変わらない周回では updated_at を動かさない', async () => {
    const id = dispatch('x')
    // markDispatched が session_state を 'working' にしているので、同じ状態を
    // 返すスナップショットは「変化なし」の周回になる
    const result = await syncStatuses(db, fakeClient(workingSnapshot))

    expect(result.updatedCount).toBe(0)
    expect(todoRepo.getById(db, id)?.updatedAt).toBeNull()
  })

  test('何周しても変化がなければ updated_at は入らない', async () => {
    const id = dispatch('x')
    for (let i = 0; i < 3; i += 1) {
      await syncStatuses(db, fakeClient(workingSnapshot))
    }
    expect(todoRepo.getById(db, id)?.updatedAt).toBeNull()
  })

  test('状態が実際に変わった周回では updated_at が入る', async () => {
    const id = dispatch('x')
    const client = fakeClient({
      panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'blocked' }],
    })

    expect((await syncStatuses(db, client)).updatedCount).toBe(1)
    expect(todoRepo.getById(db, id)?.updatedAt).not.toBeNull()
  })

  test('ペインが消えて紐付けが外れた周回でも updated_at が入る', async () => {
    const id = dispatch('x')
    // スナップショットにペインが無い = workspace が dot-connect の外で閉じられた
    const result = await syncStatuses(db, fakeClient({ panes: [] }))

    expect(result.updatedCount).toBe(1)
    const after = todoRepo.getById(db, id)
    expect(after?.herdrPaneId).toBeNull()
    expect(after?.updatedAt).not.toBeNull()
  })
})
