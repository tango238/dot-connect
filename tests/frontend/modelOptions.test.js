import { describe, expect, test } from 'bun:test'
import { buildModelSelectChoices, resolveModelSelectValue } from '../../public/js/lib/modelOptions.js'

describe('buildModelSelectChoices', () => {
  test('prefixes an explicit default/unspecified choice', () => {
    expect(buildModelSelectChoices(['opus', 'sonnet'])).toEqual([
      { value: '', label: '既定(未指定)' },
      { value: 'opus', label: 'opus' },
      { value: 'sonnet', label: 'sonnet' },
    ])
  })

  test('handles an empty model list', () => {
    expect(buildModelSelectChoices([])).toEqual([{ value: '', label: '既定(未指定)' }])
  })
})

describe('resolveModelSelectValue', () => {
  const models = ['opus', 'sonnet', 'haiku', 'fable']

  test('returns the saved model as-is when it is allowed', () => {
    expect(resolveModelSelectValue('opus', models)).toBe('opus')
  })

  test('resolves null to the blank/default value', () => {
    expect(resolveModelSelectValue(null, models)).toBe('')
  })

  test('resolves a saved model no longer in the allowlist to the blank/default value (F2)', () => {
    expect(resolveModelSelectValue('fable', ['opus'])).toBe('')
  })

  test('treats an empty allowlist as nothing being allowed', () => {
    expect(resolveModelSelectValue('opus', [])).toBe('')
  })
})
