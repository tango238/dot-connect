import type { Database } from 'bun:sqlite'
import { assertPromptTextSupported } from '../herdr/promptArgs'
import { ExecTimeoutError } from '../herdr/exec'
import * as dispatchEventRepo from '../db/dispatchEventRepo'
import * as promptHistoryRepo from '../db/promptHistoryRepo'
import * as workspacePathHistoryRepo from '../db/workspacePathHistoryRepo'
import * as todoRepo from '../db/todoRepo'
import type { CreatedWorkspace, HerdrAgentStatus, HerdrClient } from '../herdr/herdrClient'
import { logger } from '../logger'
import type { Todo } from '../types'
import { BadRequestError, ConflictError, NotFoundError } from './errors'
import { herdrWorkspaceLabel } from './herdrWorkspaceLabel'
import { assertAllowedModel, CODEX_MODEL, DEFAULT_ALLOWED_MODELS } from './modelValidation'

const DEFAULT_AGENT_READY_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 500
// agent_status === 'idle' means herdr has detected the claude process, not
// that its TUI can accept input yet (it may still be showing a splash
// screen). Without this extra wait, text sent immediately after idle is
// detected gets swallowed by the still-initializing TUI.
const DEFAULT_SETTLE_MS = 1500
const DEFAULT_DELIVERY_CONFIRM_TIMEOUT_MS = 10_000

export interface DispatchOptions {
  readonly claudeBin: string
  /** Launched instead of claudeBin when the resolved model is "codex".
   * Defaults to 'codex'. */
  readonly codexBin?: string
  readonly agentReadyTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  /** Custom task text to send instead of the todo's title. Recorded to
   * prompt_history once the dispatch fully succeeds (never on rollback). */
  readonly promptBody?: string
  /** Overrides the todo's stored workspacePath for this dispatch, and
   * persists the override onto the todo (so it becomes the default for the
   * next dispatch too). Omit to use the todo's already-stored path. */
  readonly workspacePath?: string
  /** Overrides the todo's stored model for this dispatch, and persists the
   * override onto the todo (same convention as workspacePath above). Omit
   * to use the todo's already-stored model (null means claude's default —
   * no --model flag). Validated against allowedModels before use. */
  readonly model?: string
  /** Claude Code model aliases this dispatch may launch with — see
   * modelValidation.ts. Defaults to DEFAULT_ALLOWED_MODELS; callers should
   * normally pass the server's configured (and possibly
   * DOT_CONNECT_ALLOWED_MODELS-extended) list instead of relying on that
   * default. */
  readonly allowedModels?: readonly string[]
  /** Extra wait after agent_status becomes 'idle', before typing anything. */
  readonly settleMs?: number
  /** How long to poll for delivery confirmation (see isDeliveryConfirmed)
   * after sending, before giving up on confirming delivery. */
  readonly deliveryConfirmTimeoutMs?: number
}

/** A dispatched Todo, plus whether the task prompt was confirmed delivered
 * to the claude TUI. `false` does not mean the dispatch failed — claude is
 * running and the workspace is usable — only that we could not confirm it
 * picked up the prompt. Callers (the API layer) should
 * surface this to the user as a "please check the session" warning. */
export interface DispatchResult extends Todo {
  readonly promptDelivered: boolean
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g
// Generous but finite: a custom prompt can reference {{title}}/
// {{description}} many times, so the *expanded* result — not just the
// template — needs its own cap independent of title/description's own
// (much smaller) length limits, or a pathological template could still
// amplify into a huge `submitPrompt` argument.
const MAX_TASK_PROMPT_LENGTH = 8000

// Single-pass substitution: String.replace scans the ORIGINAL template once
// and inserts each match's replacement verbatim into the output — it never
// re-scans a replacement's own text for further matches. That matters for
// symmetry: {{description}} appearing literally inside the title (or
// {{title}} inside the description) must not get a second, unintended
// substitution. A lookup + replacer function (not a replacement string) also
// means a literal "$1"/"$&" etc. in the title/description can't be
// misinterpreted as a String.replace pattern. Unknown {{keys}} are left as-is
// — checked via hasOwnProperty rather than `lookup[key] ?? match`, since the
// latter also resolves Object.prototype-inherited keys like {{constructor}}/
// {{toString}}/{{__proto__}} to native function/object source text.
function substitutePlaceholders(template: string, todo: Todo): string {
  const lookup: Record<string, string> = { title: todo.title, description: todo.description }
  return template.replace(PLACEHOLDER_PATTERN, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(lookup, key) ? lookup[key]! : match
  )
}

function buildTaskPrompt(todo: Todo, promptBody?: string): string {
  // A custom prompt gets {{title}}/{{description}} substitution; a
  // title-only dispatch has nothing to substitute into.
  const rawBody = promptBody !== undefined ? substitutePlaceholders(promptBody, todo) : todo.title
  const prompt = rawBody
  if (prompt.length > MAX_TASK_PROMPT_LENGTH) {
    throw new BadRequestError('プロンプトが長すぎます')
  }
  assertPromptTextSupported(prompt)
  return prompt
}

function ensureDispatchable(todo: Todo | null, todoId: number): Todo {
  if (todo === null) {
    throw new NotFoundError(`Todo ${todoId} not found`)
  }
  if (todo.sessionState === 'working') {
    throw new ConflictError(`Todo ${todoId} is already dispatched and running`)
  }
  return todo
}

// A dispatch-time workspacePath override takes priority over whatever is
// already stored on the todo, so a todo can be created without one and get
// its workspace assigned only when actually dispatched. Neither present is
// still the same hard failure as before.
function resolveWorkspacePath(todo: Todo, override: string | undefined): string {
  const path = override ?? todo.workspacePath
  if (path === null || path === undefined) {
    throw new BadRequestError('workspacePath を設定してください')
  }
  return path
}

// herdr's own `agent wait`/`wait agent-status` CLI fails immediately with
// agent_not_found right after starting claude (herdr hasn't detected/attached
// the agent yet), so it can't be used to wait for readiness here. Instead,
// poll `herdr.snapshot()` directly until the pane's agentStatus is 'idle'.
async function waitForAgentIdle(
  herdr: HerdrClient,
  paneId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
  agentName: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await herdr.snapshot()
    const pane = snapshot.panes.find((p) => p.paneId === paneId)
    if (pane?.agentStatus === 'idle') {
      return
    }
    if (Date.now() >= deadline) {
      throw new ConflictError(`${agentName} の起動を確認できませんでした`)
    }
    await sleep(pollIntervalMs)
  }
}

// 'working' means claude started processing the prompt — the clearest
// signal it was received. 'blocked' (a permission dialog) and 'done' (a
// short task that finished inside the poll window) can *only* be reached
// after the pane received the prompt too, so both also count as delivered
// (F48: treating them as "not confirmed" made deliverTaskPrompt retype the
// prompt into an open permission dialog, or dispatch the same task twice).
function isDeliveryConfirmed(status: HerdrAgentStatus | undefined): boolean {
  return status === 'working' || status === 'blocked' || status === 'done'
}

// Polls snapshot() for a status that answers "did claude receive the
// prompt?" — returning as soon as that's confirmed (see
// isDeliveryConfirmed) or the timeout elapses, whichever comes first.
// Unlike waitForAgentIdle, timing out here is not a hard failure (claude is
// running either way). An uncertain result never triggers another submission.
async function pollAgentStatus(
  herdr: HerdrClient,
  paneId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<HerdrAgentStatus | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await herdr.snapshot()
    const status = snapshot.panes.find((p) => p.paneId === paneId)?.agentStatus
    if (isDeliveryConfirmed(status) || Date.now() >= deadline) {
      return status
    }
    await sleep(pollIntervalMs)
  }
}

// Herdr owns paste + submission. Never retype or send an extra Enter: a
// delayed status update or pane echo cannot prove submission did not happen.
async function deliverTaskPrompt(
  herdr: HerdrClient,
  paneId: string,
  taskPrompt: string,
  todoId: number,
  options: DispatchOptions
): Promise<boolean> {
  try {
    await herdr.submitPrompt(paneId, taskPrompt)
  } catch (err) {
    // A killed client may already have handed the request to Herdr. Keep the
    // session for inspection instead of inviting a duplicate manual dispatch.
    if (!(err instanceof ExecTimeoutError)) throw err
    logger.warn('Prompt submission timed out; check the session before retrying', { todoId, paneId })
    return false
  }
  try {
    const status = await pollAgentStatus(
      herdr, paneId,
      options.deliveryConfirmTimeoutMs ?? DEFAULT_DELIVERY_CONFIRM_TIMEOUT_MS,
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      options.sleep ?? defaultSleep
    )
    if (isDeliveryConfirmed(status)) return true
  } catch (err) {
    logger.warn('Could not confirm submitted prompt', { todoId, paneId, message: String(err) })
  }
  logger.warn('Prompt delivery unconfirmed; check the session before retrying', { todoId, paneId })
  return false
}

async function startClaudeAndSendTask(
  herdr: HerdrClient,
  workspace: CreatedWorkspace,
  taskPrompt: string,
  todoId: number,
  model: string | null,
  options: DispatchOptions
): Promise<boolean> {
  const command = buildAgentCommand(options, model)
  logger.info('Starting agent in pane', {
    todoId,
    workspaceId: workspace.workspaceId,
    paneId: workspace.paneId,
    command,
  })
  await herdr.runInPane(workspace.paneId, command)

  logger.info('Waiting for the agent to become idle', { todoId, paneId: workspace.paneId })
  await waitForAgentIdle(
    herdr,
    workspace.paneId,
    options.agentReadyTimeoutMs ?? DEFAULT_AGENT_READY_TIMEOUT_MS,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    options.sleep ?? defaultSleep,
    model === CODEX_MODEL ? 'Codex' : 'Claude Code'
  )

  // idle is necessary but not sufficient: the TUI may still be initializing
  // and unable to accept input the instant herdr detects the agent.
  await (options.sleep ?? defaultSleep)(options.settleMs ?? DEFAULT_SETTLE_MS)

  return deliverTaskPrompt(herdr, workspace.paneId, taskPrompt, todoId, options)
}

// Best-effort: closes the herdr workspace we just created and clears the
// todo's dispatch info so a failed dispatch doesn't leave the DB pointing at
// an orphaned (or now-closed) workspace.
async function rollbackDispatch(
  db: Database,
  herdr: HerdrClient,
  todoId: number,
  workspaceId: string,
  cause: unknown
): Promise<void> {
  logger.warn('Rolling back dispatch after failure', {
    todoId,
    workspaceId,
    message: cause instanceof Error ? cause.message : String(cause),
  })
  try {
    await herdr.closeWorkspace(workspaceId)
  } catch (closeErr) {
    logger.error('Failed to roll back herdr workspace after a failed dispatch', {
      todoId,
      workspaceId,
      message: closeErr instanceof Error ? closeErr.message : String(closeErr),
    })
  }
  todoRepo.clearDispatch(db, todoId)
}

async function createLoggedWorkspace(
  herdr: HerdrClient,
  todo: Todo,
  cwd: string
): Promise<CreatedWorkspace> {
  const todoId = todo.id
  const label = herdrWorkspaceLabel(todo)
  logger.info('Creating herdr workspace for dispatch', { todoId, label, cwd })
  const workspace = await herdr.createWorkspace({ cwd, label })
  logger.info('Created herdr workspace', {
    todoId,
    workspaceId: workspace.workspaceId,
    tabId: workspace.tabId,
    paneId: workspace.paneId,
  })
  return workspace
}

// Resolved (and, if the caller passed an override, persisted) before any
// herdr call. Persisting happens even though a later step (prompt length,
// workspace creation, claude startup) might still fail: the user-supplied
// path is deliberately NOT rolled back on failure — it becomes the default
// for the next dispatch attempt regardless of how this one goes.
function resolveAndPersistWorkspacePath(db: Database, todo: Todo, todoId: number, override?: string): string {
  const workspacePath = resolveWorkspacePath(todo, override)
  if (override !== undefined) {
    todoRepo.update(db, todoId, { workspacePath: override })
  }
  return workspacePath
}

// Same override-and-persist shape as resolveAndPersistWorkspacePath, but
// unlike a workspace path, no model at all (null) is a valid, common case —
// it just means "launch claude with its own default model", so there is no
// resolveModel equivalent that throws on "neither present". The allowlist
// check runs on the EFFECTIVE value (override, or whatever was already
// stored on the todo) rather than only on a fresh override: a todo's stored
// model could otherwise predate a since-narrowed DOT_CONNECT_ALLOWED_MODELS
// and reach buildAgentCommand unvalidated.
function resolveAndPersistModel(
  db: Database,
  todo: Todo,
  todoId: number,
  override: string | undefined,
  allowedModels: readonly string[]
): string | null {
  const model = override ?? todo.model
  if (model !== null) {
    assertAllowedModel(model, allowedModels)
  }
  if (override !== undefined) {
    todoRepo.update(db, todoId, { model: override })
  }
  return model
}

// Model values only ever reach here after assertAllowedModel has checked
// them against the configured allowlist (see resolveAndPersistModel) — and
// every entry in that allowlist is itself shape-checked as a plain
// identifier by modelValidation.ts's ALLOWED_MODEL_ENTRY_PATTERN (F1: an
// allowlist entry sourced from DOT_CONNECT_ALLOWED_MODELS is operator config,
// not compiled-in, so it needs that check too — an exact-match allowlist
// hit alone doesn't rule out metacharacters if the list itself could contain
// them). That combination is what makes it safe to interpolate a model value
// directly into a command line that herdr types into a live terminal pane
// (runInPane; see HerdrClient's own doc comment on why that command text is
// NOT shell-argv-safe the way exec()'s array arguments are).
// CODEX_MODEL is the one exception to "model becomes --model": it swaps the
// binary itself, launching Codex with its own configured default model.
function buildAgentCommand(options: DispatchOptions, model: string | null): string {
  if (model === CODEX_MODEL) {
    return options.codexBin ?? CODEX_MODEL
  }
  return model === null ? options.claudeBin : `${options.claudeBin} --model ${model}`
}

async function dispatchTodoOnce(
  db: Database,
  herdr: HerdrClient,
  todoId: number,
  options: DispatchOptions
): Promise<DispatchResult> {
  const todo = ensureDispatchable(todoRepo.getById(db, todoId), todoId)
  const workspacePath = resolveAndPersistWorkspacePath(db, todo, todoId, options.workspacePath)
  const model = resolveAndPersistModel(
    db,
    todo,
    todoId,
    options.model,
    options.allowedModels ?? DEFAULT_ALLOWED_MODELS
  )

  // Built (and length-validated) before any herdr call: an oversized
  // placeholder expansion must fail loudly with no workspace ever created,
  // not after one's already been spun up.
  const taskPrompt = buildTaskPrompt(todo, options.promptBody)

  await herdr.assertDispatchCompatible?.()
  const workspace = await createLoggedWorkspace(herdr, todo, workspacePath)

  // Record the new session immediately: if a later step fails we can both
  // detect (session_state) and roll back (herdrWorkspaceId) the workspace we
  // just created, instead of silently orphaning it.
  todoRepo.markDispatched(db, todoId, {
    herdrWorkspaceId: workspace.workspaceId,
    herdrTabId: workspace.tabId,
    herdrPaneId: workspace.paneId,
  })

  // A thrown error here (workspace creation already succeeded, but claude
  // failed to start, or never reached idle) still rolls back: the
  // workspace/pane is unusable. Delivery merely being unconfirmed after a
  // submission is NOT thrown — see deliverTaskPrompt — because claude itself is
  // running fine and rolling back would just discard a usable session.
  let promptDelivered: boolean
  try {
    promptDelivered = await startClaudeAndSendTask(herdr, workspace, taskPrompt, todoId, model, options)
  } catch (err) {
    await rollbackDispatch(db, herdr, todoId, workspace.workspaceId, err)
    throw err
  }

  dispatchEventRepo.recordDispatch(db, todoId)
  if (options.promptBody !== undefined) {
    promptHistoryRepo.recordUse(db, options.promptBody)
  }
  // Recorded here, on the success path only, for the same reason the prompt
  // is: this is a path herdr actually ran in, not merely one that was typed
  // into a form. workspacePath is already resolved (override applied) and
  // guaranteed non-empty by resolveWorkspacePath above.
  workspacePathHistoryRepo.recordUse(db, workspacePath)

  const dispatched = todoRepo.getById(db, todoId)
  if (!dispatched) {
    throw new Error(`Failed to load todo ${todoId} after dispatch`)
  }
  return { ...dispatched, promptDelivered }
}

// Serialize each TODO before the first await (workspace creation). The stored
// working state alone cannot reject two requests racing to create a workspace.
const inFlightDispatches = new WeakMap<Database, Set<number>>()

export async function dispatchTodo(
  db: Database, herdr: HerdrClient, todoId: number, options: DispatchOptions
): Promise<DispatchResult> {
  let pending = inFlightDispatches.get(db)
  if (!pending) {
    pending = new Set<number>()
    inFlightDispatches.set(db, pending)
  }
  if (pending.has(todoId)) throw new ConflictError(`Todo ${todoId} dispatch is already in progress`)
  pending.add(todoId)
  try {
    return await dispatchTodoOnce(db, herdr, todoId, options)
  } finally {
    pending.delete(todoId)
  }
}
