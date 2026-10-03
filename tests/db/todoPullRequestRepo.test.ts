import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as todoPullRequestRepo from '../../src/db/todoPullRequestRepo'
import * as todoRepo from '../../src/db/todoRepo'
import { ConflictError } from '../../src/services/errors'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

function createTodo(title = 'a todo'): number {
  return todoRepo.create(db, { title }).id
}

function link(todoId: number, number: number, url = `https://github.com/o/r/pull/${number}`) {
  return todoPullRequestRepo.create(db, { todoId, url, owner: 'o', repo: 'r', number })
}

// listStaleOpen fixtures need state/fetched_at combinations that `create` and
// `recordFetchSuccess` can't produce directly (recordFetchSuccess always
// stamps fetched_at with the current time), so set them straight on the row.
function setSnapshot(id: number, state: string | null, fetchedAt: string | null) {
  db.run('UPDATE todo_pull_requests SET state = ?, fetched_at = ? WHERE id = ?', [
    state,
    fetchedAt,
    id,
  ])
}

describe('todoPullRequestRepo', () => {
  test('stores a link with no fetched metadata yet', () => {
    const created = link(createTodo(), 7)
    expect(created).toMatchObject({
      url: 'https://github.com/o/r/pull/7',
      owner: 'o',
      repo: 'r',
      number: 7,
      title: null,
      state: null,
      isDraft: null,
      fetchedAt: null,
      fetchError: null,
    })
  })

  test('lists a todo’s links in registration order', () => {
    const todoId = createTodo()
    link(todoId, 2)
    link(todoId, 1)
    expect(todoPullRequestRepo.listByTodoId(db, todoId).map((pr) => pr.number)).toEqual([2, 1])
  })

  test('rejects registering the same PR on one todo twice', () => {
    const todoId = createTodo()
    link(todoId, 7)
    expect(() => link(todoId, 7)).toThrow(ConflictError)
  })

  test('allows the same PR on two different todos', () => {
    const first = createTodo('one')
    const second = createTodo('two')
    link(first, 7)
    expect(() => link(second, 7)).not.toThrow()
  })

  test('groups every link by todo id in one pass', () => {
    const first = createTodo('one')
    const second = createTodo('two')
    link(first, 1)
    link(first, 2)
    link(second, 3)
    const grouped = todoPullRequestRepo.groupAllByTodoId(db)
    expect(grouped.get(first)?.map((pr) => pr.number)).toEqual([1, 2])
    expect(grouped.get(second)?.map((pr) => pr.number)).toEqual([3])
  })

  test('recordFetchSuccess stores the snapshot and clears a previous error', () => {
    const created = link(createTodo(), 7)
    todoPullRequestRepo.recordFetchError(db, created.id, 'gh failed')
    todoPullRequestRepo.recordFetchSuccess(db, created.id, {
      title: 'Fix the thing',
      state: 'merged',
      isDraft: false,
    })
    expect(todoPullRequestRepo.getById(db, created.id)).toMatchObject({
      title: 'Fix the thing',
      state: 'merged',
      isDraft: false,
      fetchError: null,
    })
    expect(todoPullRequestRepo.getById(db, created.id)?.fetchedAt).not.toBeNull()
  })

  // A failed refresh must not blank out a title that was fetched
  // successfully before — the stale value plus a warning beats nothing.
  test('recordFetchError keeps the last known-good snapshot', () => {
    const created = link(createTodo(), 7)
    todoPullRequestRepo.recordFetchSuccess(db, created.id, {
      title: 'Fix the thing',
      state: 'open',
      isDraft: false,
    })
    todoPullRequestRepo.recordFetchError(db, created.id, 'network down')
    expect(todoPullRequestRepo.getById(db, created.id)).toMatchObject({
      title: 'Fix the thing',
      state: 'open',
      fetchError: 'network down',
    })
  })

  test('deleting the todo deletes its PR links', () => {
    const todoId = createTodo()
    const created = link(todoId, 7)
    todoRepo.remove(db, todoId)
    expect(todoPullRequestRepo.getById(db, created.id)).toBeNull()
  })

  test('remove reports whether anything was deleted', () => {
    const created = link(createTodo(), 7)
    expect(todoPullRequestRepo.remove(db, created.id)).toBe(true)
    expect(todoPullRequestRepo.remove(db, created.id)).toBe(false)
  })
})

describe('todoPullRequestRepo.listStaleOpen', () => {
  test('open で fetched_at が古いものだけ返す', () => {
    const todoId = createTodo()
    const neverFetched = link(todoId, 1) // open + fetched_at NULL → 対象、NULL優先で先頭
    const staleEarly = link(todoId, 2) // open + 最も古い → 対象、2番目
    const staleLate = link(todoId, 3) // open + 古い(閾値未満) → 対象、3番目
    const fresh = link(todoId, 4) // open + 新しい(閾値以上) → 対象外
    const mergedStale = link(todoId, 5) // merged + 古い → 対象外(state不一致)
    const closedStale = link(todoId, 6) // closed + 古い → 対象外(state不一致)
    const nullStateStale = link(todoId, 7) // state NULL(gh未導入/未認証時) + 古い → 対象、4番目

    setSnapshot(neverFetched.id, 'open', null)
    setSnapshot(staleEarly.id, 'open', '2025-01-01 00:00:00')
    setSnapshot(staleLate.id, 'open', '2026-08-01 00:00:00')
    setSnapshot(fresh.id, 'open', '2026-08-07 01:00:00')
    setSnapshot(mergedStale.id, 'merged', '2025-01-01 00:00:00')
    setSnapshot(closedStale.id, 'closed', '2025-01-01 00:00:00')
    setSnapshot(nullStateStale.id, null, '2026-08-02 00:00:00')

    const stale = todoPullRequestRepo.listStaleOpen(db, '2026-08-07 00:00:00', 10)
    expect(stale.map((pr) => pr.url)).toEqual([
      neverFetched.url,
      staleEarly.url,
      staleLate.url,
      nullStateStale.url,
    ])
  })

  test('limit を超えない', () => {
    const todoId = createTodo()
    const first = link(todoId, 1)
    const second = link(todoId, 2)
    const third = link(todoId, 3)
    setSnapshot(first.id, 'open', null)
    setSnapshot(second.id, 'open', '2025-01-01 00:00:00')
    setSnapshot(third.id, 'open', '2025-02-01 00:00:00')

    const stale = todoPullRequestRepo.listStaleOpen(db, '2026-08-07 00:00:00', 2)
    expect(stale.length).toBe(2)
  })

  test('対象が無ければ空配列', () => {
    // 唯一の登録は merged + 古い: state不一致なので listStaleOpen の条件に
    // fetched_at IS NULL の行が無く、空配列だけが正しい結果になる。
    const todoId = createTodo()
    const mergedStale = link(todoId, 1)
    setSnapshot(mergedStale.id, 'merged', '2025-01-01 00:00:00')

    expect(todoPullRequestRepo.listStaleOpen(db, '2000-01-01 00:00:00', 10)).toEqual([])
  })
})

describe('todoRepo carries pull requests on the todo', () => {
  test('getById includes the linked PRs', () => {
    const todoId = createTodo()
    link(todoId, 7)
    expect(todoRepo.getById(db, todoId)?.pullRequests.map((pr) => pr.number)).toEqual([7])
  })

  test('listAll includes them, and is empty (not undefined) for todos with none', () => {
    const withPr = createTodo('has one')
    createTodo('has none')
    link(withPr, 7)
    const todos = todoRepo.listAll(db)
    expect(todos.find((t) => t.id === withPr)?.pullRequests).toHaveLength(1)
    expect(todos.find((t) => t.title === 'has none')?.pullRequests).toEqual([])
  })
})

// PRリンクの付け外しは人の操作なので、親TODOの「最終更新」を動かす。
// 一方 recordFetchSuccess/recordFetchError はPRメタデータの取得結果で、
// 動いたのはGitHub側のPRであってTODOではない。経路は3つ(定期の
// refresh-stale / 登録直後の取得 / 更新ボタンの手動実行)あるが、どれでも
// 数えない —— 定期実行で数えるとPRが付いた全TODOが中身の変化なしに更新順の
// 先頭へ上がり続けるため。
describe('todoPullRequestRepo と親TODOの updated_at', () => {
  function updatedAtOf(todoId: number): string | null {
    return todoRepo.getById(db, todoId)?.updatedAt ?? null
  }

  test('リンクの追加で親TODOの updated_at が入る', () => {
    const todoId = createTodo()
    expect(updatedAtOf(todoId)).toBeNull()
    link(todoId, 7)
    expect(updatedAtOf(todoId)).not.toBeNull()
  })

  test('リンクの削除で親TODOの updated_at が入る', () => {
    const todoId = createTodo()
    const created = link(todoId, 7)
    db.run('UPDATE todos SET updated_at = NULL WHERE id = ?', [todoId])
    todoPullRequestRepo.remove(db, created.id)
    expect(updatedAtOf(todoId)).not.toBeNull()
  })

  test('PR状態の取得は経路を問わず親TODOの updated_at を動かさない', () => {
    const todoId = createTodo()
    const created = link(todoId, 7)
    db.run('UPDATE todos SET updated_at = NULL WHERE id = ?', [todoId])

    todoPullRequestRepo.recordFetchSuccess(db, created.id, {
      title: 'A PR',
      state: 'open',
      isDraft: false,
    })
    expect(updatedAtOf(todoId)).toBeNull()

    todoPullRequestRepo.recordFetchError(db, created.id, 'gh not found')
    expect(updatedAtOf(todoId)).toBeNull()
  })
})
