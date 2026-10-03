import type { ExecFn } from './exec'

export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface HerdrPane {
  readonly paneId: string
  readonly tabId: string
  readonly workspaceId: string
  readonly agentStatus: HerdrAgentStatus
}

export interface HerdrSnapshot {
  readonly panes: HerdrPane[]
}

export interface CreateWorkspaceParams {
  readonly cwd: string
  readonly label: string
}

export interface CreatedWorkspace {
  readonly workspaceId: string
  readonly tabId: string
  readonly paneId: string
}

export interface HerdrClient {
  snapshot(): Promise<HerdrSnapshot>
  createWorkspace(params: CreateWorkspaceParams): Promise<CreatedWorkspace>
  // Starts a command line (text + Enter in one shot) — used to launch
  // claude. NOT used for delivering the task prompt to an already-running
  // TUI: see sendText/sendKeys for why that needs to be two steps.
  runInPane(paneId: string, command: string): Promise<void>
  // Types literal text into the pane with no trailing Enter.
  sendText(paneId: string, text: string): Promise<void>
  // Sends one or more key presses (e.g. 'Enter') with no text.
  sendKeys(paneId: string, ...keys: string[]): Promise<void>
  // Reads the pane's currently-visible text content — used to tell whether
  // a just-sent prompt is still sitting unsubmitted in the input box (see
  // dispatchService.ts's isPromptStillInInputBox).
  readPane(paneId: string): Promise<string>
  focusTab(tabId: string): Promise<void>
  closeWorkspace(workspaceId: string): Promise<void>
}

export interface HerdrClientOptions {
  readonly timeoutMs?: number
}

const DEFAULT_HERDR_TIMEOUT_MS = 10_000

// Raised for any failure talking to the herdr CLI itself (non-zero exit,
// unparseable output, or an {error} envelope) — distinct from application
// errors (NotFoundError/ConflictError/etc.) so the API layer can surface a
// specific "herdr failed" message instead of an opaque 500.
export class HerdrCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HerdrCommandError'
  }
}

interface HerdrEnvelope {
  readonly id?: string
  readonly result?: unknown
  readonly error?: { code: string; message: string }
}

// herdr's CLI has THREE success shapes depending on the command — not two.
// Each of the three helpers below encodes exactly one of them explicitly
// rather than sharing one lenient parser, so a command that unexpectedly
// returns the wrong shape still fails loudly instead of being silently
// misinterpreted (both bugs below were real incidents, not hypotheticals):
//  - "query" commands (api snapshot, workspace create) print a JSON envelope
//    with a `result` payload the caller needs. -> runHerdrJson
//  - "action" commands (pane run, tab focus, workspace close) print nothing
//    at all on success (empty stdout, exit 0) — there's no payload to
//    return. Treating empty stdout as a JSON-parse failure (an earlier bug)
//    misclassified every successful dispatch as an error, rolling back a
//    workspace that had just started correctly. -> runHerdrVoid
//  - "text" commands (pane read) print the raw requested content directly
//    to stdout, NOT a JSON envelope. (The underlying socket API's
//    PaneReadResult schema does have a `text` field, but the CLI wrapper
//    unwraps that envelope and prints only the field's content — so the
//    CLI-facing contract is the pane's literal text.) Assuming a JSON
//    envelope here (an earlier bug) made JSON.parse fail on real pane
//    content, breaking readPane against real herdr every time despite
//    fakes-only tests passing. -> runHerdrText

async function runHerdrJson(exec: ExecFn, args: string[], timeoutMs: number): Promise<unknown> {
  const { stdout, stderr, exitCode } = await exec(args, { timeoutMs })

  let envelope: HerdrEnvelope
  try {
    envelope = JSON.parse(stdout) as HerdrEnvelope
  } catch {
    throw new HerdrCommandError(
      `herdr command '${args.join(' ')}' returned non-JSON output (exit ${exitCode}): ${stdout || stderr}`
    )
  }

  if (envelope.error) {
    throw new HerdrCommandError(
      `herdr command '${args.join(' ')}' failed: [${envelope.error.code}] ${envelope.error.message}`
    )
  }

  return envelope.result
}

async function runHerdrVoid(exec: ExecFn, args: string[], timeoutMs: number): Promise<void> {
  const { stdout, stderr, exitCode } = await exec(args, { timeoutMs })

  if (stdout.trim().length === 0) {
    if (exitCode === 0) {
      return
    }
    throw new HerdrCommandError(
      `herdr command '${args.join(' ')}' failed (exit ${exitCode}): ${stderr}`
    )
  }

  // Some herdr versions/commands may still emit a JSON envelope for what is
  // normally a void command; if present, honor an {error} the same way the
  // JSON commands do rather than silently ignoring it.
  let envelope: HerdrEnvelope
  try {
    envelope = JSON.parse(stdout) as HerdrEnvelope
  } catch {
    throw new HerdrCommandError(
      `herdr command '${args.join(' ')}' returned unexpected non-JSON output (exit ${exitCode}): ${stdout}`
    )
  }
  if (envelope.error) {
    throw new HerdrCommandError(
      `herdr command '${args.join(' ')}' failed: [${envelope.error.code}] ${envelope.error.message}`
    )
  }
}

// Returns stdout AS-IS: this command's success payload is the pane's
// literal text content, not JSON, so it must never be run through
// JSON.parse. A non-zero exit is still an error. As a defensive fallback
// (herdr might report a validation failure via a JSON {error} envelope
// before it ever gets to printing pane content), stdout starting with `{`
// is tentatively parsed and treated as an error if it actually is one —
// but any parse failure, or valid JSON with no `error` key, falls through
// to being returned as literal text, which is the correct default for this
// command (real pane content could coincidentally start with `{` too).
async function runHerdrText(exec: ExecFn, args: string[], timeoutMs: number): Promise<string> {
  const { stdout, stderr, exitCode } = await exec(args, { timeoutMs })

  if (exitCode !== 0) {
    throw new HerdrCommandError(
      `herdr command '${args.join(' ')}' failed (exit ${exitCode}): ${stderr || stdout}`
    )
  }

  if (stdout.trimStart().startsWith('{')) {
    try {
      const envelope = JSON.parse(stdout) as HerdrEnvelope
      if (envelope.error) {
        throw new HerdrCommandError(
          `herdr command '${args.join(' ')}' failed: [${envelope.error.code}] ${envelope.error.message}`
        )
      }
    } catch (err) {
      if (err instanceof HerdrCommandError) {
        throw err
      }
      // Not actually a JSON error envelope — treat stdout as literal text.
    }
  }

  return stdout
}

interface RawPane {
  pane_id: string
  tab_id: string
  workspace_id: string
  agent_status: HerdrAgentStatus
}

interface RawSnapshotResult {
  snapshot: { panes: RawPane[] }
}

function parseSnapshot(result: unknown): HerdrSnapshot {
  const raw = result as RawSnapshotResult
  const panes = raw?.snapshot?.panes ?? []
  return {
    panes: panes.map((p) => ({
      paneId: p.pane_id,
      tabId: p.tab_id,
      workspaceId: p.workspace_id,
      agentStatus: p.agent_status,
    })),
  }
}

interface RawWorkspaceCreatedResult {
  workspace: { workspace_id: string }
  tab: { tab_id: string }
  root_pane: { pane_id: string }
}

function parseCreatedWorkspace(result: unknown): CreatedWorkspace {
  const raw = result as RawWorkspaceCreatedResult
  return {
    workspaceId: raw.workspace.workspace_id,
    tabId: raw.tab.tab_id,
    paneId: raw.root_pane.pane_id,
  }
}

export function createHerdrClient(
  exec: ExecFn,
  herdrBin: string,
  options: HerdrClientOptions = {}
): HerdrClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HERDR_TIMEOUT_MS

  return {
    async snapshot() {
      const result = await runHerdrJson(exec, [herdrBin, 'api', 'snapshot'], timeoutMs)
      return parseSnapshot(result)
    },

    async createWorkspace({ cwd, label }) {
      const result = await runHerdrJson(
        exec,
        [herdrBin, 'workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus'],
        timeoutMs
      )
      return parseCreatedWorkspace(result)
    },

    async runInPane(paneId, command) {
      await runHerdrVoid(exec, [herdrBin, 'pane', 'run', paneId, command], timeoutMs)
    },

    async sendText(paneId, text) {
      await runHerdrVoid(exec, [herdrBin, 'agent', 'send', paneId, text], timeoutMs)
    },

    async sendKeys(paneId, ...keys) {
      await runHerdrVoid(exec, [herdrBin, 'pane', 'send-keys', paneId, ...keys], timeoutMs)
    },

    async readPane(paneId) {
      return runHerdrText(exec, [herdrBin, 'pane', 'read', paneId, '--source', 'visible'], timeoutMs)
    },

    async focusTab(tabId) {
      await runHerdrVoid(exec, [herdrBin, 'tab', 'focus', tabId], timeoutMs)
    },

    async closeWorkspace(workspaceId) {
      await runHerdrVoid(exec, [herdrBin, 'workspace', 'close', workspaceId], timeoutMs)
    },
  }
}
