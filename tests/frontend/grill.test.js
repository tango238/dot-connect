import { describe, expect, test } from 'bun:test'
import { grillButton } from '../../public/js/lib/grill.js'

describe('grillButton', () => {
  test('done todos get none', () => {
    expect(grillButton({ status: 'done', grillDir: null, sessionState: null })).toBeNull()
    expect(grillButton({ status: 'done', grillDir: '/x', sessionState: 'idle' })).toBeNull()
  })
  test('a normal task session gets none', () => {
    expect(grillButton({ status: 'open', grillDir: null, sessionState: 'working' })).toBeNull()
  })
  test('grillDir set -> Grilled, even if the session died', () => {
    for (const sessionState of ['working', 'idle', null]) {
      const b = grillButton({ status: 'open', grillDir: '/tmp/g', sessionState })
      expect(b.action).toBe('grilled')
      expect(b.label).toBe('Grilled')
      expect(b.title.length).toBeGreaterThan(0)
    }
  })
  test('no session, no grillDir -> Grill', () => {
    const b = grillButton({ status: 'open', grillDir: null, sessionState: null })
    expect(b.action).toBe('grill')
    expect(b.label).toBe('Grill me')
  })
  test('missing grillDir (older payload) behaves like null', () => {
    expect(grillButton({ status: 'open', sessionState: null }).action).toBe('grill')
  })
})
