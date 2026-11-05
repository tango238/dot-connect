import { describe, expect, test } from 'bun:test'
import { grillButton, isGrilled, weekGoalButton } from '../../public/js/lib/grill.js'

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
    expect(b.label).toBe('プロンプトを作成')
  })
  test('a Grilled todo gets no Grill button (the row offers 目標に登録 instead)', () => {
    expect(grillButton({ status: 'open', grillDir: null, sessionState: null, grilledAt: '2026-11-01 00:00:00' })).toBeNull()
  })
  test('missing grillDir (older payload) behaves like null', () => {
    expect(grillButton({ status: 'open', sessionState: null }).action).toBe('grill')
  })
})

describe('isGrilled / weekGoalButton', () => {
  const grilled = { id: 7, status: 'open', grillDir: null, sessionState: null, grilledAt: '2026-11-01 00:00:00' }
  test('isGrilled needs grilledAt and no grill in progress', () => {
    expect(isGrilled(grilled)).toBe(true)
    expect(isGrilled({ ...grilled, grillDir: '/g' })).toBe(false)
    expect(isGrilled({ ...grilled, grilledAt: null })).toBe(false)
    expect(isGrilled(undefined)).toBe(false)
  })
  test('offers 目標に登録 (herdr) for a grilled todo, 目標に登録 (self) for an ungrilled one, and the registered mark when queued', () => {
    expect(weekGoalButton(grilled, [])).toMatchObject({ registered: false, action: 'add-to-week', label: '目標に登録' })
    expect(weekGoalButton(grilled, [7])).toMatchObject({ registered: true, label: '今週の目標' })
    expect(weekGoalButton({ ...grilled, status: 'done' }, [])).toBeNull()
    expect(weekGoalButton({ ...grilled, grilledAt: null }, [])).toMatchObject({ registered: false, self: true, action: 'add-to-week', label: '目標に登録' })
    expect(weekGoalButton({ ...grilled, grilledAt: null }, [7])).toMatchObject({ registered: true })
    expect(weekGoalButton({ ...grilled, sessionState: 'working' }, [])).toBeNull()
    expect(weekGoalButton({ ...grilled, grillDir: '/g' }, [])).toBeNull()
  })
})
