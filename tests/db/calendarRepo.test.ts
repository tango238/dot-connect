import { describe, expect, test } from 'bun:test'
import { createDatabase } from '../../src/db/database'
import * as appSettingsRepo from '../../src/db/appSettingsRepo'
import * as calendarRepo from '../../src/db/calendarRepo'

const URL_A = 'https://calendar.google.com/calendar/ical/me%40example.com/private-abc/basic.ics'

describe('calendarRepo', () => {
  test('create cycles the palette, update/remove work, cache follows the calendar', () => {
    const db = createDatabase(':memory:')
    const a = calendarRepo.create(db, { name: 'a', url: URL_A })
    const b = calendarRepo.create(db, { name: 'b', url: URL_A })
    expect([a.color, b.color]).toEqual([calendarRepo.CALENDAR_PALETTE[0] as string, calendarRepo.CALENDAR_PALETTE[1] as string])
    expect(calendarRepo.update(db, a.id, { name: 'A', color: '#000000' })).toMatchObject({ name: 'A', color: '#000000', url: URL_A })
    expect(calendarRepo.update(db, 99, { name: 'x' })).toBeNull()
    calendarRepo.setCache(db, a.id, { ics: 'BEGIN:VCALENDAR', fetchedAt: '2026-11-03T00:00:00.000Z' })
    expect(calendarRepo.getCache(db, a.id)).toEqual({ ics: 'BEGIN:VCALENDAR', fetchedAt: '2026-11-03T00:00:00.000Z' })
    expect(calendarRepo.remove(db, a.id)).toBe(true)
    expect(calendarRepo.remove(db, a.id)).toBe(false)
    expect(calendarRepo.getCache(db, a.id)).toBeNull()
    expect(calendarRepo.listAll(db).map((c) => c.name)).toEqual(['b'])
  })

  test('migrates the single-URL setting of the first version into one calendar, with its cache, once', () => {
    const db = createDatabase(':memory:')
    appSettingsRepo.set(db, 'calendar_ics_url', URL_A)
    appSettingsRepo.set(db, 'calendar_ics_cache', 'BEGIN:VCALENDAR')
    appSettingsRepo.set(db, 'calendar_ics_fetched_at', '2026-11-01T00:00:00.000Z')
    calendarRepo.migrateLegacySingleCalendar(db)
    const [cal] = calendarRepo.listAll(db)
    expect(cal).toMatchObject({ name: 'Google カレンダー', url: URL_A, color: calendarRepo.CALENDAR_PALETTE[0] })
    expect(calendarRepo.getCache(db, cal!.id)).toEqual({ ics: 'BEGIN:VCALENDAR', fetchedAt: '2026-11-01T00:00:00.000Z' })
    expect(appSettingsRepo.get(db, 'calendar_ics_url')).toBeNull()
    // 二度目は何もしない(キーが消えている)
    calendarRepo.migrateLegacySingleCalendar(db)
    expect(calendarRepo.listAll(db)).toHaveLength(1)
  })

  test('does not add a second calendar when one already exists, but still clears the old keys', () => {
    const db = createDatabase(':memory:')
    calendarRepo.create(db, { name: 'existing', url: URL_A })
    appSettingsRepo.set(db, 'calendar_ics_url', URL_A)
    calendarRepo.migrateLegacySingleCalendar(db)
    expect(calendarRepo.listAll(db)).toHaveLength(1)
    expect(appSettingsRepo.get(db, 'calendar_ics_url')).toBeNull()
  })
})
