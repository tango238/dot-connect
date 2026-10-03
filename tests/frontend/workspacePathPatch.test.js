import { describe, expect, test } from 'bun:test'
import {
  buildWorkspacePathCreatePatch,
  buildWorkspacePathEditPatch,
} from '../../public/js/lib/workspacePathPatch.js'

describe('buildWorkspacePathCreatePatch', () => {
  test('returns the path when a value is present', () => {
    expect(buildWorkspacePathCreatePatch('/Users/you/projects/my-app')).toEqual({
      workspacePath: '/Users/you/projects/my-app',
    })
  })

  test('trims surrounding whitespace', () => {
    expect(buildWorkspacePathCreatePatch('  /a/b  ')).toEqual({ workspacePath: '/a/b' })
  })

  test('omits the field entirely for an empty string (nothing to clear on create)', () => {
    expect(buildWorkspacePathCreatePatch('')).toEqual({})
  })
})

describe('buildWorkspacePathEditPatch', () => {
  test('returns the trimmed path when a value is present', () => {
    expect(buildWorkspacePathEditPatch('/Users/you/projects/my-app')).toEqual({
      workspacePath: '/Users/you/projects/my-app',
    })
  })

  test('trims surrounding whitespace', () => {
    expect(buildWorkspacePathEditPatch('  /a/b  ')).toEqual({ workspacePath: '/a/b' })
  })

  test('sends an explicit null to clear when the field is emptied', () => {
    expect(buildWorkspacePathEditPatch('')).toEqual({ workspacePath: null })
  })
})
