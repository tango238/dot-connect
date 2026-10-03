import { describe, expect, test } from 'bun:test'
import {
  pullRequestCount,
  pullRequestHeadline,
  pullRequestLabel,
  pullRequestNotice,
  pullRequestStateBadge,
} from '../../public/js/lib/pullRequest.js'

const pr = (overrides = {}) => ({
  id: 1,
  owner: 'acme',
  repo: 'my-app',
  number: 123,
  title: 'Fix login error handling',
  state: 'open',
  isDraft: false,
  fetchedAt: '2026-08-04 00:00:00',
  fetchError: null,
  ...overrides,
})

describe('pullRequestLabel', () => {
  test('renders owner/repo#number', () => {
    expect(pullRequestLabel(pr())).toBe('acme/my-app#123')
  })
})

describe('pullRequestStateBadge', () => {
  test.each([
    ['open', 'Open'],
    ['merged', 'Merged'],
    ['closed', 'Closed'],
  ])('labels a %s PR as %s', (state, label) => {
    expect(pullRequestStateBadge(pr({ state }))?.label).toBe(label)
  })

  // A draft is not waiting on anyone, so it reads as draft rather than open.
  test('shows draft instead of open for a draft PR', () => {
    expect(pullRequestStateBadge(pr({ state: 'open', isDraft: true })).label).toBe('Draft')
  })

  test('a merged PR is never shown as draft', () => {
    expect(pullRequestStateBadge(pr({ state: 'merged', isDraft: true })).label).toBe('Merged')
  })

  test('returns null when the state was never fetched', () => {
    expect(pullRequestStateBadge(pr({ state: null, isDraft: null }))).toBeNull()
  })
})

describe('pullRequestHeadline', () => {
  test('uses the fetched title when there is one', () => {
    expect(pullRequestHeadline(pr())).toBe('Fix login error handling')
  })

  test('falls back to the identity so a row is never blank', () => {
    expect(pullRequestHeadline(pr({ title: null }))).toBe('acme/my-app#123')
  })
})

describe('pullRequestNotice', () => {
  test('says nothing when the last fetch succeeded', () => {
    expect(pullRequestNotice(pr())).toBeNull()
  })

  test('says the metadata was never fetched when there is no prior success', () => {
    const notice = pullRequestNotice(pr({ title: null, fetchedAt: null, fetchError: 'gh missing' }))
    expect(notice).toContain('取得できませんでした')
    expect(notice).toContain('gh missing')
    expect(notice).not.toContain('前回取得時点')
  })

  // Distinct wording matters: the title on screen is real, just stale.
  test('flags a failed refresh as stale rather than missing', () => {
    expect(pullRequestNotice(pr({ fetchError: 'network down' }))).toContain('前回取得時点')
  })
})

describe('pullRequestCount', () => {
  test('counts linked PRs', () => {
    expect(pullRequestCount({ pullRequests: [pr(), pr({ id: 2 })] })).toBe(2)
  })

  test('is 0 for a todo with none, and for one lacking the field entirely', () => {
    expect(pullRequestCount({ pullRequests: [] })).toBe(0)
    expect(pullRequestCount({})).toBe(0)
  })
})
