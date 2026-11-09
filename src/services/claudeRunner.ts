import { z } from 'zod'
import type { ExecFn } from '../herdr/exec'
import type { LlmAnalysis } from '../types'

// 集計の内訳(reportService.aggregateDetails)。プロンプトには JSON のまま
// 入るので、キー名が LLM への説明を兼ねる。
export interface WeeklyAggregateDetails {
  /** その週の目標(週次レポート画面の自由入力)。未記入なら null。 */
  readonly goal: string | null
  readonly createdCount: number
  readonly previousWeek: { readonly completedCount: number; readonly createdCount: number; readonly dispatchCount: number }
  readonly daily: readonly { readonly date: string; readonly created: number; readonly completed: number }[]
  readonly fastestCompleted: readonly { readonly title: string; readonly leadMinutes: number; readonly milestone: string | null }[]
  readonly leadTime: { readonly averageMinutes: number | null; readonly medianMinutes: number | null }
  readonly onTime: { readonly withDueCount: number; readonly onTimeCount: number }
  readonly byUrgency: Readonly<Record<string, number>>
  readonly byImportance: Readonly<Record<string, number>>
  readonly byMilestone: readonly { readonly title: string; readonly count: number }[]
  readonly backlog: { readonly openCount: number; readonly overdueCount: number; readonly dueThisWeekCount: number }
}

export interface WeeklyAggregate {
  readonly weekStart: string
  readonly weekEnd: string
  readonly completedCount: number
  readonly milestoneLinkedCount: number
  readonly unplannedCount: number
  readonly dispatchCount: number
  readonly details?: WeeklyAggregateDetails
}

export interface ClaudeRunner {
  analyze(aggregate: WeeklyAggregate): Promise<LlmAnalysis>
  /**
   * 目標の文章を、内容を変えずに読みやすく整える(週次レポートの「整理する」)。
   * 整理後の本文だけを返す。
   */
  tidyGoal(body: string, todos?: readonly GoalTodoStatus[]): Promise<string>
}

/** 整理のときに渡す、目標に関係しそうな TODO の現在の状態。 */
export interface GoalTodoStatus {
  readonly id: number
  readonly title: string
  readonly done: boolean
}

export interface ClaudeRunnerOptions {
  readonly timeoutMs?: number
}

const DEFAULT_CLAUDE_TIMEOUT_MS = 120_000

const llmAnalysisSchema = z.object({
  summary: z.string(),
  warnings: z.array(z.string()),
  suggestions: z.array(z.string()),
})

// `claude -p ... --output-format json` wraps the assistant's final text in an
// outer envelope alongside cost/duration metadata; we only need `result`
// (and `is_error`, to distinguish a claude-reported failure from a parse
// failure on our side).
const outerEnvelopeSchema = z
  .object({
    result: z.string(),
    is_error: z.boolean().optional(),
  })
  .passthrough()

function buildPrompt(aggregate: WeeklyAggregate): string {
  return [
    'あなたはソフトウェアチームの週次進捗を分析するアシスタントです。',
    '次の集計データを分析し、JSONオブジェクトのみを出力してください(説明文やコードフェンスは不要)。',
    'details には登録数(createdCount)・前週(previousWeek)・日別(daily)・登録から完了が速かったTODO(fastestCompleted、leadMinutes は分)・',
    'リードタイム(leadTime)・期日内完了(onTime)・緊急度別(byUrgency、1〜5 で 5 が最も急ぐ)・重要度別(byImportance、同様)・マイルストーン別(byMilestone)・未完了の状況(backlog)が入ります。',
    '完了数と登録数のバランス、日別の偏り、期日内率、未完了の積み残しに触れてください。',
    'details.goal はその週の目標(ユーザーの自由記述、null なら未記入)です。目標があれば、実績が目標にどこまで近づいたかを summary と suggestions で必ず扱ってください。',
    'JSONの形式: {"summary": string, "warnings": string[], "suggestions": string[]}',
    '',
    JSON.stringify(aggregate),
  ].join('\n')
}

export const TIDY_GOAL_INSTRUCTIONS = [
  'あなたは文章を整える編集者です。次の「今週の目標」を、内容・意図・約束している範囲を変えずに読みやすく整理してください。',
  '守ること: 項目を追加・削除・言い換えで弱めたり強めたりしない。数字・固有名詞・期限はそのまま。重複だけはまとめる。',
  '書式は Markdown: 箇条書きが向くなら「- 」、やることなら「- [ ] 」のチェックリスト、いくつかの塊に分かれるなら「## 」の見出し。元の見出し・チェック状態(- [x])はそのまま残す。',
  '元が短ければ短いまま。出力は整理後の本文のみ(前置き・説明・コードフェンスは不要)。',
  '完了の確認: 下の「TODOの状態」で完了済みのTODO(#番号またはタイトルが一致するもの)に当たるチェックリストの行は「- [x] 」にする。未完了のものを [x] にしない。既に [x] の行を [ ] に戻さない。状態の一覧にないものは元のまま。',
  '',
].join('\n')

function buildTidyPrompt(body: string, todos: readonly GoalTodoStatus[]): string {
  const status =
    todos.length === 0
      ? '--- TODOの状態 ---\n(なし)'
      : `--- TODOの状態 ---\n${todos.map((t) => `#${t.id} ${t.title}: ${t.done ? '完了' : '未完了'}`).join('\n')}`
  return `${TIDY_GOAL_INSTRUCTIONS}\n${status}\n\n--- 目標 ---\n${body}`
}

// Strips a code fence the model may still wrap plain text in.
function stripCodeFence(text: string): string {
  const match = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(text)
  return match ? (match[1] as string) : text
}

// Best-effort cleanup for cases where the model still wraps its JSON in a
// code fence or a leading sentence: take the substring from the first `{` to
// the last `}`. If no braces are found, return the text unchanged and let
// JSON.parse fail with a clear error.
function extractJsonObject(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    return text
  }
  return text.slice(start, end + 1)
}

export function createClaudeRunner(
  exec: ExecFn,
  claudeBin: string,
  options: ClaudeRunnerOptions = {}
): ClaudeRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS

  // Runs `claude -p <prompt> --output-format json` and returns the inner
  // result text, having unwrapped the envelope and surfaced any failure.
  async function runPrompt(prompt: string): Promise<string> {
    const { stdout, stderr, exitCode } = await exec(
      [claudeBin, '-p', prompt, '--output-format', 'json'],
      { timeoutMs }
    )

    if (exitCode !== 0) {
      throw new Error(`claude -p exited with code ${exitCode}: ${stderr || stdout}`)
    }

    let outer: unknown
    try {
      outer = JSON.parse(stdout.trim())
    } catch {
      throw new Error(`claude -p returned a non-JSON output envelope: ${stdout}`)
    }

    const envelope = outerEnvelopeSchema.safeParse(outer)
    if (!envelope.success) {
      throw new Error(`claude -p JSON envelope is missing a 'result' field: ${stdout}`)
    }
    if (envelope.data.is_error) {
      throw new Error(`claude -p reported an error result: ${envelope.data.result}`)
    }
    return envelope.data.result
  }

  return {
    async analyze(aggregate) {
      const resultText = await runPrompt(buildPrompt(aggregate))
      const sanitized = extractJsonObject(resultText)

      let parsed: unknown
      try {
        parsed = JSON.parse(sanitized)
      } catch {
        throw new Error(`claude -p result was not valid JSON after sanitization: ${resultText}`)
      }

      const result = llmAnalysisSchema.safeParse(parsed)
      if (!result.success) {
        throw new Error(`claude -p returned an unexpected JSON shape: ${resultText}`)
      }

      return result.data
    },

    async tidyGoal(body, todos = []) {
      const resultText = stripCodeFence(await runPrompt(buildTidyPrompt(body, todos))).trim()
      if (resultText.length === 0) {
        throw new Error('claude -p returned an empty result for the goal')
      }
      return resultText
    },
  }
}
