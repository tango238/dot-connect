import { z } from 'zod'

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isRealCalendarDate(value: string): boolean {
  const parts = value.split('-').map(Number)
  const year = parts[0] ?? 0
  const month = parts[1] ?? 0
  const day = parts[2] ?? 0
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

const dateString = z
  .string()
  .regex(DATE_PATTERN, 'Expected YYYY-MM-DD')
  .refine(isRealCalendarDate, 'Not a real calendar date')

const colorString = z.string().regex(COLOR_PATTERN, 'Expected a #RRGGBB hex color')

function targetOnOrAfterStart(data: { startDate?: string; targetDate?: string }): boolean {
  if (data.startDate === undefined || data.targetDate === undefined) {
    return true
  }
  return data.targetDate >= data.startDate
}

function dateOrderIssue(): { message: string; path: string[] } {
  return { message: 'targetDate must be on or after startDate', path: ['targetDate'] }
}

const todoDescription = z.string().trim().max(4000)
// Unbounded titles are a real hazard here, not just a UX nicety: a custom
// dispatch prompt can reference {{title}} many times, so an unbounded title
// is amplified into an enormous herdr `pane run` argv (see buildTaskPrompt's
// own output-length guard in dispatchService.ts).
const TITLE_MAX_LENGTH = 200

const todoPriority = z.enum(['none', 'low', 'high'])

// F6: shared with the registered-workspace schemas further below, so a
// TODO's own workspacePath is bounded/shaped the same way as a registered
// workspace's path (previously only the latter had any limit at all — that
// asymmetry meant a TODO could carry an unbounded or relative workspacePath
// straight through to herdr's `workspace create --cwd <path>`, which is not
// a shell-injection risk (argv array, no shell involved) but does let a
// oversized value through and lets herdr fail loudly and confusingly (502)
// on a relative path instead of failing fast here with a clear message.
const WORKSPACE_PATH_MAX_LENGTH = 500
const ABSOLUTE_PATH_MESSAGE = '絶対パスを指定してください'

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/')
}

// A blank form field (empty string, or whitespace-only) is treated the same
// as not providing a path at all — coerced to null — rather than a 400.
// Without this, a whitespace-only value would pass a bare `.min(1)` check
// (which only looks at raw length, before any trimming) and get stored
// verbatim, silently slipping past dispatch's "workspacePath must be set"
// check later since a whitespace string is still non-null/non-undefined.
// Also accepts a literal `null` directly, so PATCH can explicitly clear an
// already-set path (create has nothing to clear, but accepting null there
// too is harmless and keeps the two schemas symmetric). The max-length and
// absolute-path checks run BEFORE the blank-to-null transform, on the raw
// trimmed string, and only reject when it's non-blank-and-not-absolute — a
// blank value always still coerces to null rather than getting a 400 in the
// wrong direction. This only governs NEW input: existing rows with a
// legacy relative/oversized workspacePath (from before this validation
// existed) are read back unvalidated — GET is never re-checked here.
//
// Built with `.nullable()` (not `z.union([..., z.null()])`) deliberately:
// zod reports a failure inside a plain string-vs-null union — once nested in
// an object, as every field here is — as a single top-level "Invalid input"
// on the field, with the actual refine message buried inside the issue's
// nested `errors`, which parseOrThrow (see validation.ts) does not unwrap.
// `.nullable()` keeps the specific message (e.g. ABSOLUTE_PATH_MESSAGE)
// surfacing directly, since it isn't a union from zod's error-reporting
// perspective.
const nullableWorkspacePath = z
  .string()
  .trim()
  .max(WORKSPACE_PATH_MAX_LENGTH)
  .refine((value) => value.length === 0 || isAbsolutePath(value), ABSOLUTE_PATH_MESSAGE)
  .transform((value) => (value.length > 0 ? value : null))
  .nullable()
  .optional()

// A Claude Code model alias (e.g. "opus"), not a free-form string — the
// actual allowlist check (see modelValidation.ts) happens in the route
// handler, where the configured allowedModels list is available; this
// schema only bounds the length and applies the same blank-means-null
// convention as workspacePath above, so a stray empty string from a form
// field clears the model rather than getting rejected or stored verbatim.
const MODEL_MAX_LENGTH = 100

const nullableModel = z
  .union([
    z
      .string()
      .trim()
      .max(MODEL_MAX_LENGTH)
      .transform((value) => (value.length > 0 ? value : null)),
    z.null(),
  ])
  .optional()

// undefined は据え置き、null は期限解除(workspacePath / model と同じ規約)。
const nullableDueDate = z.union([dateString, z.null()]).optional()

export const createTodoSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX_LENGTH),
  description: todoDescription.optional(),
  milestoneId: z.number().int().positive().nullable().optional(),
  priority: todoPriority.optional(),
  dueDate: nullableDueDate,
  workspacePath: nullableWorkspacePath,
  model: nullableModel,
})

export const updateTodoSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX_LENGTH).optional(),
  description: todoDescription.optional(),
  milestoneId: z.number().int().positive().nullable().optional(),
  priority: todoPriority.optional(),
  dueDate: nullableDueDate,
  workspacePath: nullableWorkspacePath,
  model: nullableModel,
})

export const createMilestoneSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX_LENGTH),
    description: z.string().optional(),
    color: colorString.optional(),
    startDate: dateString,
    targetDate: dateString,
    labelId: z.number().int().positive().nullable().optional(),
  })
  .refine(targetOnOrAfterStart, dateOrderIssue())

export const updateMilestoneSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX_LENGTH).optional(),
    description: z.string().optional(),
    color: colorString.optional(),
    startDate: dateString.optional(),
    targetDate: dateString.optional(),
    labelId: z.number().int().positive().nullable().optional(),
  })
  .refine(targetOnOrAfterStart, dateOrderIssue())

const LABEL_NAME_MAX_LENGTH = 50

export const createLabelSchema = z.object({
  name: z.string().trim().min(1).max(LABEL_NAME_MAX_LENGTH),
  color: colorString.optional(),
})

export const updateLabelSchema = z.object({
  name: z.string().trim().min(1).max(LABEL_NAME_MAX_LENGTH).optional(),
  color: colorString.optional(),
})

export const generateReportSchema = z.object({
  weekStart: dateString.optional(),
})

export const weekStartQuerySchema = z.object({
  weekStart: dateString,
})

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

// Bounded before it ever reaches the URL parser or `gh` argv. The shape
// check (github.com, /pull/<n>, …) lives in pullRequestUrl.ts rather than
// here: it has to produce the canonical URL anyway, so duplicating the
// pattern as a zod regex would just be a second place to keep in step.
const PULL_REQUEST_URL_MAX_LENGTH = 500

export const addPullRequestSchema = z.object({
  url: z.string().trim().min(1).max(PULL_REQUEST_URL_MAX_LENGTH),
})

// Nested route params: the todo and the PR link under it. Both are checked
// so a mismatched pair (a real PR id belonging to a different todo) is a
// 404 rather than acting on the wrong record.
export const todoPullRequestParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  prId: z.coerce.number().int().positive(),
})

// The todo and the attachment under it, checked as a pair for the same
// reason as todoPullRequestParamsSchema above.
export const todoAttachmentParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  attachmentId: z.coerce.number().int().positive(),
})

// 作業ログ1件の本文。前後の空白は落とし、空は弾く。上限は dispatch の
// prompt と同じ 4000 —— 1件の作業ログがそれより長いなら、それは添付の仕事。
// 同じ数字が public/js/lib/todoComment.js にもあり、UI側は先回りの案内用。
export const COMMENT_BODY_MAX_LENGTH = 4000

export const addCommentSchema = z.object({
  body: z.string().trim().min(1).max(COMMENT_BODY_MAX_LENGTH),
})

// The todo and the comment under it, checked as a pair for the same reason
// as todoPullRequestParamsSchema above.
export const todoCommentParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  commentId: z.coerce.number().int().positive(),
})

export const dispatchRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000).optional(),
  // Overrides (and persists onto the todo) the workspace path for this
  // dispatch. F6: bounded/absolute the same as nullableWorkspacePath above —
  // herdr itself would otherwise fail loudly (502) on an oversized or
  // relative path, when failing fast here with a clear message is cheaper.
  workspacePath: z
    .string()
    .trim()
    .min(1)
    .max(WORKSPACE_PATH_MAX_LENGTH)
    .refine(isAbsolutePath, ABSOLUTE_PATH_MESSAGE)
    .optional(),
  // Overrides (and persists onto the todo) the Claude Code model for this
  // dispatch. Omitted means "use the todo's already-stored model" (same
  // override-and-persist convention as workspacePath above). Checked against
  // the configured allowlist in dispatchService, not here.
  model: z.string().trim().min(1).max(MODEL_MAX_LENGTH).optional(),
})

const WORKSPACE_NAME_MAX_LENGTH = 100

const workspaceName = z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH)
// Registered workspaces are an input-assistance list of real directories, so
// (unlike a TODO's own workspacePath, which can be left unset) a path is
// always required — otherwise identical (max length + absolute-path check)
// to nullableWorkspacePath/dispatchRequestSchema's workspacePath above.
const workspacePathAbsolute = z
  .string()
  .trim()
  .min(1)
  .max(WORKSPACE_PATH_MAX_LENGTH)
  .refine(isAbsolutePath, ABSOLUTE_PATH_MESSAGE)

export const createWorkspaceSchema = z.object({
  name: workspaceName,
  path: workspacePathAbsolute,
})

export const updateWorkspaceSchema = z.object({
  name: workspaceName.optional(),
  path: workspacePathAbsolute.optional(),
})

export const updateSettingsSchema = z
  .object({
    uploadDir: z.string().trim().min(1).max(1000).optional(),
    // 範囲は idleRecapService.ts の MIN/MAX と同じ(1分〜24時間)
    idleRecapMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .refine((v) => v.uploadDir !== undefined || v.idleRecapMinutes !== undefined, {
    message: '変更する項目を指定してください',
  })

export const createPromptSnippetSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1).max(4000),
})

export const updatePromptSnippetSchema = z.object({
  title: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1).max(4000).optional(),
})
