import { verifyPromptParser } from './promptArgs'
import type { ExecFn } from './exec'
import { ConflictError } from '../services/errors'

export const DEFAULT_HERDR_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const HERDR_VERIFIED_VERSIONS = [{
  version: '0.9.3', adapter: 'agent-prompt',
  evidence: '公式0.9.3ソースと実CLI→隔離モックの本文一致を検証。実エージェント送信は未検証。',
  difference: 'agent prompt target text（区切り -- は非対応）。本文入力と送信を担当。追加Enterなし。グローバル予約オプションだけの本文は拒否。',
}] as const

// Help detection is separate from the executable parser check below.
export const HERDR_OPERATIONS = [
  { id: 'snapshot', label: '状態取得', command: ['api', 'snapshot'], signature: /Usage: herdr api snapshot\b/ },
  { id: 'create', label: 'ワークスペース作成', command: ['workspace', 'create'], signature: /Usage: herdr workspace create\b/, required: ['--cwd', '--label', '--no-focus'] },
  { id: 'run', label: 'エージェント起動', command: ['pane', 'run'], signature: /Usage: herdr pane run <PANE_ID> <COMMAND>/ },
  { id: 'prompt', label: '依頼送信（Enter込み）', command: ['agent', 'prompt'], signature: /Usage: herdr agent prompt <TARGET> <TEXT>/ },
  { id: 'read', label: 'ペイン表示の読取', command: ['pane', 'read'], signature: /Usage: herdr pane read\b/, required: ['--source', 'visible'] },
  { id: 'keys', label: 'キー操作', command: ['pane', 'send-keys'], signature: /Usage: herdr pane send-keys <PANE_ID> <KEY>/ },
  { id: 'focus', label: 'タブを開く', command: ['tab', 'focus'], signature: /Usage: herdr tab focus <tab_id>/ },
  { id: 'close', label: 'ワークスペース終了', command: ['workspace', 'close'], signature: /Usage: herdr workspace close <workspace_id>/ },
] as const

type OperationId = typeof HERDR_OPERATIONS[number]['id']
export interface HerdrCompatibility {
  installedVersion: string | null
  previousVersion: string | null
  changedAt: string | null
  status: 'unchecked' | 'verified-parser' | 'unverified' | 'incompatible' | 'missing' | 'error'
  checkedAt: string | null
  lastSuccessfulCheckAt: string | null
  nextCheckAt: string | null
  intervalMs: number
  dispatchAllowed: boolean
  promptParserVerified: boolean
  adapter: 'agent-prompt' | null
  operations: { id: OperationId; label: string; command: string; detected: boolean }[]
  verifiedVersions: typeof HERDR_VERIFIED_VERSIONS
  latestPublishedVersion: null
  latestPublishedNote: string
  message: string
}

export interface HerdrCompatibilityMonitor {
  check(force?: boolean): Promise<HerdrCompatibility>
  assertDispatchCompatible(): Promise<void>
  start(): () => void
}

export function createHerdrCompatibilityMonitor(
  exec: ExecFn, binary: string,
  options: { intervalMs?: number; timeoutMs?: number; now?: () => number } = {}
): HerdrCompatibilityMonitor {
  const intervalMs = options.intervalMs ?? DEFAULT_HERDR_CHECK_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? 3000
  const now = options.now ?? Date.now
  let lastVersion: string | null = null
  let inFlight: Promise<HerdrCompatibility> | null = null
  let dueAt = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let state: HerdrCompatibility = {
    installedVersion: null, previousVersion: null, changedAt: null,
    status: 'unchecked', checkedAt: null, lastSuccessfulCheckAt: null, nextCheckAt: null,
    intervalMs, dispatchAllowed: false, promptParserVerified: false, adapter: null, operations: [],
    verifiedVersions: HERDR_VERIFIED_VERSIONS,
    latestPublishedVersion: null,
    latestPublishedNote: '未確認（公開版のネットワーク照会は行いません）',
    message: '未確認',
  }

  async function probe(): Promise<HerdrCompatibility> {
    const checkedAt = new Date(now()).toISOString()
    state = { ...state, installedVersion: null, checkedAt, dispatchAllowed: false, promptParserVerified: false, adapter: null, operations: [] }
    try {
      const version = await exec([binary, '--version'], { timeoutMs })
      if (version.exitCode !== 0) throw new Error(`--version failed (exit ${version.exitCode})`)
      const match = /^herdr\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(version.stdout.trim())
      if (!match?.[1]) throw new Error('Herdrのバージョン出力を解釈できません')
      const installedVersion = match[1]
      if (lastVersion && lastVersion !== installedVersion) {
        state = { ...state, previousVersion: lastVersion, changedAt: checkedAt }
      }
      lastVersion = installedVersion
      state = { ...state, installedVersion }
      const operations = await Promise.all(HERDR_OPERATIONS.map(async operation => {
        const result = await exec([binary, ...operation.command, '--help'], { timeoutMs })
        const detected = result.exitCode === 0 && operation.signature.test(result.stdout)
          && (!('required' in operation) || operation.required.every(flag => result.stdout.includes(flag)))
        return { id: operation.id, label: operation.label, command: `herdr ${operation.command.join(' ')}`, detected }
      }))
      const known = HERDR_VERIFIED_VERSIONS.some(v => v.version === installedVersion)
      const helpCompatible = operations.every(operation => operation.detected)
      const promptParserVerified = known && helpCompatible && await verifyPromptParser(exec, binary, timeoutMs)
      const compatible = helpCompatible && (!known || promptParserVerified)
      state = { ...state, operations, promptParserVerified, lastSuccessfulCheckAt: checkedAt,
        status: !compatible ? 'incompatible' : known ? 'verified-parser' : 'unverified',
        dispatchAllowed: known && compatible,
        adapter: known && compatible ? 'agent-prompt' : null,
        message: !compatible ? '必要なCLI形式または実引数パーサーを確認できないため依頼送信を停止しています。'
          : known ? 'CLIヘルプと実引数パーサーを確認済み。実エージェントへの送信テストは行っていません。'
          : '未検証版です。CLI機能は検出しましたが、対応表に追加するまで依頼送信を停止します。',
      }
      dueAt = now() + intervalMs
    } catch (err) {
      const missing = typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
      state = { ...state, status: missing ? 'missing' : 'error',
        message: missing ? 'Herdrが見つかりません。HERDR_BINとインストール先を確認してください。'
          : `Herdrの確認に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      }
      dueAt = now() + Math.min(intervalMs, 60_000)
    }
    state = { ...state, nextCheckAt: new Date(dueAt).toISOString() }
    return state
  }

  const monitor: HerdrCompatibilityMonitor = {
    check(force = false) {
      if (inFlight) return inFlight
      if (!force && now() < dueAt) return Promise.resolve(state)
      inFlight = probe().finally(() => { inFlight = null })
      return inFlight
    },
    async assertDispatchCompatible() {
      // Always re-probe before dispatch/submission: an on-disk upgrade must
      // not inherit yesterday's permission to use a command. No send fallback.
      const current = await monitor.check(true)
      if (!current.dispatchAllowed) throw new ConflictError(`Herdr ${current.installedVersion ?? '不明'}: ${current.message} 設定から再確認してください。`)
    },
    start() {
      void monitor.check()
      if (timer === undefined) {
        // A wall-clock freshness check also catches sleep/resume.
        timer = setInterval(() => { void monitor.check() }, Math.min(intervalMs, 60_000))
        timer.unref()
      }
      return () => { clearInterval(timer); timer = undefined }
    },
  }
  return monitor
}
