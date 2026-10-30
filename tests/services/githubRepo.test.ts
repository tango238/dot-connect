import { describe, expect, test } from 'bun:test'
import { parseRepoSpec } from '../../src/services/githubRepo'

describe('parseRepoSpec', () => {
  test('parses "owner/repo"', () => {
    expect(parseRepoSpec('acme/my-app')).toEqual({ owner: 'acme', repo: 'my-app', nameWithOwner: 'acme/my-app' })
  })

  // Whatever the user pastes from the browser's address bar should name the
  // repository the issues are listed from.
  test.each([
    ['repository URL', 'https://github.com/acme/my-app'],
    ['trailing slash', 'https://github.com/acme/my-app/'],
    ['issues page', 'https://github.com/acme/my-app/issues'],
    ['one issue', 'https://github.com/acme/my-app/issues/12'],
    ['file in a branch', 'https://github.com/acme/my-app/tree/main/src'],
    ['clone URL', 'https://github.com/acme/my-app.git'],
    ['www host', 'https://www.github.com/acme/my-app'],
    ['http scheme', 'http://github.com/acme/my-app'],
    ['no scheme', 'github.com/acme/my-app'],
    ['surrounding whitespace', '  acme/my-app  '],
  ])('canonicalizes %s', (_label, input) => {
    expect(parseRepoSpec(input)?.nameWithOwner).toBe('acme/my-app')
  })

  test.each([
    ['empty', ''],
    ['owner only', 'acme'],
    ['three segments', 'acme/my-app/extra'],
    ['space in name', 'acme/my app'],
    ['dot-dot owner', '../my-app'],
    ['another host', 'https://gitlab.com/acme/my-app'],
    ['user page URL', 'https://github.com/acme'],
    ['non-http scheme', 'ssh://github.com/acme/my-app'],
  ])('rejects %s', (_label, input) => {
    expect(parseRepoSpec(input)).toBeNull()
  })
})
