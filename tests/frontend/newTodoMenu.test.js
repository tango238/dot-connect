import { describe, expect, test } from 'bun:test'
import { newTodoMenuItems, skillSessionDisabledReason } from '../../public/js/lib/newTodoMenu.js'

const ready = { capabilities: { dispatch: true, sessionFocus: true, mcpBinPath: null }, settings: { skill: { state: 'installed' } } }

describe('skillSessionDisabledReason', () => {
  test('usable when herdr works and the skill is installed (or outdated)', () => {
    expect(skillSessionDisabledReason(ready)).toBeNull()
    expect(skillSessionDisabledReason({ ...ready, settings: { skill: { state: 'outdated' } } })).toBeNull()
  })
  test('unknown capabilities/settings are treated as usable', () => {
    expect(skillSessionDisabledReason({ capabilities: null, settings: null })).toBeNull()
    expect(skillSessionDisabledReason({ capabilities: undefined, settings: { } })).toBeNull()
  })
  test('herdr unavailable wins over the skill state', () => {
    const reason = skillSessionDisabledReason({ capabilities: { dispatch: false }, settings: { skill: { state: 'not_installed' } } })
    expect(reason).toContain('herdr')
  })
  test('skill not installed names the settings dialog', () => {
    const reason = skillSessionDisabledReason({ ...ready, settings: { skill: { state: 'not_installed' } } })
    expect(reason).toContain('スキル')
    expect(reason).toContain('設定')
  })
})

describe('newTodoMenuItems', () => {
  test('offers the form first, then the GitHub issue import, then the skill session', () => {
    const items = newTodoMenuItems(ready)
    expect(items.map((i) => i.action)).toEqual(['form', 'github-issues', 'skill-session'])
    expect(items.every((i) => i.label.length > 0 && i.hint.length > 0)).toBe(true)
    expect(items.every((i) => i.disabled === false)).toBe(true)
    expect(items[2].title).toBeUndefined()
  })
  test('greys out only the skill session, with the reason as its title', () => {
    const items = newTodoMenuItems({ capabilities: { dispatch: false }, settings: null })
    expect(items[0].disabled).toBe(false)
    // The issue import does not need herdr — only gh, which the server checks.
    expect(items[1].disabled).toBe(false)
    expect(items[2].disabled).toBe(true)
    expect(items[2].title).toContain('herdr')
  })
})
