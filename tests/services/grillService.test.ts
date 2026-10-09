import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../../src/db/database'
import * as appSettingsRepo from '../../src/db/appSettingsRepo'
import * as dispatchEventRepo from '../../src/db/dispatchEventRepo'
import * as todoRepo from '../../src/db/todoRepo'
import type {
  CreateWorkspaceParams,
  CreatedWorkspace,
  HerdrClient,
  HerdrSnapshot,
} from '../../src/herdr/herdrClient'
import { dispatchTodo } from '../../src/services/dispatchService'
import { BadRequestError, ConflictError, NotFoundError } from '../../src/services/errors'
import {
  cleanupGrill,
  finishGrill,
  GRILL_NUDGE_PROMPT,
  GRILL_START_PROMPT,
  grillDirFor,
  grillRootFor,
  type GrillOptions,
  startGrill,
} from '../../src/services/grillService'
import { herdrWorkspaceLabel } from '../../src/services/herdrWorkspaceLabel'
import { WIP_LIMIT_ENABLED_KEY, WIP_LIMIT_KEY } from '../../src/services/wipLimitService'

let db: Database
let tmp: string
let grillRoot: string

beforeEach(() => {
  db = createDatabase(':memory:')
  tmp = mkdtempSync(join(tmpdir(), 'dot-connect-grill-test-'))
  grillRoot = join(tmp, 'grill')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const WORKSPACE: CreatedWorkspace = { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' }

interface FakeClient extends HerdrClient {
  readonly createWorkspaceCalls: CreateWorkspaceParams[]
  readonly runInPaneCalls: { paneId: string; command: string }[]
  readonly submitPromptCalls: { paneId: string; text: string }[]
  readonly closeWorkspaceCalls: string[]
  paneAlive: boolean
  snapshotError: Error | null
  failRunInPane: boolean
  onSubmit?: (text: string) => void
}

function fakeClient(): FakeClient {
  const client: FakeClient = {
    createWorkspaceCalls: [], runInPaneCalls: [], submitPromptCalls: [], closeWorkspaceCalls: [],
    paneAlive: true, snapshotError: null, failRunInPane: false,
    async snapshot(): Promise<HerdrSnapshot> {
      if (client.snapshotError) throw client.snapshotError
      if (!client.paneAlive) return { panes: [] }
      const agentStatus = client.submitPromptCalls.length ? 'working' : 'idle'
      return { panes: [{ ...WORKSPACE, agentStatus }] }
    },
    async createWorkspace(params) {
      client.createWorkspaceCalls.push(params)
      return WORKSPACE
    },
    async runInPane(paneId, command) {
      client.runInPaneCalls.push({ paneId, command })
      if (client.failRunInPane) throw new Error('herdr pane run failed')
    },
    async submitPrompt(paneId, text) {
      client.submitPromptCalls.push({ paneId, text })
      client.onSubmit?.(text)
    },
    async sendKeys() {},
    async readPane() { return '' },
    async focusTab() {},
    async closeWorkspace(workspaceId) { client.closeWorkspaceCalls.push(workspaceId) },
  }
  return client
}

function options(overrides: Partial<GrillOptions> = {}): GrillOptions {
  return {
    claudeBin: 'claude',
    allowedModels: ['opus', 'sonnet', 'codex'],
    grillRoot,
    sleep: async () => undefined,
    pollIntervalMs: 1,
    settleMs: 0,
    deliveryConfirmTimeoutMs: 0,
    resultTimeoutMs: 0,
    ...overrides,
  }
}

async function grilling(title = 'Fix login', description = 'It breaks', model: string | null = null) {
  const todo = todoRepo.create(db, { title, description, model })
  const client = fakeClient()
  const started = await startGrill(db, client, todo.id, options())
  return { todo, client, started, dir: grillDirFor(grillRoot, todo.id) }
}

describe('grillRootFor', () => {
  test('is a sibling of the db file, or a per-process tmp dir for :memory:', () => {
    expect(grillRootFor('/data/app/dot-connect.db')).toBe('/data/app/grill')
    expect(grillRootFor(':memory:')).toBe(join(tmpdir(), `dot-connect-${process.pid}`, 'grill'))
  })
})

describe('startGrill', () => {
  test('writes TODO.md and GRILL.md and launches claude in a Grill workspace on that dir', async () => {
    const { todo, client, started, dir } = await grilling()

    expect(readFileSync(join(dir, 'TODO.md'), 'utf8')).toBe('# Fix login\n\nIt breaks\n')
    expect(readFileSync(join(dir, 'GRILL.md'), 'utf8')).toContain('GRILLED.md')
    expect(client.createWorkspaceCalls).toEqual([
      { cwd: dir, label: herdrWorkspaceLabel({ id: todo.id, title: 'Grill Fix login' }) },
    ])
    expect(client.runInPaneCalls).toEqual([{ paneId: 'w1:p1', command: 'claude --permission-mode acceptEdits' }])
    expect(client.submitPromptCalls).toEqual([{ paneId: 'w1:p1', text: GRILL_START_PROMPT }])

    expect(started.grillDir).toBe(dir)
    expect(started.promptDelivered).toBe(true)
    expect(started.sessionState).toBe('working')
    expect(started.herdrWorkspaceId).toBe('w1')
    expect(started.herdrPaneId).toBe('w1:p1')
    expect(started.dispatchedAt).not.toBeNull()
    expect(dispatchEventRepo.countInRange(db, '2000-01-01', '2100-01-01')).toBe(0)
  })

  test('passes --model for an allowed claude model', async () => {
    const { client } = await grilling('t', '', 'opus')
    expect(client.runInPaneCalls[0]?.command).toBe('claude --model opus --permission-mode acceptEdits')
  })

  test('launches claude with its default model for a codex todo', async () => {
    const { client } = await grilling('t', '', 'codex')
    expect(client.runInPaneCalls[0]?.command).toBe('claude --permission-mode acceptEdits')
  })

  test('wipes a leftover dir from an earlier aborted grill', async () => {
    const todo = todoRepo.create(db, { title: 't' })
    const dir = grillDirFor(grillRoot, todo.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'GRILLED.md'), '# stale\n')
    await startGrill(db, fakeClient(), todo.id, options())
    expect(existsSync(join(dir, 'GRILLED.md'))).toBe(false)
    expect(existsSync(join(dir, 'TODO.md'))).toBe(true)
  })

  test('throws NotFoundError for a missing todo', async () => {
    await expect(startGrill(db, fakeClient(), 999, options())).rejects.toThrow(NotFoundError)
  })

  test('rejects a done todo, a todo with a session and an already-grilling todo', async () => {
    const done = todoRepo.create(db, { title: 'done' })
    todoRepo.complete(db, done.id)
    await expect(startGrill(db, fakeClient(), done.id, options())).rejects.toThrow(ConflictError)

    const sessioned = todoRepo.create(db, { title: 's' })
    todoRepo.markDispatched(db, sessioned.id, { herdrWorkspaceId: 'w0', herdrTabId: 't0', herdrPaneId: 'p0' })
    todoRepo.updateSessionState(db, sessioned.id, 'idle')
    await expect(startGrill(db, fakeClient(), sessioned.id, options())).rejects.toThrow(ConflictError)

    const { todo, client } = await grilling()
    await expect(startGrill(db, client, todo.id, options())).rejects.toThrow(ConflictError)
    expect(client.createWorkspaceCalls).toHaveLength(1)
  })

  test('rolls back the session and removes the dir when claude fails to start', async () => {
    const todo = todoRepo.create(db, { title: 't' })
    const client = fakeClient()
    client.failRunInPane = true
    await expect(startGrill(db, client, todo.id, options())).rejects.toThrow('herdr pane run failed')

    expect(client.closeWorkspaceCalls).toEqual(['w1'])
    expect(existsSync(grillDirFor(grillRoot, todo.id))).toBe(false)
    const after = todoRepo.getById(db, todo.id)!
    expect(after.grillDir).toBeNull()
    expect(after.sessionState).toBeNull()
    expect(after.herdrWorkspaceId).toBeNull()
    expect(after.dispatchedAt).toBeNull()
  })

  test('is subject to the WIP limit', async () => {
    appSettingsRepo.set(db, WIP_LIMIT_ENABLED_KEY, '1')
    appSettingsRepo.set(db, WIP_LIMIT_KEY, '1')
    const busy = todoRepo.create(db, { title: 'busy' })
    todoRepo.markDispatched(db, busy.id, { herdrWorkspaceId: 'w0', herdrTabId: 't0', herdrPaneId: 'p0' })
    const todo = todoRepo.create(db, { title: 't' })
    const client = fakeClient()
    const err = await startGrill(db, client, todo.id, options()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).data?.code).toBe('wip_limit_reached')
    expect(client.createWorkspaceCalls).toEqual([])
    expect(existsSync(grillDirFor(grillRoot, todo.id))).toBe(false)
  })

  test('dispatchTodo refuses a grilling todo', async () => {
    const { todo, client } = await grilling()
    todoRepo.updateSessionState(db, todo.id, 'idle')
    todoRepo.update(db, todo.id, { workspacePath: '/tmp' })
    await expect(dispatchTodo(db, client, todo.id, { claudeBin: 'claude' })).rejects.toThrow(/Grill 中/)
  })
})

describe('finishGrill', () => {
  test('applies GRILLED.md, closes the workspace and clears the grill', async () => {
    const { todo, client, dir } = await grilling()
    writeFileSync(join(dir, 'GRILLED.md'), '# Fix the login timeout\n\n## やること\n- extend it\n')

    const finished = await finishGrill(db, client, todo.id, options())

    expect(finished.title).toBe('Fix the login timeout')
    expect(finished.description).toBe('## やること\n- extend it')
    expect(finished.grillDir).toBeNull()
    expect(finished.sessionState).toBeNull()
    expect(finished.herdrWorkspaceId).toBeNull()
    expect(finished.herdrPaneId).toBeNull()
    expect(finished.dispatchedAt).toBeNull()
    expect(client.closeWorkspaceCalls).toEqual(['w1'])
    expect(existsSync(dir)).toBe(false)
  })

  test('nudges a live session and picks up the file written in response', async () => {
    const { todo, client, dir } = await grilling()
    client.onSubmit = (text) => {
      if (text === GRILL_NUDGE_PROMPT) writeFileSync(join(dir, 'GRILLED.md'), '# New title\n\nBody\n')
    }
    const finished = await finishGrill(db, client, todo.id, options({ resultTimeoutMs: 1000 }))
    expect(finished.title).toBe('New title')
  })

  test('without a result and a live pane, nudges then returns grill_result_pending, keeping state', async () => {
    const { todo, client, dir } = await grilling()

    const err = await finishGrill(db, client, todo.id, options()).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).data?.code).toBe('grill_result_pending')
    expect((err as ConflictError).message).toContain('GRILLED.md')
    expect(client.submitPromptCalls.at(-1)).toEqual({ paneId: 'w1:p1', text: GRILL_NUDGE_PROMPT })
    const after = todoRepo.getById(db, todo.id)!
    expect(after.grillDir).toBe(dir)
    expect(after.sessionState).toBe('working')
    expect(existsSync(dir)).toBe(true)
    expect(client.closeWorkspaceCalls).toEqual([])
  })

  test('without a result and a dead pane, cancels the grill', async () => {
    const { todo, client, dir } = await grilling()
    client.paneAlive = false
    const sentBefore = client.submitPromptCalls.length

    const err = await finishGrill(db, client, todo.id, options()).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).data?.code).toBe('grill_cancelled')
    expect(client.submitPromptCalls).toHaveLength(sentBefore)
    const after = todoRepo.getById(db, todo.id)!
    expect(after.grillDir).toBeNull()
    expect(after.sessionState).toBeNull()
    expect(after.herdrPaneId).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  test('without a result, fails closed when herdr cannot be asked', async () => {
    const { todo, client, dir } = await grilling()
    client.snapshotError = new Error('herdr down')

    const err = await finishGrill(db, client, todo.id, options()).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).data?.code).toBe('session_unverified')
    expect(todoRepo.getById(db, todo.id)!.grillDir).toBe(dir)
    expect(existsSync(dir)).toBe(true)
  })

  test('a malformed GRILLED.md is a BadRequestError and keeps the grill', async () => {
    const { todo, client, dir } = await grilling()
    writeFileSync(join(dir, 'GRILLED.md'), 'no heading here\n')

    await expect(finishGrill(db, client, todo.id, options())).rejects.toThrow(BadRequestError)

    const after = todoRepo.getById(db, todo.id)!
    expect(after.title).toBe('Fix login')
    expect(after.grillDir).toBe(dir)
    expect(after.sessionState).toBe('working')
    expect(client.closeWorkspaceCalls).toEqual([])
  })

  test('rejects an unknown todo and one that is not grilling', async () => {
    await expect(finishGrill(db, fakeClient(), 999, options())).rejects.toThrow(NotFoundError)
    const todo = todoRepo.create(db, { title: 't' })
    await expect(finishGrill(db, fakeClient(), todo.id, options())).rejects.toThrow(ConflictError)
  })
})

describe('cleanupGrill', () => {
  test('never removes a stored path that is not <...>/grill/todo-<id>', () => {
    const todo = todoRepo.create(db, { title: 't' })
    const foreign = join(tmp, 'precious')
    mkdirSync(foreign)
    todoRepo.setGrillDir(db, todo.id, foreign)

    cleanupGrill(db, todo.id)

    expect(existsSync(foreign)).toBe(true)
    expect(todoRepo.getById(db, todo.id)!.grillDir).toBeNull()
  })
})
