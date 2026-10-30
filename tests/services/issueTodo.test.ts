import { describe, expect, test } from 'bun:test'
import type { IssueSummary } from '../../src/services/githubIssueService'
import { buildIssueTodoInput, ISSUE_DESCRIPTION_MAX_LENGTH, ISSUE_TITLE_MAX_LENGTH } from '../../src/services/issueTodo'

const issue: IssueSummary = {
  number: 12,
  title: 'Login fails on Safari',
  body: 'Steps to reproduce…',
  state: 'open',
  url: 'https://github.com/acme/my-app/issues/12',
  labels: [],
  updatedAt: '2026-10-20T01:02:03Z',
}

describe('buildIssueTodoInput', () => {
  test('uses the issue title and puts the URL on the first line of the description', () => {
    expect(buildIssueTodoInput(issue)).toEqual({
      title: 'Login fails on Safari',
      description: 'https://github.com/acme/my-app/issues/12\n\nSteps to reproduce…',
      milestoneId: null,
      priority: 'none',
      workspacePath: null,
      model: null,
    })
  })

  test('keeps just the URL when the issue has no body', () => {
    expect(buildIssueTodoInput({ ...issue, body: '  \n' }).description).toBe(issue.url)
  })

  test('falls back to the issue number when the title is blank', () => {
    expect(buildIssueTodoInput({ ...issue, title: '   ' }).title).toBe('Issue #12')
  })

  test('applies the shared defaults to every TODO', () => {
    const input = buildIssueTodoInput(issue, { milestoneId: 3, priority: 'high', workspacePath: '/w', model: 'opus' })
    expect(input).toMatchObject({ milestoneId: 3, priority: 'high', workspacePath: '/w', model: 'opus' })
  })

  // The TODO is inserted directly, not through createTodoSchema, so the same
  // bounds have to hold here.
  test('truncates an oversized title and description with an ellipsis', () => {
    const input = buildIssueTodoInput({ ...issue, title: 'x'.repeat(500), body: 'y'.repeat(10_000) })
    expect(input.title.length).toBe(ISSUE_TITLE_MAX_LENGTH)
    expect(input.title.endsWith('…')).toBe(true)
    expect(input.description!.length).toBe(ISSUE_DESCRIPTION_MAX_LENGTH)
    expect(input.description!.startsWith(issue.url)).toBe(true)
    expect(input.description!.endsWith('…')).toBe(true)
  })
})
