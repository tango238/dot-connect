import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { logger } from '../logger'
import { createDotConnectClient, type DotConnectClient } from './dotConnectClient'
import * as labelTools from './labelTools'
import * as milestoneTools from './milestoneTools'
import * as todoTools from './todoTools'
import * as workspaceTools from './workspaceTools'

const DEFAULT_DOT_CONNECT_URL = 'http://127.0.0.1:5757'

export interface McpEnvConfig {
  readonly baseUrl: string
  readonly apiToken: string | null
}

export function readMcpEnvConfig(env: NodeJS.ProcessEnv): McpEnvConfig {
  const token = env.DOT_CONNECT_API_TOKEN?.trim()
  return {
    baseUrl: env.DOT_CONNECT_URL ?? DEFAULT_DOT_CONNECT_URL,
    apiToken: token !== undefined && token.length > 0 ? token : null,
  }
}

// dispatch/open-session are intentionally NOT exposed here — see the
// server-side allowlist in src/api/apiTokenAuth.ts, and the README, for why:
// dispatch launches an arbitrary Claude Code session in an arbitrary
// directory with an arbitrary prompt, which is effectively remote code
// execution if handed to any MCP client.
function registerTodoTools(server: McpServer, client: DotConnectClient): void {
  server.registerTool(
    'list_todos',
    {
      description:
        'TODO一覧を取得する。status/milestoneIdで絞り込み可能。各TODOにはworkspacePath(herdr投入時の作業ディレクトリ、未設定ならnull)とmodel(投入時に使うClaude Codeのモデル、未設定ならnull=既定モデル)が含まれる。',
      inputSchema: todoTools.listTodosShape,
    },
    (args) => todoTools.listTodos(client, args)
  )
  server.registerTool(
    'create_todo',
    {
      description:
        '新しいTODOを作成する。workspacePathは作成時点では任意だが、herdrへの投入(dispatch)には必須になるので、投入先が決まっているなら作成時に設定しておくとよい。modelは投入時に起動するモデルを指定する(opus/sonnet/haiku/fableはClaude Code、codexはCodex CLI。任意、未指定ならClaude Codeの既定モデル)。',
      inputSchema: todoTools.createTodoShape,
    },
    (args) => todoTools.createTodo(client, args)
  )
  server.registerTool(
    'update_todo',
    {
      description:
        'TODOのtitle/description/milestoneId/workspacePath/modelを更新する。workspacePathとmodelはどちらもnullでクリアできるが、workspacePathをクリアしたままでは投入(dispatch)できない点に注意。',
      inputSchema: todoTools.updateTodoShape,
    },
    (args) => todoTools.updateTodo(client, args)
  )
  server.registerTool(
    'complete_todo',
    { description: 'TODOを完了にする。', inputSchema: todoTools.idOnlyShape },
    (args) => todoTools.completeTodo(client, args)
  )
  server.registerTool(
    'reopen_todo',
    { description: '完了済みのTODOを未完了に戻す。', inputSchema: todoTools.idOnlyShape },
    (args) => todoTools.reopenTodo(client, args)
  )
  server.registerTool(
    'delete_todo',
    { description: 'TODOを削除する。', inputSchema: todoTools.idOnlyShape },
    (args) => todoTools.deleteTodo(client, args)
  )
  server.registerTool(
    'add_todo_pull_request',
    {
      description:
        'TODOにGitHubのPull RequestのURLを紐付ける(1つのTODOに複数登録できる)。登録時に gh CLI でPRのタイトル・状態(open/closed/merged)・draftかどうかを取得して保存する。gh が使えない/権限がない場合でもURLの登録自体は成功し、取得できなかった理由が fetchError に入る。',
      inputSchema: todoTools.addPullRequestShape,
    },
    (args) => todoTools.addTodoPullRequest(client, args)
  )
  server.registerTool(
    'refresh_todo_pull_request',
    {
      description:
        '紐付け済みPRのタイトル・状態を gh CLI で取り直す。状態は登録時のスナップショットで自動更新はされないので、最新のマージ状況を知りたいときに使う。',
      inputSchema: todoTools.pullRequestRefShape,
    },
    (args) => todoTools.refreshTodoPullRequest(client, args)
  )
  server.registerTool(
    'remove_todo_pull_request',
    {
      description: 'TODOからPRの紐付けを削除する(GitHub上のPRには一切影響しない)。',
      inputSchema: todoTools.pullRequestRefShape,
    },
    (args) => todoTools.removeTodoPullRequest(client, args)
  )
}

function registerMilestoneTools(server: McpServer, client: DotConnectClient): void {
  server.registerTool(
    'list_milestones',
    { description: 'マイルストーン一覧を取得する(紐づくラベル・TODO進捗を含む)。' },
    () => milestoneTools.listMilestones(client)
  )
  server.registerTool(
    'create_milestone',
    { description: '新しいマイルストーンを作成する。', inputSchema: milestoneTools.createMilestoneShape },
    (args) => milestoneTools.createMilestone(client, args)
  )
  server.registerTool(
    'update_milestone',
    { description: 'マイルストーンを更新する。', inputSchema: milestoneTools.updateMilestoneShape },
    (args) => milestoneTools.updateMilestone(client, args)
  )
  server.registerTool(
    'complete_milestone',
    {
      description: 'マイルストーンを完了にする。未完了のTODOが残っている場合はエラーになる(件数つき)。',
      inputSchema: milestoneTools.idOnlyShape,
    },
    (args) => milestoneTools.completeMilestone(client, args)
  )
  server.registerTool(
    'reopen_milestone',
    { description: '完了済みのマイルストーンを未完了に戻す。', inputSchema: milestoneTools.idOnlyShape },
    (args) => milestoneTools.reopenMilestone(client, args)
  )
  server.registerTool(
    'delete_milestone',
    { description: 'マイルストーンを削除する(紐づくTODOの紐付けは解除される)。', inputSchema: milestoneTools.idOnlyShape },
    (args) => milestoneTools.deleteMilestone(client, args)
  )
}

function registerLabelTools(server: McpServer, client: DotConnectClient): void {
  server.registerTool(
    'list_labels',
    { description: 'ラベル一覧を取得する。' },
    () => labelTools.listLabels(client)
  )
  server.registerTool(
    'create_label',
    { description: '新しいラベルを作成する。名前は重複不可。', inputSchema: labelTools.createLabelShape },
    (args) => labelTools.createLabel(client, args)
  )
  server.registerTool(
    'update_label',
    { description: 'ラベルの名前/色を更新する。', inputSchema: labelTools.updateLabelShape },
    (args) => labelTools.updateLabel(client, args)
  )
  server.registerTool(
    'delete_label',
    { description: 'ラベルを削除する(紐づくマイルストーンの紐付けは解除される)。', inputSchema: labelTools.idOnlyShape },
    (args) => labelTools.deleteLabel(client, args)
  )
}

function registerWorkspaceTools(server: McpServer, client: DotConnectClient): void {
  server.registerTool(
    'list_workspaces',
    { description: '登録済みの作業ディレクトリ一覧を取得する(名前昇順)。' },
    () => workspaceTools.listWorkspaces(client)
  )
  server.registerTool(
    'create_workspace',
    {
      description:
        'よく使う作業ディレクトリを登録する。名前は重複不可、パスは絶対パス("/"始まり)である必要がある。TODOのworkspacePathを設定する際の入力補助用で、TODO自体はここに登録したパスの文字列コピーを保持する(登録を削除してもTODO側のworkspacePathは変わらない)。',
      inputSchema: workspaceTools.createWorkspaceShape,
    },
    (args) => workspaceTools.createWorkspace(client, args)
  )
  server.registerTool(
    'update_workspace',
    { description: '登録済みの作業ディレクトリの名前/パスを更新する。', inputSchema: workspaceTools.updateWorkspaceShape },
    (args) => workspaceTools.updateWorkspace(client, args)
  )
  server.registerTool(
    'delete_workspace',
    {
      description:
        '登録済みの作業ディレクトリを削除する。既にworkspacePathとして使われているTODOには影響しない(文字列コピーのため)。',
      inputSchema: workspaceTools.idOnlyShape,
    },
    (args) => workspaceTools.deleteWorkspace(client, args)
  )
}

export function buildMcpServer(client: DotConnectClient): McpServer {
  const server = new McpServer({ name: 'dot-connect', version: '0.1.0' })
  registerTodoTools(server, client)
  registerMilestoneTools(server, client)
  registerLabelTools(server, client)
  registerWorkspaceTools(server, client)
  return server
}

if (import.meta.main) {
  const { baseUrl, apiToken } = readMcpEnvConfig(process.env)
  // stdout is reserved exclusively for MCP JSON-RPC framing; this log (like
  // the rest of the app's logger) goes to stderr, which is safe.
  logger.info('Starting dot-connect MCP server', { baseUrl, apiTokenConfigured: apiToken !== null })
  const client = createDotConnectClient({ baseUrl, apiToken })
  const server = buildMcpServer(client)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
