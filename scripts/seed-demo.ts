// README のスクリーンショット用デモデータを、起動中の dot-connect に HTTP API 経由で投入する。
// 使い方(本番DBを汚さないよう、必ず別の DB_PATH で起動したサーバーに向けること):
//   DB_PATH=/tmp/dot-connect-demo.db PORT=5858 bun run src/server.ts
//   DOT_CONNECT_URL=http://127.0.0.1:5858 bun run scripts/seed-demo.ts

const BASE_URL = process.env.DOT_CONNECT_URL ?? 'http://127.0.0.1:5858'
const WORKSPACE_ROOT = '/Users/you/projects'
const DAY_MS = 24 * 60 * 60 * 1000

interface Created {
  readonly id: number
}

function isoDate(offsetDays: number): string {
  const date = new Date(Date.now() + offsetDays * DAY_MS)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    // Origin を自サーバーに合わせて、ブラウザUIと同じ同一オリジン扱いにする
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await response.json()) as { success: boolean; data?: T; error?: string }
  if (!response.ok || !json.success || json.data === undefined) {
    throw new Error(`POST ${path} failed (${response.status}): ${json.error ?? 'unknown error'}`)
  }
  return json.data
}

const LABELS = [
  { key: 'web', name: 'Webアプリ', color: '#2563eb' },
  { key: 'api', name: 'API', color: '#16a34a' },
  { key: 'infra', name: 'インフラ', color: '#d97706' },
] as const

type LabelKey = (typeof LABELS)[number]['key']

const MILESTONES = [
  { key: 'search', title: '商品検索リニューアル', label: 'web', color: '#2563eb', start: -10, target: 11, description: '検索UIの刷新と絞り込み条件の追加' },
  { key: 'checkout', title: '決済フロー改善', label: 'api', color: '#16a34a', start: -3, target: 25, description: '注文APIのエラーハンドリングと再試行' },
  { key: 'ci', title: 'CI高速化', label: 'infra', color: '#d97706', start: -20, target: 4, description: 'テスト並列化とキャッシュの見直し' },
] as const satisfies readonly { key: string; label: LabelKey; [field: string]: unknown }[]

type MilestoneKey = (typeof MILESTONES)[number]['key']

interface DemoTodo {
  readonly title: string
  readonly description?: string
  readonly milestone?: MilestoneKey
  readonly priority?: 'none' | 'low' | 'high'
  readonly due?: number
  readonly workspace?: string
  readonly model?: string
  readonly comments?: readonly string[]
  readonly done?: boolean
}

const TODOS: readonly DemoTodo[] = [
  { title: '検索結果ページのレイアウトを新デザインに合わせる', description: 'カード型レイアウトに変更し、モバイル幅での折り返しを確認する。', milestone: 'search', priority: 'high', due: 2, workspace: 'my-app', model: 'opus', comments: ['デザインカンプを確認。カードの余白は 16px で統一する。', 'PC幅は実装済み。残りはモバイル幅の確認。'] },
  { title: '価格帯・在庫ありの絞り込み条件を追加する', description: 'クエリパラメータ price_min / price_max / in_stock を検索APIに渡す。', milestone: 'search', priority: 'high', due: 5, workspace: 'my-app', model: 'sonnet' },
  { title: '検索キーワードのサジェストをデバウンスする', milestone: 'search', priority: 'low', due: 9, workspace: 'my-app', model: 'haiku' },
  { title: '検索APIのレスポンスにページネーション情報を含める', milestone: 'search', due: -1, workspace: 'my-api', model: 'sonnet', comments: ['total / page / limit を meta に入れる方針で合意。'] },
  { title: '検索インデックスの再構築バッチを作る', milestone: 'search', workspace: 'my-api', done: true },
  { title: '注文APIのタイムアウト時に再試行する', description: '冪等キーを付けて最大3回まで再試行。失敗時はユーザーに再操作を促す。', milestone: 'checkout', priority: 'high', due: 7, workspace: 'my-api', model: 'opus' },
  { title: '決済失敗時のエラーメッセージを見直す', milestone: 'checkout', priority: 'low', due: 14, workspace: 'my-app' },
  { title: '注文確認メールのテンプレートを更新する', milestone: 'checkout', due: 18, workspace: 'my-api', model: 'codex' },
  { title: 'テストをシャード分割して並列実行する', milestone: 'ci', priority: 'high', due: 1, workspace: 'my-infra', model: 'sonnet', comments: ['4シャードで 12分 → 4分に短縮できた。'] },
  { title: '依存パッケージのキャッシュキーを見直す', milestone: 'ci', workspace: 'my-infra', done: true },
  { title: 'flaky なE2Eテストを隔離する', milestone: 'ci', workspace: 'my-infra', done: true },
  { title: 'READMEのセットアップ手順を更新する', priority: 'low', workspace: 'my-app' },
]

async function seedLabels(): Promise<Map<LabelKey, number>> {
  const ids = new Map<LabelKey, number>()
  for (const label of LABELS) {
    const created = await post<Created>('/api/labels', { name: label.name, color: label.color })
    ids.set(label.key, created.id)
  }
  return ids
}

async function seedMilestones(labelIds: Map<LabelKey, number>): Promise<Map<MilestoneKey, number>> {
  const ids = new Map<MilestoneKey, number>()
  for (const milestone of MILESTONES) {
    const created = await post<Created>('/api/milestones', {
      title: milestone.title,
      description: milestone.description,
      color: milestone.color,
      startDate: isoDate(milestone.start),
      targetDate: isoDate(milestone.target),
      labelId: labelIds.get(milestone.label),
    })
    ids.set(milestone.key, created.id)
  }
  return ids
}

async function seedTodo(todo: DemoTodo, milestoneIds: Map<MilestoneKey, number>): Promise<void> {
  const created = await post<Created>('/api/todos', {
    title: todo.title,
    description: todo.description,
    milestoneId: todo.milestone === undefined ? null : milestoneIds.get(todo.milestone),
    priority: todo.priority,
    dueDate: todo.due === undefined ? null : isoDate(todo.due),
    workspacePath: todo.workspace === undefined ? null : `${WORKSPACE_ROOT}/${todo.workspace}`,
    model: todo.model ?? null,
  })
  for (const body of todo.comments ?? []) {
    await post(`/api/todos/${created.id}/comments`, { body })
  }
  if (todo.done === true) {
    await post(`/api/todos/${created.id}/complete`)
  }
}

async function main(): Promise<void> {
  const labelIds = await seedLabels()
  const milestoneIds = await seedMilestones(labelIds)
  for (const name of ['my-app', 'my-api', 'my-infra']) {
    await post('/api/workspaces', { name, path: `${WORKSPACE_ROOT}/${name}` })
  }
  for (const todo of TODOS) {
    await seedTodo(todo, milestoneIds)
  }
  process.stdout.write(`Seeded ${TODOS.length} todos into ${BASE_URL}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
