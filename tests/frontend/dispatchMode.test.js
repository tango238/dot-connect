import { describe, expect, test } from 'bun:test'
import { DISPATCH_MODE_OPTIONS, dispatchDecision, dispatchModeLabel, dispatchModeNote, isHerdrTask } from '../../public/js/lib/dispatchMode.js'

const base = { dispatchMode: null, workspacePath: null, grilledAt: null }

describe('dispatchDecision / isHerdrTask', () => {
  test('explicit mode wins over everything', () => {
    expect(dispatchDecision({ ...base, dispatchMode: 'herdr' })).toMatchObject({ herdr: true, mode: 'herdr' })
    expect(dispatchDecision({ ...base, dispatchMode: 'self', workspacePath: '/w', grilledAt: '2026-11-01 00:00:00' })).toMatchObject({ herdr: false, mode: 'self' })
  })
  test('auto: a workspace or Grilled makes it herdr, neither makes it self', () => {
    expect(dispatchDecision({ ...base, workspacePath: '/w' })).toMatchObject({ herdr: true, mode: 'auto', reason: '作業ディレクトリあり' })
    expect(dispatchDecision({ ...base, grilledAt: '2026-11-01 00:00:00' })).toMatchObject({ herdr: true, mode: 'auto', reason: 'Grilled 済み' })
    expect(dispatchDecision(base)).toMatchObject({ herdr: false, mode: 'auto' })
    expect(isHerdrTask({ ...base, workspacePath: '/w' })).toBe(true)
    expect(isHerdrTask(base)).toBe(false)
    expect(isHerdrTask(undefined)).toBe(false)
  })
  test('older payloads without dispatchMode behave as auto', () => {
    expect(isHerdrTask({ workspacePath: '/w' })).toBe(true)
    expect(isHerdrTask({})).toBe(false)
  })
})

describe('dispatchModeNote / dispatchModeLabel / options', () => {
  test('note only for auto', () => {
    expect(dispatchModeNote({ ...base, workspacePath: '/w' })).toBe('いまは herdr(作業ディレクトリあり)')
    expect(dispatchModeNote(base)).toBe('いまは 自分(作業ディレクトリも Grilled も無し)')
    expect(dispatchModeNote({ ...base, dispatchMode: 'self' })).toBeNull()
  })
  test('labels follow the options', () => {
    expect(DISPATCH_MODE_OPTIONS.map((o) => o.value)).toEqual(['', 'herdr', 'self'])
    expect(dispatchModeLabel(null)).toBe('自動')
    expect(dispatchModeLabel('herdr')).toBe('herdr に投入')
    expect(dispatchModeLabel('self')).toBe('自分でやる')
  })
})
