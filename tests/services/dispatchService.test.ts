import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as dispatchEventRepo from '../../src/db/dispatchEventRepo'
import * as promptHistoryRepo from '../../src/db/promptHistoryRepo'
import * as workspacePathHistoryRepo from '../../src/db/workspacePathHistoryRepo'
import * as todoRepo from '../../src/db/todoRepo'
import type {
  CreateWorkspaceParams,
  CreatedWorkspace,
  HerdrAgentStatus,
  HerdrClient,
  HerdrSnapshot,
} from '../../src/herdr/herdrClient'
import {
  describePaneRead,
  dispatchTodo,
  expectedInputBoxTail,
  matchesInputBoxPrefix,
  matchesInputBoxTail,
} from '../../src/services/dispatchService'
import { BadRequestError, ConflictError, NotFoundError } from '../../src/services/errors'
import { herdrWorkspaceLabel } from '../../src/services/herdrWorkspaceLabel'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

const noSleep = async (): Promise<void> => undefined
// Must exceed INPUT_BOX_MATCH_LENGTH so a leftover fragment is long enough
// for the post-clear check to actually see it, while still being far too
// short to satisfy the tail check.
const DEFAULT_TRUNCATED_TYPING_LENGTH = 60

// Non-repetitive on purpose: a repeat()-built fixture has its head recurring
// throughout, which hides whether a check is looking at the part of the pane
// that is actually on screen.
function japanesePrompt(clauses: number): string {
  const parts: string[] = []
  const verbs = [
    '認証セッションの有効期限を確認し',
    'リフレッシュトークンの再発行経路を洗い出し',
    '期限切れ時のリダイレクト先を統一し',
    '既存の統合テストが落ちないことを確かめ',
    'ログ出力に個人情報が混ざらないよう見直し',
    'エラー画面の文言を日本語に揃え',
    '再試行の上限回数を設定に切り出し',
  ]
  for (let i = 0; i < clauses; i += 1) {
    parts.push(`第${i + 1}項として${verbs[i % verbs.length]}`)
  }
  return `${parts.join('、')}。以上を完了したら報告してください。`
}
const CLEAR_INPUT_KEY = 'Ctrl+u'
// Defaults used by most tests below: confirm delivery immediately (no real
// wait), and keep settle/keystroke delays and the confirm-timeout at 0 so a
// test that deliberately leaves delivery unconfirmed (postSendStatus:
// 'idle') doesn't spin for the real default duration against a no-op sleep.
const fastDeliveryOptions = {
  settleMs: 0,
  keystrokeDelayBaseMs: 0,
  keystrokeDelayPerCharMs: 0,
  keystrokeDelayMaxMs: 0,
  deliveryConfirmTimeoutMs: 0,
}

interface RecordedClient extends HerdrClient {
  readonly createWorkspaceCalls: CreateWorkspaceParams[]
  readonly runInPaneCalls: { paneId: string; command: string }[]
  readonly sendTextCalls: { paneId: string; text: string }[]
  readonly sendKeysCalls: { paneId: string; keys: string[] }[]
  readonly readPaneCalls: string[]
  /** Ordered log of the sendText/readPane/sendKeys calls that make up prompt
   * delivery. The per-method call lists above can't show interleaving, and
   * interleaving is exactly what the pre-submit verification is about (the
   * clear has to land BETWEEN two sendTexts, the Enter after the last one). */
  readonly deliveryLog: string[]
  readonly closeWorkspaceCalls: string[]
  readonly snapshotCalls: number[]
  failRunInPaneOnCall?: number
  failSendTextOnCall?: number
  failSendKeysOnCall?: number
  /** If set, every readPane() throws it — a pane that cannot be read back. */
  readPaneError?: Error
  /** agentStatus reported for the created pane on the Nth (1-indexed) snapshot()
   * call during the pre-send readiness poll; last value repeats after. */
  agentStatusSequence: HerdrAgentStatus[]
  /** Once sendText has been called at least once, snapshot() reports this
   * status instead (or postSendStatusSequence's, if set) for every
   * delivery-confirmation poll. Defaults to 'working' (confirmed on the
   * first check, no resend). Set to 'idle'/'unknown' to simulate delivery
   * never being confirmed via status alone. */
  postSendStatus: HerdrAgentStatus
  /** If non-empty, overrides postSendStatus with the Nth (1-indexed)
   * post-send snapshot() call's status (last value repeats after) —
   * models status changing across separate confirmation polls, independent
   * of how many times sendKeys/sendText have actually been called. */
  postSendStatusSequence: HerdrAgentStatus[]
  /** What readPane() reports once sendText has been called: true echoes
   * back the last sent text (simulating Enter having failed to submit it —
   * still sitting unsent in the input box); false returns '' (simulating
   * Enter having worked, text no longer visible). Defaults to false. */
  inputBoxStuck: boolean
  /** The first N sendText() calls land only partially in the input box (the
   * first truncatedTypingLength characters), as a still-initializing TUI
   * does. Later ones land whole. Defaults to 0. */
  truncatedTypingAttempts: number
  /** How much of the text lands on a truncated typing attempt. */
  truncatedTypingLength: number
  /** How many rows of the input box `pane read --source visible` shows. null
   * (the default) means the pane is tall enough to show all of it. */
  paneRows: number | null
  /** How many characters of the input box fit on one rendered row. */
  paneCharsPerRow: number
  /** If true, the clear keystroke does not empty the input box — so a retype
   * lands on TOP of whatever was already there. Defaults to false. */
  clearFails: boolean
}

function fakeClient(created: CreatedWorkspace): RecordedClient {
  const createWorkspaceCalls: CreateWorkspaceParams[] = []
  const runInPaneCalls: { paneId: string; command: string }[] = []
  const sendTextCalls: { paneId: string; text: string }[] = []
  const sendKeysCalls: { paneId: string; keys: string[] }[] = []
  const readPaneCalls: string[] = []
  const deliveryLog: string[] = []
  const closeWorkspaceCalls: string[] = []
  const snapshotCalls: number[] = []
  let postSendSnapshotCount = 0
  // What the pane's input box currently holds. Typing APPENDS to it — which
  // is the whole reason the clear has to work, and the reason a failed clear
  // is what a double-send is made of.
  let inputBox = ''

  const client: RecordedClient = {
    createWorkspaceCalls,
    runInPaneCalls,
    sendTextCalls,
    sendKeysCalls,
    readPaneCalls,
    deliveryLog,
    closeWorkspaceCalls,
    snapshotCalls,
    failRunInPaneOnCall: undefined,
    failSendTextOnCall: undefined,
    failSendKeysOnCall: undefined,
    readPaneError: undefined,
    agentStatusSequence: ['idle'],
    postSendStatus: 'working',
    postSendStatusSequence: [],
    inputBoxStuck: false,
    truncatedTypingAttempts: 0,
    truncatedTypingLength: DEFAULT_TRUNCATED_TYPING_LENGTH,
    clearFails: false,
    paneRows: null,
    paneCharsPerRow: 38,
    async snapshot() {
      snapshotCalls.push(Date.now())
      const pane = { paneId: created.paneId, tabId: created.tabId, workspaceId: created.workspaceId }
      if (sendTextCalls.length > 0) {
        postSendSnapshotCount += 1
        const sequence = client.postSendStatusSequence
        const status =
          sequence.length > 0
            ? sequence[Math.min(postSendSnapshotCount - 1, sequence.length - 1)]!
            : client.postSendStatus
        const snapshot: HerdrSnapshot = { panes: [{ ...pane, agentStatus: status }] }
        return snapshot
      }
      const index = Math.min(snapshotCalls.length - 1, client.agentStatusSequence.length - 1)
      const agentStatus = client.agentStatusSequence[index] ?? 'idle'
      const snapshot: HerdrSnapshot = { panes: [{ ...pane, agentStatus }] }
      return snapshot
    },
    createWorkspace: async (params) => {
      createWorkspaceCalls.push(params)
      return created
    },
    runInPane: async (paneId, command) => {
      runInPaneCalls.push({ paneId, command })
      if (runInPaneCalls.length === client.failRunInPaneOnCall) {
        throw new Error('herdr pane run failed')
      }
    },
    sendText: async (paneId, text) => {
      sendTextCalls.push({ paneId, text })
      deliveryLog.push('sendText')
      const landed =
        sendTextCalls.length <= client.truncatedTypingAttempts
          ? text.slice(0, client.truncatedTypingLength)
          : text
      inputBox += landed
      if (sendTextCalls.length === client.failSendTextOnCall) {
        throw new Error('herdr send text failed')
      }
    },
    sendKeys: async (paneId, ...keys) => {
      sendKeysCalls.push({ paneId, keys })
      deliveryLog.push(`sendKeys(${keys.join(' ')})`)
      if (keys.includes(CLEAR_INPUT_KEY) && !client.clearFails) {
        inputBox = ''
      }
      // Enter submits what's in the box and the TUI clears it — unless the
      // submission itself was swallowed (inputBoxStuck), which leaves the
      // text sitting there for the post-Enter resend path to find.
      if (keys.includes('Enter') && !client.inputBoxStuck) {
        inputBox = ''
      }
      if (sendKeysCalls.length === client.failSendKeysOnCall) {
        throw new Error('herdr send keys failed')
      }
    },
    // Models the input box and NOTHING ELSE — no startup banner, no
    // transcript above it. That is the boundary of what this suite can prove:
    // matchesInputBoxTail is a whole-pane substring test, so a real pane with
    // prompt characters rendered OUTSIDE the box (which is what the original
    // incident's pane looked like) is a case these tests cannot construct.
    readPane: async (paneId) => {
      readPaneCalls.push(paneId)
      deliveryLog.push('readPane')
      if (client.readPaneError) {
        throw client.readPaneError
      }
      if (inputBox === '') {
        return ''
      }
      const rows: string[] = []
      for (let i = 0; i < inputBox.length; i += client.paneCharsPerRow) {
        rows.push(`│ ${inputBox.slice(i, i + client.paneCharsPerRow)} │`)
      }
      // `pane read --source visible` returns only the rows on screen, and the
      // TUI keeps the cursor — the END of the text — in view. So a pane
      // shorter than the rendered text shows its LAST rows, never its first.
      const shown = client.paneRows === null ? rows : rows.slice(Math.max(0, rows.length - client.paneRows))
      return shown.join('\n')
    },
    focusTab: async () => undefined,
    closeWorkspace: async (workspaceId) => {
      closeWorkspaceCalls.push(workspaceId)
    },
  }

  return client
}

// Pure-function unit tests, independent of HerdrClient/dispatchTodo.
// `herdr pane read --source visible` only returns what's currently on screen
// (no scrollback), so neither matcher can require the whole prompt to be
// visible; both compare a short window. This one compares the HEAD, which the
// branch's measurements show is the wrong end for text still sitting in the
// input box — see the comment on matchesInputBoxPrefix for why its one
// caller (the post-Enter resend path) keeps it anyway, and what that costs.
describe('matchesInputBoxPrefix', () => {
  test('matches when the pane text contains the exact prompt', () => {
    expect(matchesInputBoxPrefix('❯ Fix the bug', 'Fix the bug')).toBe(true)
  })

  test('does not match when the pane text is unrelated', () => {
    expect(matchesInputBoxPrefix('❯ ', 'Fix the bug')).toBe(false)
  })

  test('does not match an empty pane (nothing in the input box)', () => {
    expect(matchesInputBoxPrefix('', 'Fix the bug')).toBe(false)
  })

  test('matches on a prefix even when the full prompt is longer than what is visible', () => {
    const longPrompt = 'a'.repeat(500)
    // Only the first part of a long prompt is visible on screen; the tail
    // has scrolled/wrapped out of the --source visible viewport.
    const visiblePane = `❯ ${'a'.repeat(60)}`
    expect(matchesInputBoxPrefix(visiblePane, longPrompt)).toBe(true)
  })

  test('does not match when even the prefix is missing (the text is genuinely gone)', () => {
    const longPrompt = 'a'.repeat(500)
    expect(matchesInputBoxPrefix('❯ ', longPrompt)).toBe(false)
  })

  test('is robust to terminal line-wrapping (whitespace/newlines normalized before comparing)', () => {
    const prompt = 'Fix the login bug for SSO users'
    // The terminal wraps the same text across two lines.
    const wrapped = '❯ Fix the login\nbug for SSO users'
    expect(matchesInputBoxPrefix(wrapped, prompt)).toBe(true)
  })

  test('does not false-positive on a short, coincidental substring match', () => {
    // "Fix" alone appearing in unrelated pane content must not count as
    // "the prompt is still there" for a much longer, different prompt.
    expect(matchesInputBoxPrefix('❯ Fixed the typo already', 'Fix the login bug for SSO users end to end')).toBe(
      false
    )
  })
})

describe('matchesInputBoxTail', () => {
  // Real padding characters, not a placeholder — the tail match requires the
  // full INPUT_BOX_MATCH_LENGTH-character block to actually be present, so
  // fixtures must contain real text, not an elided stand-in like "...".
  const prompt = 'あ'.repeat(200) + '末尾の目印テキストです'

  test('末尾が見えていれば true', () => {
    const paneText = `❯ ${'あ'.repeat(30)}末尾の目印テキストです`
    expect(matchesInputBoxTail(paneText, prompt)).toBe(true)
  })

  test('末尾が欠けていれば false', () => {
    expect(matchesInputBoxTail(`❯ ${'あ'.repeat(50)}`, prompt)).toBe(false)
  })

  test('端末の折り返しが入っても一致する', () => {
    // The wrap point coincides with a real space in the prompt, so
    // normalizing the inserted newline back to a space reconstructs the
    // original text exactly (mirrors matchesInputBoxPrefix's own wrap test).
    const wrappingPrompt = 'あ'.repeat(200) + 'the login bug for SSO users'
    const wrapped = 'the login bug\nfor SSO users'
    const paneText = `❯ ${'あ'.repeat(30)}${wrapped}`
    expect(matchesInputBoxTail(paneText, wrappingPrompt)).toBe(true)
  })

  test('プロンプトが40文字未満なら全体を照合する', () => {
    expect(matchesInputBoxTail('❯ 短いプロンプト', '短いプロンプト')).toBe(true)
    expect(matchesInputBoxTail('❯ 別の内容', '短いプロンプト')).toBe(false)
  })

  test('空のプロンプトは false(常に一致してしまうのを防ぐ)', () => {
    expect(matchesInputBoxTail('❯ なんでも', '')).toBe(false)
  })

  // The fixture that was missing, and whose absence let a fatal defect ship:
  // every other fixture here is English or breaks at a real space, so none of
  // them exercise a wrap with no space at the break. Japanese has none — and
  // 40 CJK characters occupy 80 display cells, so on any pane narrower than
  // ~80 the match window spans a wrap every time. Measured against the
  // shipped whitespace-collapsing version, a COMPLETE, correctly typed
  // 1339-character Japanese prompt was accepted 0 times out of 40 at 76, 100
  // and 120 cells: every long Japanese dispatch would have been cleared,
  // retyped, rejected and rolled back.
  describe('日本語の折り返し(空白のない改行)', () => {
    // Hard-wrapped mid-word at a cell boundary, with the │ borders Claude
    // Code draws down both sides of its input box.
    const wrapJapanese = (text: string, charsPerLine: number): string => {
      const lines: string[] = []
      for (let i = 0; i < text.length; i += charsPerLine) {
        lines.push(`│ ${text.slice(i, i + charsPerLine)} │`)
      }
      return lines.join('\n')
    }

    test('折り返しが照合窓の内側に入っても、全文が届いていれば true', () => {
      expect(matchesInputBoxTail(wrapJapanese(prompt, 38), prompt)).toBe(true)
    })

    test('照合窓より細いペインでも true(窓が複数回折り返される)', () => {
      expect(matchesInputBoxTail(wrapJapanese(prompt, 12), prompt)).toBe(true)
    })

    test('折り返されていても、末尾が欠けていれば false', () => {
      expect(matchesInputBoxTail(wrapJapanese(prompt.slice(0, 100), 38), prompt)).toBe(false)
    })
  })

  test('末尾の1文字だけ一致していても、それ以外が無関係なら false(誤検知防止)', () => {
    // Shares only the trailing "です" with the prompt's actual tail — must
    // not be mistaken for the real, much longer tail actually landing.
    // A false positive here means we'd wrongly conclude the truncated
    // prompt is safely still in the input box and skip resending it.
    expect(matchesInputBoxTail('❯ 全く関係ない文章です', prompt)).toBe(false)
  })
})

describe('describePaneRead', () => {
  test('a failed read is reported as such, with no length or excerpt', () => {
    expect(describePaneRead(null)).toEqual({ paneRead: 'failed' })
  })

  test('a short pane is logged whole, with its stripped length', () => {
    expect(describePaneRead('│ 短い入力 │')).toEqual({
      paneStrippedLength: 4,
      pane: '短い入力',
    })
  })

  test('a long pane is bounded to both ends, and the length still reports the whole', () => {
    const pane = `あ${'い'.repeat(300)}う`
    const described = describePaneRead(pane)
    expect(described.paneStrippedLength).toBe(302)
    expect(described.paneHead).toBe(`あ${'い'.repeat(119)}`)
    expect(described.paneTail).toBe(`${'い'.repeat(119)}う`)
    expect(described.pane).toBeUndefined()
  })
})

describe('expectedInputBoxTail', () => {
  test('is the same window matchesInputBoxTail looks for, so the log names what failed', () => {
    const prompt = `${'長い日本語のプロンプトです。'.repeat(10)}最後の一文。`
    const tail = expectedInputBoxTail(prompt)
    expect(tail).toHaveLength(40)
    expect(matchesInputBoxTail(`│ ${tail} │`, prompt)).toBe(true)
  })
})

describe('dispatchTodo', () => {
  test('throws NotFoundError for a missing todo', async () => {
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    await expect(
      dispatchTodo(db, client, 999, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow(NotFoundError)
  })

  test('throws ConflictError when the todo is already dispatched and working', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w0',
      herdrTabId: 'w0:t1',
      herdrPaneId: 'w0:p1',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow(ConflictError)
  })

  test('throws BadRequestError when the todo has no workspacePath and none is given at dispatch time, without calling herdr', async () => {
    const todo = todoRepo.create(db, { title: 'no path set' })
    const client = fakeClient({ workspaceId: 'w8', tabId: 'w8:t1', paneId: 'w8:p1' })
    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow(BadRequestError)
    expect(client.createWorkspaceCalls).toEqual([])
  })

  describe('workspacePath resolution at dispatch time', () => {
    test('a dispatch-time workspacePath is used for the herdr workspace and persisted onto the todo', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/old' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        workspacePath: '/tmp/new',
      })

      expect(client.createWorkspaceCalls).toEqual([{ cwd: '/tmp/new', label: herdrWorkspaceLabel(todo) }])
      expect(result.workspacePath).toBe('/tmp/new')
      expect(todoRepo.getById(db, todo.id)?.workspacePath).toBe('/tmp/new')
    })

    test('a todo with no stored workspacePath can be dispatched by supplying one at dispatch time', async () => {
      const todo = todoRepo.create(db, { title: 'no path set' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        workspacePath: '/tmp/assigned-at-dispatch',
      })

      expect(client.createWorkspaceCalls).toEqual([
        { cwd: '/tmp/assigned-at-dispatch', label: herdrWorkspaceLabel(todo) },
      ])
      expect(result.workspacePath).toBe('/tmp/assigned-at-dispatch')
      expect(todoRepo.getById(db, todo.id)?.workspacePath).toBe('/tmp/assigned-at-dispatch')
    })

    test('omitting workspacePath at dispatch time falls back to the todo-stored value, unchanged', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/stored' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

      expect(client.createWorkspaceCalls).toEqual([{ cwd: '/tmp/stored', label: herdrWorkspaceLabel(todo) }])
      expect(todoRepo.getById(db, todo.id)?.workspacePath).toBe('/tmp/stored')
    })

    test('does not persist workspacePath (or touch createWorkspace) when a length-capped prompt still fails', async () => {
      const todo = todoRepo.create(db, { title: 'x'.repeat(100) })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      const explosivePrompt = '{{title}}'.repeat(200)

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          workspacePath: '/tmp/should-still-be-saved',
          promptBody: explosivePrompt,
        })
      ).rejects.toThrow(BadRequestError)

      // The spec explicitly requires: resolve -> save -> prompt-length check
      // -> workspace creation. So the workspacePath IS saved even though the
      // dispatch as a whole fails on the very next step (prompt too long) —
      // it's the user's own input and isn't tied to whether herdr ever gets
      // called.
      expect(todoRepo.getById(db, todo.id)?.workspacePath).toBe('/tmp/should-still-be-saved')
      expect(client.createWorkspaceCalls).toEqual([])
    })

    test('keeps the dispatch-time workspacePath saved even when the dispatch itself rolls back', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/old' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.failRunInPaneOnCall = 1 // starting claude fails -> rollback

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          workspacePath: '/tmp/kept-despite-rollback',
        })
      ).rejects.toThrow('herdr pane run failed')

      expect(client.closeWorkspaceCalls).toEqual(['w1']) // rollback did happen
      const after = todoRepo.getById(db, todo.id)
      expect(after?.sessionState).toBeNull() // dispatch info rolled back
      expect(after?.workspacePath).toBe('/tmp/kept-despite-rollback') // but not this
    })
  })

  describe('model resolution at dispatch time', () => {
    test('a todo with no model starts claude with no --model flag', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: 'claude' }])
    })

    test('a dispatch-time model is appended as --model and persisted onto the todo', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        model: 'opus',
        allowedModels: ['opus', 'sonnet'],
      })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: 'claude --model opus' }])
      expect(result.model).toBe('opus')
      expect(todoRepo.getById(db, todo.id)?.model).toBe('opus')
    })

    test('omitting model at dispatch time falls back to the todo-stored value', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp', model: 'sonnet' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        allowedModels: ['opus', 'sonnet'],
      })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: 'claude --model sonnet' }])
    })

    test('honors a custom claudeBin, appending --model after it', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await dispatchTodo(db, client, todo.id, {
        claudeBin: '/opt/claude',
        sleep: noSleep,
        model: 'haiku',
        allowedModels: ['haiku'],
      })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: '/opt/claude --model haiku' }])
    })

    test('the codex model launches the Codex CLI instead of claude, with no --model flag', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        model: 'codex',
      })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: 'codex' }])
      expect(result.model).toBe('codex')
    })

    test('honors a custom codexBin for the codex model', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp', model: 'codex' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        codexBin: '/opt/codex',
        sleep: noSleep,
      })

      expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: '/opt/codex' }])
    })

    test('codex is still subject to the allowlist', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          model: 'codex',
          allowedModels: ['opus'],
        })
      ).rejects.toThrow(BadRequestError)
      expect(client.createWorkspaceCalls).toEqual([])
    })

    test('rejects a dispatch-time model not in the allowlist with BadRequestError, without calling herdr', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          model: 'gpt-4',
          allowedModels: ['opus', 'sonnet'],
        })
      ).rejects.toThrow(BadRequestError)
      expect(client.createWorkspaceCalls).toEqual([])
    })

    test('rejects a stale stored model that is no longer in the (now-narrowed) allowlist', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp', model: 'fable' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          allowedModels: ['opus', 'sonnet'],
        })
      ).rejects.toThrow(BadRequestError)
      expect(client.createWorkspaceCalls).toEqual([])
    })

    test('defaults the allowlist to opus/sonnet/haiku/fable/codex when allowedModels is not passed', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        model: 'haiku',
      })

      expect(result.model).toBe('haiku')
    })
  })

  test('creates a workspace labeled "#<id> <title>", starts claude, polls until idle, sends the prompt, and records dispatch', async () => {
    const todo = todoRepo.create(db, { title: 'Fix the bug', workspacePath: '/tmp/proj' })
    const client = fakeClient({ workspaceId: 'w7', tabId: 'w7:t1', paneId: 'w7:p1' })

    const result = await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

    // ここだけリテラルで固定する。他のケースは herdrWorkspaceLabel(todo) と
    // 突き合わせているので、その関数が壊れても両辺が同時に変わって気付けない
    // ——書式そのものは herdrWorkspaceLabel.test.ts と、この1本が押さえる。
    expect(client.createWorkspaceCalls).toEqual([
      { cwd: '/tmp/proj', label: `#${todo.id} Fix the bug` },
    ])
    // runInPane is used only to start claude now (see F48): the task prompt
    // goes through sendText + sendKeys instead.
    expect(client.runInPaneCalls).toEqual([{ paneId: 'w7:p1', command: 'claude' }])
    expect(client.snapshotCalls.length).toBeGreaterThan(0)
    expect(client.sendTextCalls[0]?.paneId).toBe('w7:p1')
    expect(client.sendTextCalls[0]?.text).toBe('Fix the bug')
    expect(client.sendKeysCalls[0]).toEqual({ paneId: 'w7:p1', keys: ['Enter'] })

    expect(result.herdrWorkspaceId).toBe('w7')
    expect(result.herdrTabId).toBe('w7:t1')
    expect(result.herdrPaneId).toBe('w7:p1')
    expect(result.sessionState).toBe('working')
    expect(result.dispatchedAt).not.toBeNull()
    expect(result.promptDelivered).toBe(true)

    expect(dispatchEventRepo.countInRange(db, '2000-01-01', '2999-01-01')).toBe(1)
  })

  test('does not append a TASK_DONE_OK/FAIL completion instruction to the prompt', async () => {
    const todo = todoRepo.create(db, { title: 'Fix the bug', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toBe('Fix the bug')
    expect(prompt).not.toContain('TASK_DONE_OK')
    expect(prompt).not.toContain('TASK_DONE_FAIL')
    expect(prompt).not.toContain('完了したら')
  })

  test('sends text, then Enter as a separate keystroke (not text+Enter in one shot)', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      ...fastDeliveryOptions,
    })

    expect(client.sendTextCalls).toHaveLength(1)
    expect(client.sendTextCalls[0]?.text).not.toContain('\n')
    expect(client.sendKeysCalls).toHaveLength(1)
    expect(client.sendKeysCalls[0]?.keys).toEqual(['Enter'])
  })

  test('waits settleMs after idle is detected, before sending anything', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    const waits: number[] = []

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: async (ms) => {
        waits.push(ms)
      },
      settleMs: 1500,
      keystrokeDelayBaseMs: 0,
      keystrokeDelayPerCharMs: 0,
      keystrokeDelayMaxMs: 0,
      deliveryConfirmTimeoutMs: 0,
    })

    expect(waits).toContain(1500)
  })

  describe('keystroke delay scales with prompt length', () => {
    test('uses the base floor for a short prompt', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' }) // 1 char
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      const waits: number[] = []

      await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: async (ms) => {
          waits.push(ms)
        },
        settleMs: 0,
        keystrokeDelayBaseMs: 300,
        keystrokeDelayPerCharMs: 3,
        keystrokeDelayMaxMs: 3000,
        deliveryConfirmTimeoutMs: 0,
      })

      // 1 char * 3ms/char = 3ms, well below the 300ms floor.
      expect(waits).toContain(300)
    })

    test('scales past the floor for a longer prompt', async () => {
      const todo = todoRepo.create(db, { title: 'x'.repeat(500), workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      const waits: number[] = []

      await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: async (ms) => {
          waits.push(ms)
        },
        settleMs: 0,
        keystrokeDelayBaseMs: 300,
        keystrokeDelayPerCharMs: 3,
        keystrokeDelayMaxMs: 3000,
        deliveryConfirmTimeoutMs: 0,
      })

      // 500 chars * 3ms/char = 1500ms, between the floor and the cap.
      expect(waits).toContain(1500)
    })

    test('is capped for a very long prompt', async () => {
      const todo = todoRepo.create(db, { title: 'x'.repeat(2000), workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      const waits: number[] = []

      await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: async (ms) => {
          waits.push(ms)
        },
        settleMs: 0,
        keystrokeDelayBaseMs: 300,
        keystrokeDelayPerCharMs: 3,
        keystrokeDelayMaxMs: 3000,
        deliveryConfirmTimeoutMs: 0,
      })

      // 2000 chars * 3ms/char = 6000ms, capped down to 3000ms.
      expect(waits).toContain(3000)
      expect(waits).not.toContain(6000)
    })
  })

  // The pre-submit half of delivery. herdr types the prompt into the pane in
  // keystroke batches, and a TUI that is still initializing swallows part of
  // them — on a heavy repo a real dispatch kept only the first ~350 of 1312
  // characters. agent_status can't see that: the pane is 'idle' either way.
  // So the tail of what was typed has to be visible in the pane before Enter
  // is allowed to submit it, or the truncated remainder gets dispatched as
  // if it were the task.
  describe('プロンプト全文の到達を確認してから Enter を押す', () => {
    // Long enough to be truncatable, and ending in text that appears nowhere
    // in its own first 100 characters — so a truncated pane genuinely fails
    // the tail match rather than matching the repeated filler by accident.
    const longPrompt = japanesePrompt(30)

    test('1回目で末尾が見えれば、クリアも打ち直しもしない', async () => {
      const todo = todoRepo.create(db, { title: longPrompt, workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        ...fastDeliveryOptions,
      })

      expect(client.deliveryLog).toEqual(['sendText', 'readPane', 'sendKeys(Enter)'])
      expect(result.promptDelivered).toBe(true)
    })

    test('1回目で末尾が見えなければ Ctrl+u でクリアして打ち直す', async () => {
      const todo = todoRepo.create(db, { title: longPrompt, workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.truncatedTypingAttempts = 1 // the first typing is swallowed; the retype lands
      // A pane showing far fewer rows than the prompt renders to — the normal
      // case for a prompt this long, and the one a head-anchored clear check
      // gets wrong.
      client.paneRows = 3
      client.paneCharsPerRow = 38

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        ...fastDeliveryOptions,
      })

      // The clear has to land BETWEEN the two sendTexts: retyping on top of a
      // half-typed input box would submit the prompt with a partial copy of
      // itself glued to the front.
      expect(client.deliveryLog).toEqual([
        'sendText',
        'readPane',
        'sendKeys(Ctrl+u)',
        'readPane', // the clear itself is verified before anything is retyped
        'sendText',
        'readPane',
        'sendKeys(Enter)',
      ])
      expect(client.sendTextCalls.map((c) => c.text)).toEqual([longPrompt, longPrompt])
      expect(result.promptDelivered).toBe(true)
    })

    test('上限まで確認できなければ例外を投げ、Enter を送らない', async () => {
      const todo = todoRepo.create(db, { title: longPrompt, workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.truncatedTypingAttempts = Number.POSITIVE_INFINITY // never lands, however often retyped

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          ...fastDeliveryOptions,
        })
      ).rejects.toThrow(ConflictError)

      // Submitting a knowingly-truncated prompt is the one outcome that must
      // never happen — better to fail the dispatch and roll the workspace back.
      expect(client.sendKeysCalls.flatMap((c) => c.keys)).not.toContain('Enter')
      expect(client.sendTextCalls).toHaveLength(3)
      expect(client.closeWorkspaceCalls).toEqual(['w1'])
      expect(todoRepo.getById(db, todo.id)?.sessionState).toBeNull()
      expect(dispatchEventRepo.countInRange(db, '2000-01-01', '2999-01-01')).toBe(0)
    })

    // Ctrl+u is a spelling herdr accepts; that is not the same as one that
    // empties Claude Code's buffer. If it doesn't, the retype lands on top of
    // the fragment and the box holds `fragment + prompt` — whose tail IS
    // present, so verification would pass and Enter would submit the
    // concatenation. That is the double-send accident this codebase has
    // already had once, so the clear is read back rather than assumed.
    test('クリアが効いていなければ、打ち直さずに中止する(二重送信の防止)', async () => {
      const todo = todoRepo.create(db, { title: longPrompt, workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.truncatedTypingAttempts = 1
      client.clearFails = true

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          ...fastDeliveryOptions,
        })
      ).rejects.toThrow(ConflictError)

      expect(client.deliveryLog).toEqual(['sendText', 'readPane', 'sendKeys(Ctrl+u)', 'readPane'])
      expect(client.sendTextCalls).toHaveLength(1) // never retyped on top of the fragment
      expect(client.sendKeysCalls.flatMap((c) => c.keys)).not.toContain('Enter')
      expect(client.closeWorkspaceCalls).toEqual(['w1'])
    })

    // Reading the pane in the same breath as the clear assumes the TUI
    // processes Ctrl+u and repaints within one round-trip — the assumption
    // this whole change exists to remove. If it hasn't repainted, the anchor
    // is still on screen and a HEALTHY dispatch aborts. The wait reuses the
    // keystroke floor rather than adding a knob, so zeroed-out test options
    // keep it free.
    test('クリアの後、読み直す前に TUI の再描画を待つ', async () => {
      const todo = todoRepo.create(db, { title: longPrompt, workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.truncatedTypingAttempts = 1

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        // Logged into the same ordered trace as the herdr calls, so the
        // assertion below pins WHERE the wait happens, not just that it did.
        sleep: async (ms) => {
          client.deliveryLog.push(`sleep(${ms})`)
        },
        settleMs: 0,
        keystrokeDelayBaseMs: 250,
        keystrokeDelayPerCharMs: 0,
        keystrokeDelayMaxMs: 250,
        deliveryConfirmTimeoutMs: 0,
      })

      expect(client.deliveryLog).toEqual([
        'sleep(0)', // the post-idle settle
        'sendText',
        'sleep(250)',
        'readPane',
        'sendKeys(Ctrl+u)',
        'sleep(250)', // <- the repaint wait, between the clear and the read-back
        'readPane',
        'sendText',
        'sleep(250)',
        'readPane',
        'sendKeys(Enter)',
      ])
      expect(result.promptDelivered).toBe(true)
    })

    // The clear check must not be anchored to the prompt's head: `pane read
    // --source visible` returns only the rows on screen and the TUI keeps the
    // CURSOR — the end of the text — in view, so once the text renders to
    // more rows than the pane shows, its head is not on screen at all and a
    // head-anchored probe reports "cleared" whatever Ctrl+u did. Here the
    // fragment left behind renders to 5 rows and only the last 3 are visible,
    // so its first 40 characters are off screen.
    test('先頭がペインに映っていなくても、クリアの失敗を検出して中止する', async () => {
      const todo = todoRepo.create(db, { title: longPrompt, workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.truncatedTypingAttempts = 1
      client.truncatedTypingLength = 200
      client.clearFails = true
      client.paneRows = 3
      client.paneCharsPerRow = 40

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          ...fastDeliveryOptions,
        })
      ).rejects.toThrow(ConflictError)

      expect(client.sendTextCalls).toHaveLength(1) // never retyped on top of the fragment
      expect(client.sendKeysCalls.flatMap((c) => c.keys)).not.toContain('Enter')
      expect(client.closeWorkspaceCalls).toEqual(['w1'])
    })

    // The permissive direction is only for a read that never happened, not
    // for one that failed: a pane we could not read back is not a pane we
    // know is empty.
    test('クリア後の readPane が失敗したら、クリア成功とはみなさず中止する', async () => {
      const todo = todoRepo.create(db, { title: longPrompt, workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.truncatedTypingAttempts = 1
      client.truncatedTypingLength = 200
      // The verification read succeeds; the one after the clear does not.
      const failAfter = 1
      const realReadPane = client.readPane
      client.readPane = async (paneId: string) => {
        const text = await realReadPane(paneId)
        if (client.readPaneCalls.length > failAfter) {
          throw new Error('herdr pane read failed')
        }
        return text
      }

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          ...fastDeliveryOptions,
        })
      ).rejects.toThrow(ConflictError)

      expect(client.sendTextCalls).toHaveLength(1) // never retyped into an unknown box
      expect(client.sendKeysCalls.flatMap((c) => c.keys)).not.toContain('Enter')
    })

    // A pane that can't be read says nothing about whether the text landed,
    // so it must cost one attempt rather than the whole dispatch.
    test('readPane が一時的に失敗しても、その回を未確認として打ち直す', async () => {
      const todo = todoRepo.create(db, { title: longPrompt, workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.readPaneError = new Error('herdr pane read failed')

      await expect(
        dispatchTodo(db, client, todo.id, {
          claudeBin: 'claude',
          sleep: noSleep,
          ...fastDeliveryOptions,
        })
      ).rejects.toThrow(ConflictError) // not the raw read error

      expect(client.sendTextCalls).toHaveLength(3) // all three attempts were spent
      expect(client.sendKeysCalls.flatMap((c) => c.keys)).not.toContain('Enter')
    })
  })

  test('promptDelivered is true once agent_status becomes working after sending', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    const result = await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      ...fastDeliveryOptions,
    })

    expect(result.promptDelivered).toBe(true)
    expect(client.sendTextCalls).toHaveLength(1) // confirmed on the first attempt, no retry
  })

  // Regression coverage for a real double-send incident: a long prompt's
  // Enter was swallowed mid-paste, and the naive fix-before-this-fix
  // retried by resending BOTH sendText and Enter — retyping the same text
  // into the still-open input box, so both copies were submitted
  // concatenated into one message. The fix: retry only ever resends Enter.
  test('resends ONLY Enter (never retypes text) when Enter did not submit and the prompt is still in the input box', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.postSendStatus = 'idle' // status never confirms delivery on its own
    client.inputBoxStuck = true // Enter didn't submit; text is still there

    const result = await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      ...fastDeliveryOptions,
    })

    expect(client.sendTextCalls).toHaveLength(1) // <- the actual regression check
    expect(client.sendKeysCalls).toHaveLength(2) // Enter, then Enter again
    expect(result.promptDelivered).toBe(false)
  })

  test('when Enter DID submit (input box empty) but status has not confirmed yet, waits once more without resending anything', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.postSendStatus = 'idle'
    client.inputBoxStuck = false // Enter worked; nothing left in the box

    const result = await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      ...fastDeliveryOptions,
    })

    expect(client.sendTextCalls).toHaveLength(1)
    expect(client.sendKeysCalls).toHaveLength(1) // no Enter resend either
    expect(client.readPaneCalls.length).toBeGreaterThan(0) // input box WAS checked
    expect(result.promptDelivered).toBe(false)
  })

  test('recovers and confirms delivery once the resent Enter actually submits', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.postSendStatus = 'idle' // first attempt: Enter is dropped
    client.inputBoxStuck = true
    client.postSendStatusSequence = ['idle', 'working'] // confirmed after the Enter resend

    const result = await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      ...fastDeliveryOptions,
    })

    expect(client.sendTextCalls).toHaveLength(1)
    expect(client.sendKeysCalls).toHaveLength(2)
    expect(result.promptDelivered).toBe(true)
  })

  test('does NOT roll back when delivery could not be confirmed after resending Enter — dispatch is still recorded', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.postSendStatus = 'idle'
    client.inputBoxStuck = true

    const result = await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      ...fastDeliveryOptions,
    })

    expect(result.promptDelivered).toBe(false)
    expect(result.sessionState).toBe('working')
    expect(client.closeWorkspaceCalls).toEqual([]) // no rollback
    const stored = todoRepo.getById(db, todo.id)
    expect(stored?.sessionState).toBe('working')
    expect(stored?.herdrWorkspaceId).toBe('w1')
    expect(dispatchEventRepo.countInRange(db, '2000-01-01', '2999-01-01')).toBe(1) // still counted as dispatched
  })

  // F48: a blocked/done pane can ONLY be reached after it actually received
  // the prompt, so treating "not working" as "not delivered" and blindly
  // resending was dangerous — it retyped the prompt into an open permission
  // dialog (and pressed Enter on it) or re-dispatched an already-finished
  // task. blocked/done/working are all confirmed on the very first status
  // check, so none of them ever reach the input-box check at all —
  // resending (Enter-only, see the double-send fix above) is only even
  // considered once agent_status alone couldn't confirm delivery.
  describe('F48: does not blindly resend into a blocked/done pane', () => {
    test('blocked (permission dialog open) counts as delivered, with no resend', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.postSendStatus = 'blocked'

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        ...fastDeliveryOptions,
      })

      expect(result.promptDelivered).toBe(true)
      expect(client.sendTextCalls).toHaveLength(1)
      expect(client.sendKeysCalls).toHaveLength(1)
    })

    test('done (task finished inside the confirm window) counts as delivered, with no resend', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.postSendStatus = 'done'

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        ...fastDeliveryOptions,
      })

      expect(result.promptDelivered).toBe(true)
      expect(client.sendTextCalls).toHaveLength(1)
      expect(client.sendKeysCalls).toHaveLength(1)
    })

    test('working counts as delivered, with no resend (control case)', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.postSendStatus = 'working'

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        ...fastDeliveryOptions,
      })

      expect(result.promptDelivered).toBe(true)
      expect(client.sendTextCalls).toHaveLength(1)
    })

    test('idle + text still in the input box resends Enter only (never text)', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.postSendStatus = 'idle'
      client.inputBoxStuck = true

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        ...fastDeliveryOptions,
      })

      expect(result.promptDelivered).toBe(false)
      expect(client.sendTextCalls).toHaveLength(1) // never retyped
      expect(client.sendKeysCalls).toHaveLength(2) // Enter resent once
    })

    test('an unclear status (unknown) with an empty input box is left alone — no resend of anything', async () => {
      const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
      const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
      client.postSendStatus = 'unknown'
      client.inputBoxStuck = false

      const result = await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        ...fastDeliveryOptions,
      })

      expect(result.promptDelivered).toBe(false)
      expect(client.sendTextCalls).toHaveLength(1) // no resend
      expect(client.sendKeysCalls).toHaveLength(1)
    })
  })

  test('collapses newlines in the title into spaces on one line', async () => {
    const todo = todoRepo.create(db, {
      title: 'Fix the bug\nand also\nwrite a test',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain('Fix the bug and also write a test')
  })

  test('polls multiple times when the agent is not idle right away', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.agentStatusSequence = ['working', 'working', 'idle']

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      pollIntervalMs: 1,
    })

    expect(client.snapshotCalls.length).toBeGreaterThanOrEqual(3)
  })

  // The one test in this file that deliberately does NOT inject `sleep`, so
  // it's the only one that actually exercises defaultSleep (real
  // setTimeout) rather than a fake. Every other real-time wait this
  // dispatch would normally do (settle, keystroke delay, delivery confirm)
  // is zeroed out here so the test only burns real wall-clock time on the
  // one thing it's meant to verify — the pollIntervalMs-based readiness
  // polling — rather than also waiting out unrelated multi-second defaults.
  test('uses the real timer-based sleep when no sleep override is given', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.agentStatusSequence = ['working', 'idle']

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      pollIntervalMs: 5,
      settleMs: 0,
      keystrokeDelayBaseMs: 0,
      keystrokeDelayPerCharMs: 0,
      keystrokeDelayMaxMs: 0,
      deliveryConfirmTimeoutMs: 0,
    })

    // The readiness poll needed at least 2 real snapshot() calls
    // (agentStatusSequence: ['working', 'idle']) — this count is
    // deterministic by construction (index-driven, not time-driven), real
    // timers or not.
    expect(client.snapshotCalls.length).toBeGreaterThanOrEqual(2)
  })

  test('rolls back and throws a ConflictError (409) when the agent never reaches idle before the timeout', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.agentStatusSequence = ['working']

    let caught: unknown
    try {
      await dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        agentReadyTimeoutMs: 0,
        pollIntervalMs: 1,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as Error).message).toBe('Claude Code の起動を確認できませんでした')
    expect(client.closeWorkspaceCalls).toEqual(['w1'])
    const after = todoRepo.getById(db, todo.id)
    expect(after?.sessionState).toBeNull()
    expect(after?.herdrWorkspaceId).toBeNull()
    expect(dispatchEventRepo.countInRange(db, '2000-01-01', '2999-01-01')).toBe(0)
  })

  test('allows re-dispatch of a todo that was previously completed', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    todoRepo.markDispatched(db, todo.id, {
      herdrWorkspaceId: 'w0',
      herdrTabId: 'w0:t1',
      herdrPaneId: 'w0:p1',
    })
    todoRepo.complete(db, todo.id)

    const client = fakeClient({ workspaceId: 'w9', tabId: 'w9:t1', paneId: 'w9:p1' })
    const result = await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    expect(result.herdrWorkspaceId).toBe('w9')
  })

  test('uses a custom promptBody instead of the title when provided', async () => {
    const todo = todoRepo.create(db, { title: 'Fix the bug', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Refactor the auth module instead',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toBe('Refactor the auth module instead')
    expect(prompt).not.toContain('Fix the bug')
  })

  test('collapses newlines in a custom promptBody the same way as the title', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Line one\nLine two\nLine three',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain('Line one Line two Line three')
  })

  test('substitutes {{title}} and {{description}} with the todo\'s real values', async () => {
    const todo = todoRepo.create(db, {
      title: 'Fix the login bug',
      description: 'Users cannot log in with SSO',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Task: {{title}}\nDetails: {{description}}',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toContain('Fix the login bug')
    expect(prompt).toContain('Users cannot log in with SSO')
    expect(prompt).not.toContain('{{title}}')
    expect(prompt).not.toContain('{{description}}')
  })

  test('substitutes placeholders with inner whitespace, e.g. {{ title }}', async () => {
    const todo = todoRepo.create(db, { title: 'Fix it', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Please: {{ title }}',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toContain('Please: Fix it')
  })

  test('leaves unknown {{placeholders}} untouched', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'See {{ticket_id}} for context',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toContain('{{ticket_id}}')
  })

  test('leaves Object.prototype-inherited keys untouched (not resolved via prototype chain lookup)', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody:
        '{{constructor}} {{toString}} {{valueOf}} {{__proto__}} {{hasOwnProperty}}',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toContain('{{constructor}}')
    expect(prompt).toContain('{{toString}}')
    expect(prompt).toContain('{{valueOf}}')
    expect(prompt).toContain('{{__proto__}}')
    expect(prompt).toContain('{{hasOwnProperty}}')
    expect(prompt).not.toContain('native code')
    expect(prompt).not.toContain('[object Object]')
  })

  test('does not re-substitute {{description}} when it appears literally inside the title', async () => {
    const todo = todoRepo.create(db, {
      title: 'Contains {{description}} literally',
      description: 'REAL DESCRIPTION',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: '{{title}}',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toContain('Contains {{description}} literally')
    expect(prompt).not.toContain('REAL DESCRIPTION')
  })

  test('does not re-substitute {{title}} when it appears literally inside the description (symmetry with the above)', async () => {
    const todo = todoRepo.create(db, {
      title: 'REAL TITLE',
      description: 'Contains {{title}} literally',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: '{{description}}',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toContain('Contains {{title}} literally')
    expect(prompt).not.toContain('REAL TITLE')
  })

  test('substitutes {{description}} with an empty string when the todo has no description', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Before[{{description}}]After',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toContain('Before[]After')
  })

  test('does not corrupt substitution when the title contains a literal "$" (String.replace special pattern)', async () => {
    const todo = todoRepo.create(db, { title: 'Fix $& and $1 handling', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Task: {{title}}',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toContain('Fix $& and $1 handling')
  })

  test('applies substitution before newline normalization (substituted newlines get collapsed too)', async () => {
    const todo = todoRepo.create(db, {
      title: 'Line A\nLine B',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: '{{title}}',
    })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain('Line A Line B')
  })

  test('does not substitute placeholders when no custom prompt is given (title-only dispatch)', async () => {
    const todo = todoRepo.create(db, { title: '{{title}} literal', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

    const prompt = client.sendTextCalls[0]?.text ?? ''
    expect(prompt).toContain('{{title}} literal')
  })

  test('records the raw (pre-substitution) prompt in history, not the substituted text', async () => {
    const todo = todoRepo.create(db, {
      title: 'Fix the bug',
      description: 'It crashes on save',
      workspacePath: '/tmp',
    })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Task: {{title}} — {{description}}',
    })

    const history = promptHistoryRepo.listAll(db)
    expect(history).toHaveLength(1)
    expect(history[0]?.body).toBe('Task: {{title}} — {{description}}')
  })

  test('records a custom promptBody in history after a successful dispatch', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      promptBody: 'Remember this prompt',
    })

    const history = promptHistoryRepo.listAll(db)
    expect(history).toHaveLength(1)
    expect(history[0]?.body).toBe('Remember this prompt')
  })

  test('does not record anything in history when no promptBody is given (title-only dispatch)', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

    expect(promptHistoryRepo.listAll(db)).toEqual([])
  })

  test('does not record history when the dispatch fails and rolls back', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.failSendTextOnCall = 1 // fails while sending the (custom) prompt

    await expect(
      dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        promptBody: 'should never be recorded',
      })
    ).rejects.toThrow('herdr send text failed')

    expect(promptHistoryRepo.listAll(db)).toEqual([])
  })

  // The workspacePath history is the workspacePath counterpart to the prompt
  // history above, and follows it exactly: success-path only, so a path that
  // was never actually run in never shows up as a suggestion.
  test('records the workspacePath in history after a successful dispatch', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/proj' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })

    expect(workspacePathHistoryRepo.listAll(db).map((h) => h.path)).toEqual(['/tmp/proj'])
  })

  test('records the dispatch-time override, not the previously saved path', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/old' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    await dispatchTodo(db, client, todo.id, {
      claudeBin: 'claude',
      sleep: noSleep,
      workspacePath: '/tmp/new',
    })

    expect(workspacePathHistoryRepo.listAll(db).map((h) => h.path)).toEqual(['/tmp/new'])
  })

  test('does not record the workspacePath when the dispatch fails and rolls back', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp/proj' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.failSendTextOnCall = 1

    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow('herdr send text failed')

    expect(workspacePathHistoryRepo.listAll(db)).toEqual([])
  })

  test('rolls back the workspace and clears dispatch info when starting claude fails', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.failRunInPaneOnCall = 1 // fail the very first pane run (starting claude)

    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow('herdr pane run failed')

    expect(client.closeWorkspaceCalls).toEqual(['w1'])
    const after = todoRepo.getById(db, todo.id)
    expect(after?.herdrWorkspaceId).toBeNull()
    expect(after?.herdrTabId).toBeNull()
    expect(after?.herdrPaneId).toBeNull()
    expect(after?.sessionState).toBeNull()
    expect(after?.dispatchedAt).toBeNull()
    expect(dispatchEventRepo.countInRange(db, '2000-01-01', '2999-01-01')).toBe(0)
  })

  test('rolls back the workspace when sending the task prompt fails', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.failSendTextOnCall = 1 // claude starts fine, sending the prompt fails

    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow('herdr send text failed')

    expect(client.closeWorkspaceCalls).toEqual(['w1'])
    expect(todoRepo.getById(db, todo.id)?.sessionState).toBeNull()
  })

  test('still throws the original error even if closeWorkspace itself fails', async () => {
    const todo = todoRepo.create(db, { title: 'x', workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    client.failRunInPaneOnCall = 1
    client.closeWorkspace = async () => {
      throw new Error('close also failed')
    }

    await expect(
      dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    ).rejects.toThrow('herdr pane run failed')
    // Rollback of the DB state is independent of closeWorkspace succeeding.
    expect(todoRepo.getById(db, todo.id)?.sessionState).toBeNull()
  })

  test('throws BadRequestError before any herdr call when placeholder expansion blows past the prompt length cap', async () => {
    const todo = todoRepo.create(db, { title: 'x'.repeat(100), workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })
    // 100-char title x 200 occurrences = 20,000 chars, well past the 8,000 cap.
    const explosivePrompt = '{{title}}'.repeat(200)

    await expect(
      dispatchTodo(db, client, todo.id, {
        claudeBin: 'claude',
        sleep: noSleep,
        promptBody: explosivePrompt,
      })
    ).rejects.toThrow(BadRequestError)

    expect(client.createWorkspaceCalls).toEqual([])
    expect(client.runInPaneCalls).toEqual([])
    expect(client.closeWorkspaceCalls).toEqual([])
    expect(todoRepo.getById(db, todo.id)?.sessionState).toBeNull()
  })

  test('does not throw for a title-only dispatch even with a long (but under-cap) title', async () => {
    const todo = todoRepo.create(db, { title: 'a'.repeat(200), workspacePath: '/tmp' })
    const client = fakeClient({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' })

    const result = await dispatchTodo(db, client, todo.id, { claudeBin: 'claude', sleep: noSleep })
    expect(result.sessionState).toBe('working')
  })
})
