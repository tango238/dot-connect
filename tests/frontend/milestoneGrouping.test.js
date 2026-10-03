import { describe, expect, test } from 'bun:test'
import { groupMilestonesByLabel } from '../../public/js/lib/milestoneGrouping.js'

function m(id, labelId, labelName, labelColor) {
  return { id, labelId, labelName, labelColor, title: `M${id}` }
}

describe('groupMilestonesByLabel', () => {
  test('returns an empty array for no milestones', () => {
    expect(groupMilestonesByLabel([])).toEqual([])
  })

  test('all-unlabeled milestones form a single trailing group', () => {
    const groups = groupMilestonesByLabel([m(1, null, null, null), m(2, null, null, null)])
    expect(groups).toEqual([
      { labelId: null, labelName: null, labelColor: null, milestones: [m(1, null, null, null), m(2, null, null, null)] },
    ])
  })

  test('groups milestones sharing the same label together', () => {
    const groups = groupMilestonesByLabel([
      m(1, 5, 'バックエンド', '#6ca4f8'),
      m(2, 5, 'バックエンド', '#6ca4f8'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].labelId).toBe(5)
    expect(groups[0].milestones.map((x) => x.id)).toEqual([1, 2])
  })

  test('sorts labeled groups by label name ascending', () => {
    const groups = groupMilestonesByLabel([
      m(1, 2, 'フロントエンド', '#d29af5'),
      m(2, 1, 'バックエンド', '#6ca4f8'),
    ])
    expect(groups.map((g) => g.labelName)).toEqual(['バックエンド', 'フロントエンド'])
  })

  test('unlabeled group comes after every labeled group', () => {
    const groups = groupMilestonesByLabel([
      m(1, null, null, null),
      m(2, 1, 'バックエンド', '#6ca4f8'),
    ])
    expect(groups.map((g) => g.labelId)).toEqual([1, null])
  })

  test('omits the unlabeled group entirely when nothing is unlabeled', () => {
    const groups = groupMilestonesByLabel([m(1, 1, 'バックエンド', '#6ca4f8')])
    expect(groups.some((g) => g.labelId === null)).toBe(false)
  })

  test('preserves relative order of milestones within a group', () => {
    const groups = groupMilestonesByLabel([
      m(3, 1, 'バックエンド', '#6ca4f8'),
      m(1, 1, 'バックエンド', '#6ca4f8'),
      m(2, 1, 'バックエンド', '#6ca4f8'),
    ])
    expect(groups[0].milestones.map((x) => x.id)).toEqual([3, 1, 2])
  })
})
