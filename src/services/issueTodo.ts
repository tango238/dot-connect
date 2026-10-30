import type { CreateTodoInput } from '../db/todoRepo'
import type { IssueSummary } from './githubIssueService'

// How a GitHub issue becomes a TODO. Pure, so the shape (and the truncation
// to the same limits createTodoSchema enforces) is testable without gh.

// Mirrors TITLE_MAX_LENGTH / todoDescription's max in api/schemas.ts — the
// TODO is inserted directly, not via the HTTP schema, so the bounds are
// applied here.
export const ISSUE_TITLE_MAX_LENGTH = 200
export const ISSUE_DESCRIPTION_MAX_LENGTH = 4000

const TRUNCATION_MARK = '…'

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, max - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`
}

export interface IssueTodoDefaults {
  readonly milestoneId?: number | null
  readonly workspacePath?: string | null
  readonly model?: string | null
  readonly priority?: CreateTodoInput['priority']
}

/**
 * The issue URL goes on the description's first line — that is the one
 * piece that must survive, both so the TODO stays traceable back to the
 * issue and so a later import can see the issue is already here (the
 * frontend matches on exactly this line).
 */
export function buildIssueTodoInput(issue: IssueSummary, defaults: IssueTodoDefaults = {}): CreateTodoInput {
  const title = truncate(issue.title.trim() || `Issue #${issue.number}`, ISSUE_TITLE_MAX_LENGTH)
  const body = issue.body.trim()
  const description = truncate(body ? `${issue.url}\n\n${body}` : issue.url, ISSUE_DESCRIPTION_MAX_LENGTH)
  return {
    title,
    description,
    milestoneId: defaults.milestoneId ?? null,
    priority: defaults.priority ?? 'none',
    workspacePath: defaults.workspacePath ?? null,
    model: defaults.model ?? null,
  }
}
