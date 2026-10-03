import { describe, expect, test } from 'bun:test'
import {
  isSidebarCollapsed,
  persistSidebarCollapsed,
  SIDEBAR_STORAGE_KEY,
} from '../../public/js/lib/sidebarState.js'

function fakeStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    },
    data,
  }
}

describe('isSidebarCollapsed', () => {
  test('defaults to expanded when nothing is stored (first visit)', () => {
    expect(isSidebarCollapsed(fakeStorage())).toBe(false)
  })

  test('defaults to expanded for a corrupted/unexpected value', () => {
    expect(isSidebarCollapsed(fakeStorage({ [SIDEBAR_STORAGE_KEY]: 'yes' }))).toBe(false)
  })

  test('reads collapsed when persisted as "1"', () => {
    expect(isSidebarCollapsed(fakeStorage({ [SIDEBAR_STORAGE_KEY]: '1' }))).toBe(true)
  })

  test('reads expanded when persisted as "0"', () => {
    expect(isSidebarCollapsed(fakeStorage({ [SIDEBAR_STORAGE_KEY]: '0' }))).toBe(false)
  })
})

describe('persistSidebarCollapsed', () => {
  test('writes "1" for collapsed', () => {
    const storage = fakeStorage()
    persistSidebarCollapsed(storage, true)
    expect(storage.data[SIDEBAR_STORAGE_KEY]).toBe('1')
  })

  test('writes "0" for expanded', () => {
    const storage = fakeStorage({ [SIDEBAR_STORAGE_KEY]: '1' })
    persistSidebarCollapsed(storage, false)
    expect(storage.data[SIDEBAR_STORAGE_KEY]).toBe('0')
  })
})
