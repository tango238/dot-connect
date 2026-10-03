import { describe, expect, test } from 'bun:test'
import {
  buildModelCreatePatch,
  buildModelDispatchPatch,
  buildModelEditPatch,
  needsModelResetBeforeDispatch,
} from '../../public/js/lib/modelPatch.js'

describe('buildModelCreatePatch', () => {
  test('returns the model when a value is selected', () => {
    expect(buildModelCreatePatch('opus')).toEqual({ model: 'opus' })
  })

  test('omits the field entirely when the default/unspecified option is selected', () => {
    expect(buildModelCreatePatch('')).toEqual({})
  })
})

describe('buildModelEditPatch', () => {
  test('returns the model when a value is selected', () => {
    expect(buildModelEditPatch('sonnet')).toEqual({ model: 'sonnet' })
  })

  test('sends an explicit null to clear back to the default', () => {
    expect(buildModelEditPatch('')).toEqual({ model: null })
  })
})

describe('buildModelDispatchPatch', () => {
  test('returns the model override when selected', () => {
    expect(buildModelDispatchPatch('haiku')).toEqual({ model: 'haiku' })
  })

  test('omits the field when no override is selected (falls back to the saved model)', () => {
    expect(buildModelDispatchPatch('')).toEqual({})
  })
})

describe('needsModelResetBeforeDispatch', () => {
  test('true when the default is picked but the todo has a saved model', () => {
    expect(needsModelResetBeforeDispatch('', 'opus')).toBe(true)
  })

  test('false when the default is picked and the todo has no saved model (nothing to reset)', () => {
    expect(needsModelResetBeforeDispatch('', null)).toBe(false)
  })

  test('false when a specific model is selected, regardless of the saved value', () => {
    expect(needsModelResetBeforeDispatch('sonnet', 'opus')).toBe(false)
    expect(needsModelResetBeforeDispatch('sonnet', null)).toBe(false)
  })
})
