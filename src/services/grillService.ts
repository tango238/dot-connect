// Grill: TODO を herdr 上の Claude Code セッションとの対話で詰める。
//
// dot-connect が持つ一時ディレクトリ(<db dir>/grill/todo-<id>)に TODO.md と
// 手順書 GRILL.md を置き、そこを cwd にした herdr セッションで claude を起動する。
// インタビューが終わるとセッション側が GRILLED.md を書き、ユーザーが Grilled を
// 押すとそれを TODO のタイトル・詳細に反映して、セッションとディレクトリを畳む。
//
// Grill のセッションは todo の herdr セッションそのものとして記録する
// (markDispatched)。「セッションを開く」・statusSync・WIP の数え方・削除時の
// ガードがそのまま効くようにするため。一方で作業そのものではないので、
// dispatch_events / prompt_history / workspace_path_history には残さない。

import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import * as todoRepo from '../db/todoRepo'
import { ExecTimeoutError } from '../herdr/exec'
import type { HerdrClient } from '../herdr/herdrClient'
import { assertPromptTextSupported } from '../herdr/promptArgs'
import { logger } from '../logger'
import type { Todo } from '../types'
import {
  type AgentLaunchOptions,
  createLoggedWorkspace,
  defaultSleep,
  launchAgentSession,
  rollbackDispatch,
  withDispatchSlot,
} from './dispatchService'
import { BadRequestError, ConflictError, NotFoundError } from './errors'
import grillInstructions from './grillInstructions.md' with { type: 'text' }
import { parseGrilledResult } from './grillResult'
import { herdrWorkspaceLabel } from './herdrWorkspaceLabel'
import { assertAllowedModel, CODEX_MODEL, DEFAULT_ALLOWED_MODELS } from './modelValidation'

export const GRILL_DIR_NAME = 'grill'
export const GRILL_RESULT_FILE = 'GRILLED.md'
const DEFAULT_RESULT_TIMEOUT_MS = 90_000
const DEFAULT_POLL_INTERVAL_MS = 500

export const GRILL_START_PROMPT =
  'このディレクトリの GRILL.md を読み、その手順に従って TODO.md の内容を grill してください。'
export const GRILL_NUDGE_PROMPT =
  'いま GRILLED.md を書いてください。形式は GRILL.md の「終わり方」のとおりです。ここまでに合意できた内容で最善の版を書き、まだ決まっていない問いは「## 注意点」に未決として挙げてください。'

export interface GrillOptions extends AgentLaunchOptions {
  readonly claudeBin: string
  readonly allowedModels?: readonly string[]
  readonly grillRoot: string
  /** Grilled 押下時に GRILLED.md が無ければ、催促してからこの時間だけ待つ。 */
  readonly resultTimeoutMs?: number
}

// 添付の既定フォルダ(uploadDirLocation.ts)と同じく DB ファイルの隣。
// :memory: の DB(テスト・一時起動)には隣が無いので、プロセスごとの tmp に置く。
export function grillRootFor(dbPath: string): string {
  if (dbPath === ':memory:' || dbPath === '') {
    return join(tmpdir(), `dot-connect-${process.pid}`, GRILL_DIR_NAME)
  }
  return join(dirname(dbPath), GRILL_DIR_NAME)
}

export function grillDirFor(grillRoot: string, todoId: number): string {
  return join(grillRoot, `todo-${todoId}`)
}

// rm -rf する前の形の確認。DB に入っている値をそのまま消すので、
// <何か>/grill/todo-<id> の形をしていないものは決して消さない。
function isOwnedGrillDir(dir: string, todoId: number): boolean {
  return isAbsolute(dir) && basename(dir) === `todo-${todoId}` && basename(dirname(dir)) === GRILL_DIR_NAME
}

function removeGrillDir(dir: string, todoId: number): void {
  if (!isOwnedGrillDir(dir, todoId)) {
    logger.warn('Refusing to remove an unexpected grill directory', { todoId, dir })
    return
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    logger.warn('Failed to remove grill directory', {
      todoId,
      dir,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Grill の一時ディレクトリを消し、grill_dir を NULL に戻す。Grill 中でなければ何もしない。 */
export function cleanupGrill(db: Database, todoId: number): void {
  const todo = todoRepo.getById(db, todoId)
  if (todo === null || todo.grillDir === null) {
    return
  }
  removeGrillDir(todo.grillDir, todoId)
  todoRepo.setGrillDir(db, todoId, null)
}

function ensureGrillable(todo: Todo | null, todoId: number): Todo {
  if (todo === null) {
    throw new NotFoundError(`Todo ${todoId} not found`)
  }
  if (todo.status === 'done') {
    throw new ConflictError('完了済みのTODOは Grill できません')
  }
  if (todo.grillDir !== null) {
    throw new ConflictError('このTODOは既に Grill 中です')
  }
  if (todo.sessionState !== null) {
    throw new ConflictError('herdrセッションが残っているため Grill できません。先にセッションを終了してください')
  }
  return todo
}

// Grill は常に Claude Code で行う。codex の TODO でも claude を既定モデルで
// 起動するだけ。許可リストから外れたモデルも(dispatch のように弾くのではなく)
// 既定モデルに倒す —— Grill は TODO の中身を詰めるだけで、モデル指定は本番の
// 投入のためのものだから。--permission-mode acceptEdits は cwd が dot-connect の
// 一時ディレクトリなので安全で、GRILLED.md の書き込みで確認を挟まずに済む。
export function buildGrillCommand(
  claudeBin: string,
  model: string | null,
  allowedModels: readonly string[]
): string {
  let modelFlag = ''
  if (model !== null && model !== CODEX_MODEL) {
    try {
      assertAllowedModel(model, allowedModels)
      modelFlag = ` --model ${model}`
    } catch {
      logger.warn('Ignoring a disallowed model for grill', { model })
    }
  }
  return `${claudeBin}${modelFlag} --permission-mode acceptEdits`
}

function todoMarkdown(todo: Todo): string {
  return `# ${todo.title}\n\n${todo.description}\n`
}

// 以前の Grill が途中で落ちて残ったディレクトリは、消してから作り直す。
function prepareGrillDir(dir: string, todo: Todo): void {
  if (existsSync(dir)) {
    removeGrillDir(dir, todo.id)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'TODO.md'), todoMarkdown(todo))
  writeFileSync(join(dir, 'GRILL.md'), grillInstructions)
}

export interface GrillStartResult extends Todo {
  readonly promptDelivered: boolean
}

async function startGrillOnce(
  db: Database,
  herdr: HerdrClient,
  todo: Todo,
  options: GrillOptions
): Promise<GrillStartResult> {
  const todoId = todo.id
  const command = buildGrillCommand(
    options.claudeBin,
    todo.model,
    options.allowedModels ?? DEFAULT_ALLOWED_MODELS
  )
  assertPromptTextSupported(GRILL_START_PROMPT)
  await herdr.assertDispatchCompatible?.()

  const dir = grillDirFor(options.grillRoot, todoId)
  if (!isOwnedGrillDir(dir, todoId)) {
    throw new Error(`Unexpected grill directory: ${dir}`)
  }
  prepareGrillDir(dir, todo)

  let workspaceId: string | null = null
  try {
    const workspace = await createLoggedWorkspace(
      herdr,
      todoId,
      herdrWorkspaceLabel({ id: todoId, title: `Grill ${todo.title}` }),
      dir
    )
    workspaceId = workspace.workspaceId
    todoRepo.markDispatched(db, todoId, {
      herdrWorkspaceId: workspace.workspaceId,
      herdrTabId: workspace.tabId,
      herdrPaneId: workspace.paneId,
    })
    todoRepo.setGrillDir(db, todoId, dir)

    const promptDelivered = await launchAgentSession(
      herdr,
      workspace,
      command,
      'Claude Code',
      GRILL_START_PROMPT,
      todoId,
      options
    )
    const started = todoRepo.getById(db, todoId)
    if (!started) {
      throw new Error(`Failed to load todo ${todoId} after starting grill`)
    }
    return { ...started, promptDelivered }
  } catch (err) {
    if (workspaceId !== null) {
      await rollbackDispatch(db, herdr, todoId, workspaceId, err)
    }
    removeGrillDir(dir, todoId)
    todoRepo.setGrillDir(db, todoId, null)
    throw err
  }
}

export async function startGrill(
  db: Database,
  herdr: HerdrClient,
  todoId: number,
  options: GrillOptions
): Promise<GrillStartResult> {
  // 確認から枠の確保まで await を挟まないので、並行した要求に割り込まれない。
  const todo = ensureGrillable(todoRepo.getById(db, todoId), todoId)
  return withDispatchSlot(db, todoId, () => startGrillOnce(db, herdr, todo, options))
}

// --- Grilled -------------------------------------------------------------

const inFlightFinishes = new WeakMap<Database, Set<number>>()

function readResult(dir: string): string | null {
  const path = join(dir, GRILL_RESULT_FILE)
  if (!existsSync(path)) {
    return null
  }
  return readFileSync(path, 'utf8')
}

// pane がまだ herdr にあるか。聞けなければ undefined(呼び出し側は fail closed)。
async function paneAlive(herdr: HerdrClient, paneId: string | null, todoId: number): Promise<boolean | undefined> {
  if (paneId === null) {
    return false
  }
  try {
    const snapshot = await herdr.snapshot()
    return snapshot.panes.some((pane) => pane.paneId === paneId)
  } catch (err) {
    logger.warn('Could not check the herdr pane of a grilling todo', {
      todoId,
      paneId,
      message: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

async function closeGrillSession(db: Database, herdr: HerdrClient, todo: Todo): Promise<void> {
  if (todo.herdrWorkspaceId !== null) {
    try {
      await herdr.closeWorkspace(todo.herdrWorkspaceId)
    } catch (err) {
      // 反映自体は済んでいるので失敗にはしない。残ったワークスペースは
      // dot-connect の管理から外れるので、ユーザーが herdr 側で閉じる。
      logger.warn('Failed to close the herdr workspace of a finished grill', {
        todoId: todo.id,
        workspaceId: todo.herdrWorkspaceId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // Grill は作業の投入ではないので dispatched_at も残さず「未投入」に戻す。
  // Grill 中は dispatch が弾かれる(ensureDispatchable)ので、ここで別の
  // 投入の紐付けを消してしまうことはない。
  todoRepo.clearDispatch(db, todo.id)
}

// 結果が無いまま終わったセッションの後始末。
function cancelGrill(db: Database, todoId: number): void {
  todoRepo.clearDispatch(db, todoId)
  cleanupGrill(db, todoId)
}

async function waitForResult(
  herdr: HerdrClient,
  todo: Todo,
  dir: string,
  options: GrillOptions
): Promise<string | null> {
  const paneId = todo.herdrPaneId!
  try {
    await herdr.submitPrompt(paneId, GRILL_NUDGE_PROMPT)
  } catch (err) {
    // 届いたかどうか分からないだけで、待つ価値はある。
    if (!(err instanceof ExecTimeoutError)) throw err
    logger.warn('Grill nudge submission timed out', { todoId: todo.id, paneId })
  }
  const sleep = options.sleep ?? defaultSleep
  const deadline = Date.now() + (options.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS)
  for (;;) {
    const text = readResult(dir)
    if (text !== null || Date.now() >= deadline) {
      return text
    }
    await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  }
}

async function finishGrillOnce(
  db: Database,
  herdr: HerdrClient,
  todoId: number,
  options: GrillOptions
): Promise<Todo> {
  const todo = todoRepo.getById(db, todoId)
  if (todo === null) {
    throw new NotFoundError(`Todo ${todoId} not found`)
  }
  const dir = todo.grillDir
  if (dir === null) {
    throw new ConflictError('このTODOは Grill 中ではありません', { code: 'not_grilling' })
  }

  let text = readResult(dir)
  if (text === null) {
    const alive = await paneAlive(herdr, todo.herdrPaneId, todoId)
    if (alive === undefined) {
      throw new ConflictError(
        'herdrセッションの状態を確認できません。herdr を起動してから再度 Grilled を押してください',
        { code: 'session_unverified' }
      )
    }
    if (!alive) {
      cancelGrill(db, todoId)
      throw new ConflictError(
        'Grill のセッションが結果(GRILLED.md)を書かずに終了していたため、Grill を取り消しました',
        { code: 'grill_cancelled' }
      )
    }
    text = await waitForResult(herdr, todo, dir, options)
    if (text === null) {
      throw new ConflictError(
        'まだ結果(GRILLED.md)が書かれていません。セッションでインタビューを終えて GRILLED.md を書いてもらってから、もう一度 Grilled を押してください',
        { code: 'grill_result_pending' }
      )
    }
  }

  // 壊れていれば BadRequestError。Grill の状態は残すので、セッションで直してもらえる。
  const result = parseGrilledResult(text)
  todoRepo.update(db, todoId, { title: result.title, description: result.description })
  await closeGrillSession(db, herdr, todo)
  cleanupGrill(db, todoId)

  const finished = todoRepo.getById(db, todoId)
  if (!finished) {
    throw new Error(`Failed to load todo ${todoId} after finishing grill`)
  }
  return finished
}

export async function finishGrill(
  db: Database,
  herdr: HerdrClient,
  todoId: number,
  options: GrillOptions
): Promise<Todo> {
  let pending = inFlightFinishes.get(db)
  if (!pending) {
    pending = new Set<number>()
    inFlightFinishes.set(db, pending)
  }
  if (pending.has(todoId)) {
    throw new ConflictError('Grilled の処理が既に進行中です', { code: 'grill_finish_in_progress' })
  }
  pending.add(todoId)
  try {
    return await finishGrillOnce(db, herdr, todoId, options)
  } catch (err) {
    if (err instanceof BadRequestError) {
      logger.warn('GRILLED.md could not be parsed', { todoId, message: err.message })
    }
    throw err
  } finally {
    pending.delete(todoId)
  }
}
