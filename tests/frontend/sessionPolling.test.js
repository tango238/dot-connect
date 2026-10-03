import { describe, expect, test } from 'bun:test'
import { hasLinkedSession } from '../../public/js/lib/sessionPolling.js'

function todo(overrides) {
  return { herdrPaneId: null, status: 'open', sessionState: null, ...overrides }
}

describe('hasLinkedSession', () => {
  test('a todo with a pane in "blocked" state polls (regression: this was broken)', () => {
    expect(hasLinkedSession([todo({ herdrPaneId: 'w1G:p1', sessionState: 'blocked' })])).toBe(true)
  })

  test('a todo with a pane in "idle" state polls', () => {
    expect(hasLinkedSession([todo({ herdrPaneId: 'w1G:p1', sessionState: 'idle' })])).toBe(true)
  })

  test('a todo with a pane in "working" state polls', () => {
    expect(hasLinkedSession([todo({ herdrPaneId: 'w1G:p1', sessionState: 'working' })])).toBe(true)
  })

  test('a done todo with a pane does not poll', () => {
    expect(hasLinkedSession([todo({ herdrPaneId: 'w1G:p1', sessionState: 'blocked', status: 'done' })])).toBe(false)
  })

  test('a todo without a pane does not poll', () => {
    expect(hasLinkedSession([todo({ herdrPaneId: null, sessionState: null })])).toBe(false)
  })

  test('an empty list does not poll', () => {
    expect(hasLinkedSession([])).toBe(false)
  })

  test('polls if any todo in a mixed list qualifies', () => {
    expect(
      hasLinkedSession([
        todo({ herdrPaneId: null }),
        todo({ herdrPaneId: 'w1G:p1', status: 'done' }),
        todo({ herdrPaneId: 'w1G:p2', sessionState: 'blocked' }),
      ]),
    ).toBe(true)
  })
})
