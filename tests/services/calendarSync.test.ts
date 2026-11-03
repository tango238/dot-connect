import { describe, expect, test } from 'bun:test'
import { createDatabase } from '../../src/db/database'
import * as calendarRepo from '../../src/db/calendarRepo'
import { createCalendarSync, normalizeIcsUrl, type FetchFn } from '../../src/services/calendarSync'
import { SAMPLE_ICS } from './calendarIcs.test'

const URL_A = 'https://calendar.google.com/calendar/ical/me%40example.com/private-abc/basic.ics'
const URL_B = 'https://calendar.google.com/calendar/ical/team%40example.com/private-def/basic.ics'
const NOW = () => new Date('2026-11-03T03:00:00Z') // JST 12:00

// 2 本目のカレンダー: 11/3 の午後に 1 件だけ。
const SMALL_ICS = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:b1\nDTSTART:20261103T050000Z\nDTEND:20261103T060000Z\nSUMMARY:チーム定例\nEND:VEVENT\nEND:VCALENDAR`

interface FakeFetch {
  readonly fn: FetchFn
  readonly calls: string[]
  respond: (url: string) => Response | Promise<Response>
}

function fakeFetch(respond: FakeFetch['respond'] = (url) => new Response(url === URL_B ? SMALL_ICS : SAMPLE_ICS)): FakeFetch {
  const calls: string[] = []
  const fake: FakeFetch = {
    calls,
    respond,
    fn: async (url) => {
      calls.push(url)
      return fake.respond(url)
    },
  }
  return fake
}

function setup(fetch: FakeFetch, urls: string[] = [URL_A]) {
  const db = createDatabase(':memory:')
  for (const [i, url] of urls.entries()) calendarRepo.create(db, { name: `cal${i + 1}`, url })
  const scheduled: { fn: () => void; ms: number }[] = []
  const sync = createCalendarSync(
    { db, fetch: fetch.fn },
    { now: NOW, zone: 'Asia/Tokyo', schedule: (fn, ms) => (scheduled.push({ fn, ms }), 'h'), cancel: () => undefined }
  )
  return { db, sync, scheduled }
}

describe('normalizeIcsUrl', () => {
  test('webcal becomes https, empty and other schemes are rejected', () => {
    expect(normalizeIcsUrl(` ${URL_A} `)).toEqual({ url: URL_A })
    expect(normalizeIcsUrl('webcal://example.com/cal.ics')).toEqual({ url: 'https://example.com/cal.ics' })
    expect(normalizeIcsUrl('WEBCAL://example.com/cal.ics')).toEqual({ url: 'https://example.com/cal.ics' })
    expect(normalizeIcsUrl('   ')).toMatchObject({ error: expect.stringContaining('入力') })
    expect(normalizeIcsUrl('ftp://example.com/cal.ics')).toMatchObject({ error: expect.stringContaining('https://') })
    expect(normalizeIcsUrl('not a url')).toMatchObject({ error: expect.any(String) })
    expect(normalizeIcsUrl(`https://example.com/${'a'.repeat(2000)}`)).toMatchObject({ error: expect.stringContaining('長すぎます') })
  })
})

describe('createCalendarSync', () => {
  test('with no calendars: refresh does nothing and status says unconfigured', async () => {
    const fetch = fakeFetch()
    const { sync } = setup(fetch, [])
    expect(await sync.refresh()).toEqual({ configured: false, calendars: [], refreshing: false, windowFrom: null, windowTo: null })
    expect(fetch.calls).toEqual([])
    expect(sync.eventsOn('2026-11-03')).toEqual([])
  })

  test('refresh fetches every calendar, tags events with calendar and color, and caches the text', async () => {
    const fetch = fakeFetch()
    const { db, sync } = setup(fetch, [URL_A, URL_B])
    const status = await sync.refresh()
    expect(fetch.calls.sort()).toEqual([URL_A, URL_B].sort())
    expect(status).toMatchObject({ configured: true, refreshing: false, windowFrom: '2026-08-05', windowTo: '2027-11-03' })
    expect(status.calendars.map((c) => [c.name, c.color, c.error, c.fetchedAt])).toEqual([
      ['cal1', '#8b96a5', null, '2026-11-03T03:00:00.000Z'],
      ['cal2', '#6ca4f8', null, '2026-11-03T03:00:00.000Z'],
    ])
    expect(status.calendars[0]!.eventCount).toBeGreaterThan(10)
    expect(status.calendars[1]!.eventCount).toBe(1)

    expect(sync.eventsOn('2026-11-03').map((e) => [e.calendarName, e.color, e.title, e.start, e.end])).toEqual([
      ['cal1', '#8b96a5', '週次ミーティング', '10:00', '11:30'],
      ['cal2', '#6ca4f8', 'チーム定例', '14:00', '15:00'],
    ])
    // id はカレンダーをまたいでも一意
    const ids = sync.eventsOn('2026-11-03').map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)

    // 別インスタンス(再起動)はネットワークに出る前にキャッシュから出せる
    const offline = createCalendarSync({ db, fetch: async () => new Response('x', { status: 500 }) }, { now: NOW, zone: 'Asia/Tokyo' })
    expect(offline.status().calendars.map((c) => [c.fetchedAt, c.error])).toEqual([
      ['2026-11-03T03:00:00.000Z', null],
      ['2026-11-03T03:00:00.000Z', null],
    ])
    expect(offline.eventsOn('2026-11-03')).toHaveLength(2)
  })

  test('a failing calendar keeps its previous events and reports its own error, without the URL', async () => {
    const fetch = fakeFetch()
    const { sync } = setup(fetch, [URL_A, URL_B])
    await sync.refresh()
    fetch.respond = (url) => (url === URL_A ? new Response('nope', { status: 404 }) : new Response(SMALL_ICS))
    const status = await sync.refresh()
    expect(status.calendars.map((c) => c.error)).toEqual(['取得に失敗しました (HTTP 404)', null])
    expect(sync.eventsOn('2026-11-03')).toHaveLength(2)

    fetch.respond = () => {
      throw new Error(`connect failed for ${URL_A}`)
    }
    expect((await sync.refresh()).calendars[0]!.error).toBe('取得に失敗しました: connect failed for <url>')

    fetch.respond = () => new Response('<html>login</html>')
    expect((await sync.refresh()).calendars[0]!.error).toContain('iCal 形式')

    fetch.respond = () => new Response(SAMPLE_ICS)
    expect((await sync.refresh()).calendars[0]!.error).toBeNull()
  })

  test('concurrent refreshes of one calendar share one fetch', async () => {
    const fetch = fakeFetch()
    const { sync } = setup(fetch)
    await Promise.all([sync.refresh(), sync.refresh(1)])
    expect(fetch.calls).toHaveLength(1)
  })

  test('addCalendar fetches right away; updateCalendar refetches only when the URL changes; removeCalendar drops it', async () => {
    const fetch = fakeFetch()
    const { db, sync } = setup(fetch, [])
    const added = await sync.addCalendar({ name: '仕事', url: URL_A })
    expect(fetch.calls).toEqual([URL_A])
    expect(added).toMatchObject({ name: '仕事', color: '#8b96a5', error: null })
    expect(sync.eventsOn('2026-11-03')).toHaveLength(1)

    const renamed = await sync.updateCalendar(added.id, { name: '業務', color: '#123456' })
    expect(renamed).toMatchObject({ name: '業務', color: '#123456', fetchedAt: added.fetchedAt })
    expect(fetch.calls).toHaveLength(1)
    expect(sync.eventsOn('2026-11-03')[0]).toMatchObject({ calendarName: '業務', color: '#123456' })

    const moved = await sync.updateCalendar(added.id, { url: URL_B })
    expect(fetch.calls).toEqual([URL_A, URL_B])
    expect(moved).toMatchObject({ eventCount: 1, error: null })
    expect(sync.eventsOn('2026-11-03').map((e) => e.title)).toEqual(['チーム定例'])
    expect(calendarRepo.getCache(db, added.id)?.ics).toBe(SMALL_ICS)

    expect(await sync.updateCalendar(999, { name: 'x' })).toBeNull()
    expect(await sync.removeCalendar(added.id)).toBe(true)
    expect(await sync.removeCalendar(added.id)).toBe(false)
    expect(sync.status()).toMatchObject({ configured: false, calendars: [] })
    expect(sync.eventsOn('2026-11-03')).toEqual([])
    expect(calendarRepo.getCache(db, added.id)).toBeNull()
  })

  test('sources() exposes the URL for the settings screen alongside the status', async () => {
    const fetch = fakeFetch()
    const { sync } = setup(fetch)
    await sync.refresh()
    expect(sync.sources()).toEqual([
      expect.objectContaining({ id: 1, name: 'cal1', url: URL_A, color: '#8b96a5', status: expect.objectContaining({ error: null }) }),
    ])
  })

  test('start refreshes immediately and on the interval; stop cancels', async () => {
    const fetch = fakeFetch()
    const { sync, scheduled } = setup(fetch)
    sync.start()
    sync.start()
    await sync.refresh()
    expect(fetch.calls).toHaveLength(1)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.ms).toBe(15 * 60_000)
    scheduled[0]!.fn()
    await sync.refresh()
    expect(fetch.calls).toHaveLength(2)
    sync.stop()
  })
})
