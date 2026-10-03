import { describe, expect, test } from 'bun:test'
import { buildWorkspaceDatalistOptions } from '../../public/js/lib/workspaceOptions.js'

describe('buildWorkspaceDatalistOptions', () => {
  test('maps each workspace to its path (value) and name (label)', () => {
    const workspaces = [{ id: 1, name: 'my-app', path: '/Users/you/projects/my-app' }]
    expect(buildWorkspaceDatalistOptions(workspaces)).toEqual([
      { value: '/Users/you/projects/my-app', label: 'my-app' },
    ])
  })

  test('sorts by name', () => {
    const workspaces = [
      { id: 1, name: 'zeta', path: '/z' },
      { id: 2, name: 'alpha', path: '/a' },
    ]
    expect(buildWorkspaceDatalistOptions(workspaces)).toEqual([
      { value: '/a', label: 'alpha' },
      { value: '/z', label: 'zeta' },
    ])
  })

  test('does not mutate the input array', () => {
    const workspaces = [
      { id: 1, name: 'zeta', path: '/z' },
      { id: 2, name: 'alpha', path: '/a' },
    ]
    buildWorkspaceDatalistOptions(workspaces)
    expect(workspaces[0].name).toBe('zeta')
  })

  test('handles an empty list', () => {
    expect(buildWorkspaceDatalistOptions([])).toEqual([])
  })
})
