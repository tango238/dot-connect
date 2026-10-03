import { logger } from '../logger'
import { BadRequestError } from './errors'

// Not a Claude Code model: selecting it makes dispatch launch the Codex CLI
// (CODEX_BIN) in place of claude, with no --model flag. It lives in the same
// list so the existing select/badge/allowlist plumbing carries it unchanged.
export const CODEX_MODEL = 'codex'

// The Claude Code CLI's own model aliases, plus CODEX_MODEL. Kept here (not
// in config.ts) so the default list and the validation that uses it live
// together — config.ts only needs to parse an optional override, never
// construct a BadRequestError itself.
export const DEFAULT_ALLOWED_MODELS: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable', CODEX_MODEL]

// F1: an allowlist ENTRY itself must be shape-checked, not just split/
// trimmed. DOT_CONNECT_ALLOWED_MODELS is operator-controlled config, but that
// config value ends up interpolated verbatim into a command string typed
// into a live herdr pane (buildAgentCommand in dispatchService.ts) — a
// value like "opus; touch /tmp/pwned" or "opus`id`" would sail through
// assertAllowedModel's exact-match check (it WOULD be in the "allowed" list,
// having put itself there) and become a command injection the moment
// someone dispatches with that "model". Requiring every entry to look like a
// plain identifier (starts with alnum, then alnum/./_/:/- only, capped at
// 100 chars) rules out shell metacharacters, whitespace, and control
// characters at the one place they'd otherwise slip in as an "allowed" value.
const ALLOWED_MODEL_ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

// DOT_CONNECT_ALLOWED_MODELS is a comma-separated override. A trailing comma
// (or accidental double comma) produces blank entries that are dropped
// rather than becoming an accidental empty-string "model"; an entry that
// doesn't match ALLOWED_MODEL_ENTRY_PATTERN (metacharacters, whitespace,
// leading "-", oversized) is also dropped, with a warning logged so a typo'd
// env var doesn't fail silently. An override that, after dropping bad
// entries, has nothing left falls back to the default list rather than
// allowing zero models (which would make every dispatch fail).
export function parseAllowedModels(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_ALLOWED_MODELS
  }
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => {
      const ok = ALLOWED_MODEL_ENTRY_PATTERN.test(value)
      if (!ok) {
        logger.warn('Ignoring invalid DOT_CONNECT_ALLOWED_MODELS entry (must be a plain identifier)', {
          value,
        })
      }
      return ok
    })
  return values.length > 0 ? values : DEFAULT_ALLOWED_MODELS
}

// The one place a model name is checked against the allowlist before it can
// ever reach a herdr `pane run` command line (see dispatchService.ts). Every
// entry in allowedModels has already been shape-checked by
// ALLOWED_MODEL_ENTRY_PATTERN in parseAllowedModels (for the
// DOT_CONNECT_ALLOWED_MODELS-sourced list) or is one of the hardcoded
// DEFAULT_ALLOWED_MODELS — either way, no allowlist entry can itself contain
// shell metacharacters, so an exact match against it is what keeps a value
// safe to interpolate into a command string typed into a live terminal pane.
export function assertAllowedModel(model: string, allowedModels: readonly string[]): void {
  if (!allowedModels.includes(model)) {
    throw new BadRequestError(`許可されていないモデルです: ${model}`)
  }
}
