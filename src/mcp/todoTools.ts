import { z } from 'zod'
import type { DotConnectClient } from './dotConnectClient'
import { runTool } from './toolResult'

export const listTodosShape = {
  status: z.enum(['open', 'done']).optional().describe('open か done で絞り込む(省略時は全件)'),
  milestoneId: z.number().int().positive().optional().describe('このマイルストーンIDに紐づくTODOだけに絞り込む'),
}

// herdr投入(dispatch)自体はMCP経由で実行できない(意図的に非公開。README参照)
// が、投入時に必須になるworkspacePathの値はMCP経由で作成/更新したTODOにも
// 引き継がれる。ここで設定しておかないと、後で(dot-connectのWeb UIから)
// 投入しようとした際にワークスペース未設定エラーになるため、その旨を明記する。
const WORKSPACE_PATH_DESCRIPTION =
  'TODOをherdrに投入して実行する際の作業ディレクトリ(絶対パス)。作成/更新時点では任意だが、実際に投入(dispatch)する際には必須になる。ここで設定しておくと投入時にそのまま使われる(投入時に別のパスを指定した場合はそちらが優先され、このTODOの設定として上書き保存される)。'

// dispatch自体はMCP経由で実行できない(前述)が、投入時に使われるモデルの
// 値はworkspacePathと同様にMCP経由で作成/更新したTODOにも引き継がれる。
const MODEL_DESCRIPTION =
  'TODOを投入する際に使うモデル(opus/sonnet/haiku/fableはClaude Codeのモデル、codexはClaude Codeの代わりにCodex CLIを起動する。サーバー設定で拡張された値も可)。未指定ならClaude Codeの既定モデルが使われる。'

export const createTodoShape = {
  title: z.string().min(1).describe('TODOのタイトル(必須)'),
  description: z.string().optional().describe('詳細説明(任意)'),
  milestoneId: z.number().int().positive().nullable().optional().describe('紐づけるマイルストーンID'),
  workspacePath: z.string().min(1).optional().describe(WORKSPACE_PATH_DESCRIPTION),
  model: z.string().min(1).optional().describe(MODEL_DESCRIPTION),
}

export const updateTodoShape = {
  id: z.number().int().positive().describe('更新するTODOのID'),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  milestoneId: z.number().int().positive().nullable().optional().describe('null で紐付け解除'),
  workspacePath: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(`${WORKSPACE_PATH_DESCRIPTION} null を指定すると設定済みの値をクリアする。`),
  model: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(`${MODEL_DESCRIPTION} null を指定すると設定済みの値をクリアする。`),
}

export const idOnlyShape = { id: z.number().int().positive() }

// herdr は自分のペイン内で起動したプロセスに HERDR_WORKSPACE_ID / HERDR_TAB_ID /
// HERDR_PANE_ID を渡す。Claude Code が起動する stdio MCP サーバー(このプロセス)
// もそれを引き継ぐので、herdr のペイン内で動く Claude Code からは引数無しで
// 「いま自分がいるセッション」を紐づけられる。
export const HERDR_PANE_ID_ENV = 'HERDR_PANE_ID'
export const HERDR_TAB_ID_ENV = 'HERDR_TAB_ID'
export const HERDR_WORKSPACE_ID_ENV = 'HERDR_WORKSPACE_ID'

export const NO_HERDR_PANE_MESSAGE =
  `herdr のペインIDが分かりません。この MCP サーバーは herdr のペイン内で起動されていない(環境変数 ${HERDR_PANE_ID_ENV} が無い)ので、` +
  'シェルで `echo $HERDR_PANE_ID` を実行して得た値を paneId に渡してください'

export const linkTodoSessionShape = {
  id: z.number().int().positive().describe('紐づけるTODOのID'),
  paneId: z
    .string()
    .min(1)
    .optional()
    .describe(
      `herdr のペインID。省略時は環境変数 ${HERDR_PANE_ID_ENV}(herdr のペイン内で起動された Claude Code から呼ばれていれば自動で入る)。`
    ),
  tabId: z.string().min(1).optional().describe(`herdr のタブID(任意。省略時は ${HERDR_TAB_ID_ENV}。herdr の実測値と照合するだけ)`),
  workspaceId: z
    .string()
    .min(1)
    .optional()
    .describe(`herdr のワークスペースID(任意。省略時は ${HERDR_WORKSPACE_ID_ENV}。herdr の実測値と照合するだけ)`),
}

export const addPullRequestShape = {
  id: z.number().int().positive().describe('PRを紐付けるTODOのID'),
  url: z
    .string()
    .min(1)
    .describe(
      'GitHubのPull RequestのURL (https://github.com/owner/repo/pull/123)。末尾の /files や #discussion_r… は自動で取り除かれ、同じPRを二重登録することはできない。github.com のみ対応。'
    ),
}

export const pullRequestRefShape = {
  id: z.number().int().positive().describe('対象TODOのID'),
  pullRequestId: z.number().int().positive().describe('TODOに紐づくPRリンクのID(TODOのpullRequests[].id)'),
}

interface TodoLike {
  readonly status: string
  readonly milestoneId: number | null
}

function matchesFilter(
  todo: TodoLike,
  filter: { status?: 'open' | 'done'; milestoneId?: number }
): boolean {
  if (filter.status !== undefined && todo.status !== filter.status) {
    return false
  }
  if (filter.milestoneId !== undefined && todo.milestoneId !== filter.milestoneId) {
    return false
  }
  return true
}

// GET /api/todos has no query-param filtering of its own, so status/
// milestoneId filtering happens client-side here rather than growing the
// HTTP API's surface just for this MCP convenience.
export function listTodos(
  client: DotConnectClient,
  args: { status?: 'open' | 'done'; milestoneId?: number }
) {
  return runTool(async () => {
    const todos = await client.request<TodoLike[]>('GET', '/api/todos')
    return todos.filter((todo) => matchesFilter(todo, args))
  })
}

export function createTodo(
  client: DotConnectClient,
  args: {
    title: string
    description?: string
    milestoneId?: number | null
    workspacePath?: string
    model?: string
  }
) {
  return runTool(() => client.request('POST', '/api/todos', args))
}

export function updateTodo(
  client: DotConnectClient,
  args: {
    id: number
    title?: string
    description?: string
    milestoneId?: number | null
    workspacePath?: string | null
    model?: string | null
  }
) {
  const { id, ...body } = args
  return runTool(() => client.request('PATCH', `/api/todos/${id}`, body))
}

export interface LinkTodoSessionArgs {
  id: number
  paneId?: string
  tabId?: string
  workspaceId?: string
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim()
  return value !== undefined && value.length > 0 ? value : undefined
}

// Resolves the herdr identifiers from args first, then from the environment
// herdr injects into its panes. Exported for tests; the server passes
// process.env.
export function resolveHerdrSessionIds(
  args: Omit<LinkTodoSessionArgs, 'id'>,
  env: NodeJS.ProcessEnv
): { paneId: string; tabId?: string; workspaceId?: string } | null {
  const paneId = args.paneId ?? envValue(env, HERDR_PANE_ID_ENV)
  if (paneId === undefined) {
    return null
  }
  // tab/workspace from the env only make sense alongside the env's own pane
  // id — an explicit paneId for some other pane must not be checked against
  // this process's tab/workspace.
  const fromEnv = args.paneId === undefined
  return {
    paneId,
    tabId: args.tabId ?? (fromEnv ? envValue(env, HERDR_TAB_ID_ENV) : undefined),
    workspaceId: args.workspaceId ?? (fromEnv ? envValue(env, HERDR_WORKSPACE_ID_ENV) : undefined),
  }
}

export function linkTodoSession(
  client: DotConnectClient,
  args: LinkTodoSessionArgs,
  env: NodeJS.ProcessEnv = process.env
) {
  return runTool(async () => {
    const { id, ...rest } = args
    const ids = resolveHerdrSessionIds(rest, env)
    if (ids === null) {
      throw new Error(NO_HERDR_PANE_MESSAGE)
    }
    return client.request('POST', `/api/todos/${id}/session`, ids)
  })
}

export function unlinkTodoSession(client: DotConnectClient, args: { id: number }) {
  return runTool(() => client.request('DELETE', `/api/todos/${args.id}/session`))
}

export function completeTodo(client: DotConnectClient, args: { id: number }) {
  return runTool(() => client.request('POST', `/api/todos/${args.id}/complete`))
}

export function reopenTodo(client: DotConnectClient, args: { id: number }) {
  return runTool(() => client.request('POST', `/api/todos/${args.id}/reopen`))
}

export function deleteTodo(client: DotConnectClient, args: { id: number }) {
  return runTool(() => client.request('DELETE', `/api/todos/${args.id}`))
}

// All three return the updated TODO (with its full pullRequests array), not
// just the affected link — the same convention the REST endpoints use, so a
// caller always sees the resulting state in one response.
export function addTodoPullRequest(client: DotConnectClient, args: { id: number; url: string }) {
  return runTool(() => client.request('POST', `/api/todos/${args.id}/pull-requests`, { url: args.url }))
}

export function refreshTodoPullRequest(
  client: DotConnectClient,
  args: { id: number; pullRequestId: number }
) {
  return runTool(() =>
    client.request('POST', `/api/todos/${args.id}/pull-requests/${args.pullRequestId}/refresh`)
  )
}

export function removeTodoPullRequest(
  client: DotConnectClient,
  args: { id: number; pullRequestId: number }
) {
  return runTool(() =>
    client.request('DELETE', `/api/todos/${args.id}/pull-requests/${args.pullRequestId}`)
  )
}
