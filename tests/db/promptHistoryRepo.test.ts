import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as promptHistoryRepo from '../../src/db/promptHistoryRepo'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

describe('promptHistoryRepo.recordUse / listAll', () => {
  test('records a use and it shows up in listAll', () => {
    promptHistoryRepo.recordUse(db, 'Fix the login bug')
    const all = promptHistoryRepo.listAll(db)
    expect(all.length).toBe(1)
    expect(all[0]?.body).toBe('Fix the login bug')
    expect(all[0]?.usedAt).not.toBeNull()
  })

  test('listAll returns an empty array when there is no history', () => {
    expect(promptHistoryRepo.listAll(db)).toEqual([])
  })

  test('listAll orders by most-recently-used first', () => {
    promptHistoryRepo.recordUse(db, 'oldest')
    promptHistoryRepo.recordUse(db, 'middle')
    promptHistoryRepo.recordUse(db, 'newest')
    const bodies = promptHistoryRepo.listAll(db).map((h) => h.body)
    expect(bodies).toEqual(['newest', 'middle', 'oldest'])
  })

  test('re-using the same body deduplicates it and bumps it to the top', () => {
    promptHistoryRepo.recordUse(db, 'a')
    promptHistoryRepo.recordUse(db, 'b')
    promptHistoryRepo.recordUse(db, 'c')
    promptHistoryRepo.recordUse(db, 'a') // re-use 'a'

    const all = promptHistoryRepo.listAll(db)
    expect(all.length).toBe(3) // no duplicate row for 'a'
    expect(all.map((h) => h.body)).toEqual(['a', 'c', 'b'])
  })

  test('caps history at 50 entries, dropping the oldest', () => {
    for (let i = 0; i < 51; i++) {
      promptHistoryRepo.recordUse(db, `prompt-${i}`)
    }
    const all = promptHistoryRepo.listAll(db)
    expect(all.length).toBe(50)
    // prompt-0 (the oldest) should have been evicted; prompt-50 (the
    // newest) should be present and first.
    expect(all.some((h) => h.body === 'prompt-0')).toBe(false)
    expect(all[0]?.body).toBe('prompt-50')
  })

  test('re-using an existing body when already at 50 entries does not evict anything extra', () => {
    for (let i = 0; i < 50; i++) {
      promptHistoryRepo.recordUse(db, `prompt-${i}`)
    }
    promptHistoryRepo.recordUse(db, 'prompt-0') // re-use the oldest, bumping it to newest

    const all = promptHistoryRepo.listAll(db)
    expect(all.length).toBe(50)
    expect(all[0]?.body).toBe('prompt-0')
    // Nothing should have been evicted beyond the dedup of prompt-0 itself.
    expect(all.some((h) => h.body === 'prompt-1')).toBe(true)
  })
})

describe('promptHistoryRepo.removeAll', () => {
  test('deletes everything and returns the count removed', () => {
    promptHistoryRepo.recordUse(db, 'a')
    promptHistoryRepo.recordUse(db, 'b')
    expect(promptHistoryRepo.removeAll(db)).toBe(2)
    expect(promptHistoryRepo.listAll(db)).toEqual([])
  })

  test('returns 0 when history is already empty', () => {
    expect(promptHistoryRepo.removeAll(db)).toBe(0)
  })
})
