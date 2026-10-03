import { z } from 'zod'
import type { ExecFn } from '../herdr/exec'
import type { LlmAnalysis } from '../types'

export interface WeeklyAggregate {
  readonly weekStart: string
  readonly weekEnd: string
  readonly completedCount: number
  readonly milestoneLinkedCount: number
  readonly unplannedCount: number
  readonly dispatchCount: number
}

export interface ClaudeRunner {
  analyze(aggregate: WeeklyAggregate): Promise<LlmAnalysis>
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
    'JSONの形式: {"summary": string, "warnings": string[], "suggestions": string[]}',
    '',
    JSON.stringify(aggregate),
  ].join('\n')
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

  return {
    async analyze(aggregate) {
      const prompt = buildPrompt(aggregate)
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

      const sanitized = extractJsonObject(envelope.data.result)

      let parsed: unknown
      try {
        parsed = JSON.parse(sanitized)
      } catch {
        throw new Error(`claude -p result was not valid JSON after sanitization: ${envelope.data.result}`)
      }

      const result = llmAnalysisSchema.safeParse(parsed)
      if (!result.success) {
        throw new Error(`claude -p returned an unexpected JSON shape: ${envelope.data.result}`)
      }

      return result.data
    },
  }
}
