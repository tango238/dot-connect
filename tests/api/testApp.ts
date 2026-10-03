import { Hono } from 'hono'
import { createDatabase } from '../../src/db/database'
import type { ExecFn } from '../../src/herdr/exec'
import type { CreatedWorkspace, HerdrAgentStatus, HerdrClient, HerdrSnapshot } from '../../src/herdr/herdrClient'
import type { AppDependencies } from '../../src/api/dependencies'
import { createApiRoutes } from '../../src/api/routes'
import type { ClaudeRunner } from '../../src/services/claudeRunner'
import type { LlmAnalysis } from '../../src/types'

export interface FakeHerdrClient extends HerdrClient {
  readonly createWorkspaceCalls: unknown[]
  readonly runInPaneCalls: { paneId: string; command: string }[]
  readonly sendTextCalls: { paneId: string; text: string }[]
  readonly sendKeysCalls: { paneId: string; keys: string[] }[]
  readonly readPaneCalls: string[]
  readonly focusTabCalls: string[]
  readonly closeWorkspaceCalls: string[]
  nextWorkspace: CreatedWorkspace
  nextSnapshot: HerdrSnapshot
  snapshotError: Error | null
  // When true (default), snapshot() reports the dispatched pane as
  // 'working' once sendText has been called for it — simulating claude
  // picking up the delivered prompt — so a normal test dispatch confirms
  // delivery on the first attempt without exercising the retry path. Set
  // to false to test the "delivery never confirmed" path instead.
  autoConfirmDelivery: boolean
}

// Defaults to a snapshot already reporting the default workspace's pane as
// idle, so dispatch's post-`claude` readiness poll (see dispatchService.ts)
// succeeds immediately for tests that don't care about that path — override
// nextSnapshot to exercise the polling/timeout/rollback behavior instead.
function defaultSnapshotFor(workspace: CreatedWorkspace): HerdrSnapshot {
  return {
    panes: [
      {
        paneId: workspace.paneId,
        tabId: workspace.tabId,
        workspaceId: workspace.workspaceId,
        agentStatus: 'idle',
      },
    ],
  }
}

function withWorkingStatus(snapshot: HerdrSnapshot, paneId: string): HerdrSnapshot {
  return {
    panes: snapshot.panes.map((p) =>
      p.paneId === paneId ? { ...p, agentStatus: 'working' as HerdrAgentStatus } : p
    ),
  }
}

export function createFakeHerdrClient(): FakeHerdrClient {
  const createWorkspaceCalls: unknown[] = []
  const runInPaneCalls: { paneId: string; command: string }[] = []
  const sendTextCalls: { paneId: string; text: string }[] = []
  const sendKeysCalls: { paneId: string; keys: string[] }[] = []
  const readPaneCalls: string[] = []
  const focusTabCalls: string[] = []
  const closeWorkspaceCalls: string[] = []
  const nextWorkspace: CreatedWorkspace = { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1' }

  const client: FakeHerdrClient = {
    createWorkspaceCalls,
    runInPaneCalls,
    sendTextCalls,
    sendKeysCalls,
    readPaneCalls,
    focusTabCalls,
    closeWorkspaceCalls,
    nextWorkspace,
    nextSnapshot: defaultSnapshotFor(nextWorkspace),
    snapshotError: null,
    autoConfirmDelivery: true,
    async snapshot() {
      if (client.snapshotError) {
        throw client.snapshotError
      }
      const sentToPane = sendTextCalls.some((c) => c.paneId === client.nextWorkspace.paneId)
      if (client.autoConfirmDelivery && sentToPane) {
        return withWorkingStatus(client.nextSnapshot, client.nextWorkspace.paneId)
      }
      return client.nextSnapshot
    },
    async createWorkspace(params) {
      createWorkspaceCalls.push(params)
      return client.nextWorkspace
    },
    async runInPane(paneId, command) {
      runInPaneCalls.push({ paneId, command })
    },
    async sendText(paneId, text) {
      sendTextCalls.push({ paneId, text })
    },
    async sendKeys(paneId, ...keys) {
      sendKeysCalls.push({ paneId, keys })
    },
    async readPane(paneId) {
      readPaneCalls.push(paneId)
      // Echoes back the last text sent to this pane by default — i.e.
      // "still sitting there, unsubmitted" — matching this fake's existing
      // default of never confirming delivery on its own (autoConfirmDelivery
      // governs when snapshot() ever reports 'working').
      const lastSent = [...sendTextCalls].reverse().find((c) => c.paneId === paneId)
      return lastSent?.text ?? ''
    },
    async focusTab(tabId) {
      focusTabCalls.push(tabId)
    },
    async closeWorkspace(workspaceId) {
      closeWorkspaceCalls.push(workspaceId)
    },
  }

  return client
}

export function createFakeClaudeRunner(analysis: LlmAnalysis): ClaudeRunner {
  return {
    analyze: async () => analysis,
  }
}

// Test helper only: gives tests a typed, convenient way to read back the
// {success, data?, error?} JSON envelope emitted by every route.
export async function readJson<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

const DEFAULT_TEST_PORT = 5757
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE'])

export interface TestApp {
  request(input: string, init?: RequestInit): Promise<Response>
}

// The real app enforces CSRF checks (same-origin Origin required on mutating
// requests). Tests exercise route behavior, not CSRF itself (see
// tests/api/csrf.test.ts), so this wrapper injects a same-origin Origin
// header by default. Tests that want to exercise the CSRF path directly can
// still override Origin/Sec-Fetch-Site explicitly.
function withDefaultOrigin(app: Hono, port: number): TestApp {
  return {
    async request(input, init = {}) {
      const method = (init.method ?? 'GET').toUpperCase()
      const headers = new Headers(init.headers)
      if (MUTATING_METHODS.has(method) && !headers.has('origin') && !headers.has('sec-fetch-site')) {
        headers.set('origin', `http://localhost:${port}`)
      }
      return app.request(input, { ...init, headers })
    },
  }
}

export interface TestAppContext {
  readonly app: TestApp
  readonly deps: AppDependencies
}

export interface RawTestAppContext {
  readonly app: Hono
  readonly deps: AppDependencies
}

// The un-wrapped app, for the few tests whose subject IS the request headers
// (e.g. the MCP client's Origin — see mcpClientIntegration.test.ts):
// withDefaultOrigin would silently supply the very header under test.
export function createRawTestApp(overrides: Partial<AppDependencies> = {}): RawTestAppContext {
  const db = createDatabase(':memory:')
  const herdr = createFakeHerdrClient()
  const exec: ExecFn = async () => ({ stdout: '', stderr: '', exitCode: 0 })
  const claudeRunner = createFakeClaudeRunner({ summary: 's', warnings: [], suggestions: [] })

  const deps: AppDependencies = {
    db,
    dbPath: ':memory:',
    herdr,
    claudeRunner,
    exec,
    platform: 'darwin',
    herdrBin: 'herdr',
    claudeBin: 'claude',
    codexBin: 'codex',
    ghBin: 'gh',
    terminalApp: null,
    port: DEFAULT_TEST_PORT,
    apiToken: null,
    isLoopback: true,
    allowedModels: ['opus', 'sonnet', 'haiku', 'fable', 'codex'],
    mcpBinPath: null,
    capabilities: async () => ({ dispatch: true, sessionFocus: true, mcpBinPath: null }),
    dispatchAgentReadyTimeoutMs: 100,
    dispatchPollIntervalMs: 1,
    dispatchSleep: async () => undefined,
    dispatchSettleMs: 0,
    dispatchKeystrokeDelayBaseMs: 0,
    dispatchKeystrokeDelayPerCharMs: 0,
    dispatchKeystrokeDelayMaxMs: 0,
    dispatchDeliveryConfirmTimeoutMs: 100,
    ...overrides,
  }

  const app = new Hono()
  app.route('/api', createApiRoutes(deps))

  return { app, deps }
}

export function createTestApp(overrides: Partial<AppDependencies> = {}): TestAppContext {
  const { app, deps } = createRawTestApp(overrides)
  return { app: withDefaultOrigin(app, deps.port), deps }
}
