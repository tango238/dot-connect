import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import type { HerdrAgentStatus, HerdrClient } from '../../src/herdr/herdrClient'
import { logger } from '../../src/logger'
import type { SessionState } from '../../src/types'
import { completeTodo } from '../../src/services/todoCompletionService'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

interface RecordedClient extends HerdrClient {
  readonly closeWorkspaceCalls: string[]
}

interface FakeOptions {
  /** herdr が返すペインの実状態。undefined ならペインごと存在しない扱い。 */
  readonly live?: HerdrAgentStatus
  readonly snapshotThrows?: boolean
  readonly closeThrows?: boolean
}

function fakeClient(options: FakeOptions = {}): RecordedClient {
  const closeWorkspaceCalls: string[] = []
  return {
    closeWorkspaceCalls,
    snapshot: async () => {
      if (options.snapshotThrows) {
        throw new Error('herdr is not running')
      }
      return {
        panes:
          options.live === undefined
            ? []
            : [{ paneId: 'w7:p1', tabId: 'w7:t1', workspaceId: 'w7', agentStatus: options.live }],
      }
    },
    createWorkspace: async () => {
      throw new Error('not used in this test')
    },
    runInPane: async () => undefined,
    sendText: async () => undefined,
    sendKeys: async () => undefined,
    readPane: async () => '',
    focusTab: async () => undefined,
    closeWorkspace: async (workspaceId) => {
      closeWorkspaceCalls.push(workspaceId)
      if (options.closeThrows) {
        throw new Error('herdr exited with code 1')
      }
    },
  }
}

// herdr に投入済みのTODOを作る。markDispatched は session_state を 'working'
// にするので、テストしたい状態はそのあと直接書き換える。
function dispatched(title: string, sessionState: SessionState) {
  const todo = todoRepo.create(db, { title, workspacePath: '/tmp/proj' })
  todoRepo.markDispatched(db, todo.id, {
    herdrWorkspaceId: 'w7',
    herdrTabId: 'w7:t1',
    herdrPaneId: 'w7:p1',
  })
  todoRepo.updateSessionState(db, todo.id, sessionState)
  return todo.id
}

describe('completeTodo', () => {
  test('存在しないTODOでは null を返し、herdr を呼ばない', async () => {
    const client = fakeClient({ live: 'idle' })
    expect(await completeTodo(db, client, 9999)).toBeNull()
    expect(client.closeWorkspaceCalls).toEqual([])
  })

  test('herdr セッションが無いTODOはそのまま完了するだけ', async () => {
    const todo = todoRepo.create(db, { title: 'no session' })
    const client = fakeClient({ live: 'idle' })

    const completed = await completeTodo(db, client, todo.id)

    expect(completed?.status).toBe('done')
    expect(client.closeWorkspaceCalls).toEqual([])
  })
})

describe('completeTodo が閉じる状態・閉じない状態', () => {
  test.each(['idle', 'done'] as const)(
    'ペインの実状態が %s なら閉じて紐付けも消す',
    async (live) => {
      const id = dispatched('finished work', 'idle')
      const client = fakeClient({ live })

      const completed = await completeTodo(db, client, id)

      expect(client.closeWorkspaceCalls).toEqual(['w7'])
      expect(completed?.status).toBe('done')
      // 閉じたペインを指したままにしない(効くのは reopen したあと)。
      expect(completed?.herdrWorkspaceId).toBeNull()
      expect(completed?.herdrTabId).toBeNull()
      expect(completed?.herdrPaneId).toBeNull()
      expect(completed?.sessionState).toBeNull()
      // 投入時刻は残す: 投入は実際に起きたので、詳細ダイアログの「投入」行を
      // 復元不能に空にしてはいけない(clearDispatch との違い)。
      expect(completed?.dispatchedAt).not.toBeNull()
    }
  )

  test('ペインが working なら閉じず、紐付けも残す', async () => {
    const id = dispatched('still running', 'working')
    const client = fakeClient({ live: 'working' })

    const completed = await completeTodo(db, client, id)

    expect(client.closeWorkspaceCalls).toEqual([])
    expect(completed?.status).toBe('done')
    expect(completed?.herdrWorkspaceId).toBe('w7')
    // complete() の既存の挙動: 走っていたセッションは idle に落とす
    expect(completed?.sessionState).toBe('idle')
  })

  test('ペインが blocked なら閉じない(許可ダイアログを出して人を待っている)', async () => {
    // blocked は「終わった」ではなく「あなたの返事待ち」。閉じると作業も
    // ダイアログも消える —— working と同じ扱いにする。
    const id = dispatched('waiting for permission', 'blocked')
    const client = fakeClient({ live: 'blocked' })

    const completed = await completeTodo(db, client, id)

    expect(client.closeWorkspaceCalls).toEqual([])
    expect(completed?.herdrWorkspaceId).toBe('w7')
  })

  test('保存された状態が idle でも、実状態が working なら閉じない', async () => {
    // session_state は statusSync が最後に回ったときのスナップショットで、
    // MCP経由の完了ではそもそも一度も更新されていないことがある。
    const id = dispatched('stale idle', 'idle')
    const client = fakeClient({ live: 'working' })

    const completed = await completeTodo(db, client, id)

    expect(client.closeWorkspaceCalls).toEqual([])
    expect(completed?.herdrWorkspaceId).toBe('w7')
  })

  test('ペインが見つからなければ閉じない', async () => {
    // 既に手で閉じられている。閉じる相手がいないうえ、実状態を確認できない
    // ので触らない —— 紐付けは statusSync が次の周回で片付ける。
    const id = dispatched('pane is gone', 'idle')
    const client = fakeClient({ live: undefined })

    const completed = await completeTodo(db, client, id)

    expect(client.closeWorkspaceCalls).toEqual([])
    expect(completed?.status).toBe('done')
    expect(completed?.herdrWorkspaceId).toBe('w7')
  })

  test('実状態を確認できなければ閉じない', async () => {
    const warnSpy = spyOn(logger, 'warn')
    try {
      const id = dispatched('herdr is down', 'idle')
      const client = fakeClient({ snapshotThrows: true })

      const completed = await completeTodo(db, client, id)

      expect(client.closeWorkspaceCalls).toEqual([])
      expect(completed?.status).toBe('done')
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('completeTodo の失敗と多重呼び出し', () => {
  test('閉じるのに失敗しても完了は成功し、紐付けは残す', async () => {
    const warnSpy = spyOn(logger, 'warn')
    try {
      const id = dispatched('close fails', 'idle')
      const client = fakeClient({ live: 'idle', closeThrows: true })

      const completed = await completeTodo(db, client, id)

      expect(completed?.status).toBe('done')
      // statusSync が後でペインの不在に気付いて片付ける。
      expect(completed?.herdrWorkspaceId).toBe('w7')
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('完了済みのTODOを再度完了しても、走っているペインを閉じない', async () => {
    // complete() は working を 'idle' に書き換えるので、2回目には「元は
    // 走っていた」が保存値からは判別できない。✔ のダブルクリックや MCP の
    // 二重呼び出しで走っているClaudeを殺さないため、done には何もしない。
    const id = dispatched('double click', 'working')
    const client = fakeClient({ live: 'working' })

    await completeTodo(db, client, id)
    await completeTodo(db, client, id)

    expect(client.closeWorkspaceCalls).toEqual([])
    expect(todoRepo.getById(db, id)?.herdrWorkspaceId).toBe('w7')
  })

  test('完了済みのTODOを再度完了しても herdr を二重に呼ばない', async () => {
    const id = dispatched('done twice', 'idle')
    const client = fakeClient({ live: 'idle' })

    await completeTodo(db, client, id)
    await completeTodo(db, client, id)

    expect(client.closeWorkspaceCalls).toEqual(['w7'])
  })

  test('閉じている間に別のワークスペースへ張り直されたら、そちらは消さない', async () => {
    // closeWorkspace は最大10秒ブロックしうる。その間に reopen → 再dispatch
    // が走ると、無条件の clearDispatch が新しいワークスペースを孤児にする。
    const id = dispatched('re-dispatched mid-close', 'idle')
    const client: RecordedClient = {
      ...fakeClient({ live: 'idle' }),
      closeWorkspaceCalls: [],
      closeWorkspace: async () => {
        todoRepo.markDispatched(db, id, {
          herdrWorkspaceId: 'w9',
          herdrTabId: 'w9:t1',
          herdrPaneId: 'w9:p1',
        })
      },
    }

    await completeTodo(db, client, id)

    const after = todoRepo.getById(db, id)
    expect(after?.herdrWorkspaceId).toBe('w9')
    expect(after?.herdrPaneId).toBe('w9:p1')
  })
})
