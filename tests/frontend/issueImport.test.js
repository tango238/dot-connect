import { describe, expect, test } from 'bun:test'
import {
  importButtonLabel,
  importResultMessage,
  importedTodosByIssue,
  isIssueSelectable,
  labelColor,
  loadRememberedRepos,
  MAX_REMEMBERED_REPOS,
  parseRepoInput,
  rememberRepo,
  saveRememberedRepos,
} from '../../public/js/lib/issueImport.js'

describe('parseRepoInput', () => {
  // Mirrors src/services/githubRepo.ts — same inputs must agree.
  test.each([
    ['owner/repo', 'acme/my-app'],
    ['repository URL', 'https://github.com/acme/my-app'],
    ['issue URL', 'https://github.com/acme/my-app/issues/12'],
    ['clone URL', 'https://github.com/acme/my-app.git'],
    ['no scheme', 'github.com/acme/my-app'],
    ['whitespace', '  acme/my-app '],
  ])('accepts %s', (_label, input) => {
    expect(parseRepoInput(input)).toBe('acme/my-app')
  })
  test.each([
    ['empty', ''],
    ['undefined', undefined],
    ['owner only', 'acme'],
    ['three segments', 'a/b/c'],
    ['another host', 'https://gitlab.com/a/b'],
    ['space', 'acme/my app'],
  ])('rejects %s', (_label, input) => {
    expect(parseRepoInput(input)).toBeNull()
  })
})

describe('importedTodosByIssue', () => {
  const issues = [
    { number: 1, url: 'https://github.com/o/r/issues/1' },
    { number: 12, url: 'https://github.com/o/r/issues/12' },
    { number: 3, url: 'https://github.com/o/r/issues/3' },
  ]
  test('matches a TODO whose description carries the issue URL, open or done', () => {
    const todos = [
      { id: 7, status: 'open', description: 'https://github.com/o/r/issues/12\n\nbody' },
      { id: 8, status: 'done', description: 'see https://github.com/o/r/issues/3 for details' },
    ]
    const map = importedTodosByIssue(issues, todos)
    expect(map.get(12)).toEqual({ todoId: 7, done: false })
    expect(map.get(3)).toEqual({ todoId: 8, done: true })
    expect(map.has(1)).toBe(false)
  })
  test('does not let ".../issues/1" match a TODO for ".../issues/12"', () => {
    const todos = [{ id: 7, status: 'open', description: 'https://github.com/o/r/issues/12' }]
    expect(importedTodosByIssue(issues, todos).has(1)).toBe(false)
  })
  test('finds the URL even when a longer-numbered one appears first', () => {
    const todos = [{ id: 7, status: 'open', description: 'https://github.com/o/r/issues/12 and https://github.com/o/r/issues/1' }]
    expect(importedTodosByIssue(issues, todos).get(1)).toEqual({ todoId: 7, done: false })
  })
  test('tolerates TODOs without a description', () => {
    expect(importedTodosByIssue(issues, [{ id: 1, status: 'open' }]).size).toBe(0)
  })
})

describe('isIssueSelectable', () => {
  test('a fresh issue and one whose TODO is done can be ticked; an open TODO locks it', () => {
    expect(isIssueSelectable(undefined)).toBe(true)
    expect(isIssueSelectable({ todoId: 1, done: true })).toBe(true)
    expect(isIssueSelectable({ todoId: 1, done: false })).toBe(false)
  })
})

describe('remembered repos', () => {
  test('rememberRepo puts the latest first, dedupes, and bounds the list', () => {
    expect(rememberRepo(['a/b', 'c/d'], 'c/d')).toEqual(['c/d', 'a/b'])
    const many = Array.from({ length: MAX_REMEMBERED_REPOS }, (_, i) => `o/r${i}`)
    const next = rememberRepo(many, 'o/new')
    expect(next.length).toBe(MAX_REMEMBERED_REPOS)
    expect(next[0]).toBe('o/new')
    expect(next).not.toContain(`o/r${MAX_REMEMBERED_REPOS - 1}`)
  })
  test('round-trips through storage and survives garbage/missing storage', () => {
    const store = new Map()
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
    saveRememberedRepos(storage, ['a/b'])
    expect(loadRememberedRepos(storage)).toEqual(['a/b'])
    store.set('dot-connect.issueImport.repos', '{not json')
    expect(loadRememberedRepos(storage)).toEqual([])
    store.set('dot-connect.issueImport.repos', JSON.stringify([1, 'x/y']))
    expect(loadRememberedRepos(storage)).toEqual(['x/y'])
    expect(loadRememberedRepos(null)).toEqual([])
    expect(() => saveRememberedRepos({ setItem: () => { throw new Error('quota') } }, ['a/b'])).not.toThrow()
  })
})

describe('labelColor', () => {
  test('prefixes bare hex and falls back on anything else', () => {
    expect(labelColor('d73a4a')).toBe('#d73a4a')
    expect(labelColor('red')).toBe('#8b93a7')
    expect(labelColor(undefined)).toBe('#8b93a7')
  })
})

describe('importResultMessage / importButtonLabel', () => {
  test('all created → plain success with the count', () => {
    expect(importResultMessage({ created: [{}, {}], failed: [] })).toEqual({ message: '2件の Issue を TODO に取り込みました', warning: false })
  })
  test('partial failure names the failed numbers and the first reason', () => {
    const r = importResultMessage({ created: [{}], failed: [{ number: 4, error: 'nope' }, { number: 9, error: 'x' }] })
    expect(r.warning).toBe(true)
    expect(r.message).toContain('1件を取り込みました')
    expect(r.message).toContain('#4, #9')
    expect(r.message).toContain('nope')
  })
  test('total failure omits the created count', () => {
    expect(importResultMessage({ created: [], failed: [{ number: 4, error: 'nope' }] }).message.startsWith('#4')).toBe(true)
  })
  test('button label reflects the selection', () => {
    expect(importButtonLabel(0)).toContain('選んで')
    expect(importButtonLabel(3)).toContain('3 件')
  })
})
