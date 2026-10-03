import { describe, expect, test } from 'bun:test'
import { parsePullRequestUrl } from '../../src/services/pullRequestUrl'

describe('parsePullRequestUrl', () => {
  test('parses a plain PR URL into its parts', () => {
    expect(parsePullRequestUrl('https://github.com/acme/my-app/pull/123')).toEqual({
      url: 'https://github.com/acme/my-app/pull/123',
      owner: 'acme',
      repo: 'my-app',
      number: 123,
    })
  })

  // The canonical form is what todo_pull_requests enforces uniqueness on, so
  // every way GitHub's own UI hands out a PR link has to collapse onto it.
  test.each([
    ['trailing slash', 'https://github.com/o/r/pull/7/'],
    ['files tab', 'https://github.com/o/r/pull/7/files'],
    ['commits tab', 'https://github.com/o/r/pull/7/commits'],
    ['review comment fragment', 'https://github.com/o/r/pull/7#discussion_r12345'],
    ['query string', 'https://github.com/o/r/pull/7?w=1'],
    ['www host', 'https://www.github.com/o/r/pull/7'],
    ['http scheme', 'http://github.com/o/r/pull/7'],
    ['surrounding whitespace', '  https://github.com/o/r/pull/7  '],
  ])('canonicalizes %s', (_label, input) => {
    expect(parsePullRequestUrl(input)?.url).toBe('https://github.com/o/r/pull/7')
  })

  test.each([
    ['not a URL at all', 'my-app#123'],
    ['an issue, not a PR', 'https://github.com/o/r/issues/7'],
    ['a repo root', 'https://github.com/o/r'],
    ['a non-github host', 'https://gitlab.com/o/r/pull/7'],
    ['a GitHub Enterprise host', 'https://github.example.com/o/r/pull/7'],
    ['a non-http scheme', 'javascript:alert(1)'],
    ['a missing PR number', 'https://github.com/o/r/pull/'],
    ['a non-numeric PR number', 'https://github.com/o/r/pull/abc'],
    ['PR number zero', 'https://github.com/o/r/pull/0'],
    ['a traversal-shaped owner', 'https://github.com/../r/pull/7'],
    ['an empty string', ''],
  ])('rejects %s', (_label, input) => {
    expect(parsePullRequestUrl(input)).toBeNull()
  })

  test('keeps owner/repo names that use the full allowed character set', () => {
    const parsed = parsePullRequestUrl('https://github.com/my-org/some.repo_v2/pull/9')
    expect(parsed).toEqual({
      url: 'https://github.com/my-org/some.repo_v2/pull/9',
      owner: 'my-org',
      repo: 'some.repo_v2',
      number: 9,
    })
  })
})
