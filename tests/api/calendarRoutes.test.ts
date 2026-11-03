import { describe, expect, test } from 'bun:test'
import { createDatabase } from '../../src/db/database'
import * as calendarRepo from '../../src/db/calendarRepo'
import { createCalendarSync } from '../../src/services/calendarSync'
import { SAMPLE_ICS } from '../services/calendarIcs.test'
import { createTestApp, readJson } from './testApp'

const URL_A = 'https://calendar.google.com/calendar/ical/me%40example.com/private-abc/basic.ics'
const URL_B = 'https://calendar.google.com/calendar/ical/team%40example.com/private-def/basic.ics'
const NOW = () => new Date('2026-11-03T03:00:00Z')
const SMALL_ICS = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:b1\nDTSTART:20261103T050000Z\nDTEND:20261103T060000Z\nSUMMARY:チーム定例\nEND:VEVENT\nEND:VCALENDAR`

function appWithCalendar(respond: (url: string) => Response = (url) => new Response(url === URL_B ? SMALL_ICS : SAMPLE_ICS)) {
  const db = createDatabase(':memory:')
  const calls: string[] = []
  const calendar = createCalendarSync(
    {
      db,
      fetch: async (url) => {
        calls.push(url)
        return respond(url)
      },
    },
    { now: NOW, zone: 'Asia/Tokyo' }
  )
  const { app } = createTestApp({ db, calendar })
  return { app, calls, db }
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

describe('/api/calendar/sources', () => {
  test('POST adds a calendar, fetches once, assigns a palette color, and returns its status', async () => {
    const { app, calls } = appWithCalendar()
    const res = await app.request('/api/calendar/sources', json('POST', { name: ' 仕事 ', url: ` webcal://calendar.google.com/calendar/ical/me%40example.com/private-abc/basic.ics ` }))
    expect(res.status).toBe(201)
    const data = (await readJson(res)).data
    expect(data).toMatchObject({ id: 1, name: '仕事', color: '#8b96a5', error: null, fetchedAt: '2026-11-03T03:00:00.000Z' })
    expect(data.url).toBeUndefined()
    expect(calls).toEqual([URL_A])

    const second = await app.request('/api/calendar/sources', json('POST', { name: 'チーム', url: URL_B, color: '#abcdef' }))
    expect((await readJson(second)).data).toMatchObject({ id: 2, name: 'チーム', color: '#abcdef', eventCount: 1 })

    const list = await app.request('/api/calendar/sources')
    expect((await readJson(list)).data.map((s: { name: string; url: string; color: string }) => [s.name, s.url, s.color])).toEqual([
      ['仕事', URL_A, '#8b96a5'],
      ['チーム', URL_B, '#abcdef'],
    ])

    const events = await app.request('/api/calendar/events?date=2026-11-03')
    const body = (await readJson(events)).data
    expect(body.status).toMatchObject({ configured: true, calendars: [expect.objectContaining({ name: '仕事' }), expect.objectContaining({ name: 'チーム' })] })
    expect(body.events.map((e: { calendarName: string; color: string; title: string }) => [e.calendarName, e.color, e.title])).toEqual([
      ['仕事', '#8b96a5', '週次ミーティング'],
      ['チーム', '#abcdef', 'チーム定例'],
    ])
  })

  test('POST validates name, url and color, and reports an unreachable feed as the calendar’s error, never with the URL', async () => {
    const { app, calls } = appWithCalendar(() => new Response('nope', { status: 403 }))
    expect((await app.request('/api/calendar/sources', json('POST', { name: '', url: URL_A }))).status).toBe(400)
    expect((await app.request('/api/calendar/sources', json('POST', { name: 'x', url: 'file:///etc/passwd' }))).status).toBe(400)
    expect((await app.request('/api/calendar/sources', json('POST', { name: 'x', url: URL_A, color: 'red' }))).status).toBe(400)
    expect(calls).toEqual([])

    const res = await app.request('/api/calendar/sources', json('POST', { name: 'x', url: URL_A }))
    expect(res.status).toBe(201)
    const data = (await readJson(res)).data
    expect(data.error).toBe('取得に失敗しました (HTTP 403)')
    expect(JSON.stringify(data)).not.toContain('private-abc')
  })

  test('PATCH renames/recolors without refetching, refetches on a URL change, 404s when gone', async () => {
    const { app, calls } = appWithCalendar()
    await app.request('/api/calendar/sources', json('POST', { name: 'a', url: URL_A }))
    const renamed = await app.request('/api/calendar/sources/1', json('PATCH', { name: 'b', color: '#112233' }))
    expect(renamed.status).toBe(200)
    expect((await readJson(renamed)).data).toMatchObject({ name: 'b', color: '#112233' })
    expect(calls).toHaveLength(1)

    const moved = await app.request('/api/calendar/sources/1', json('PATCH', { url: URL_B }))
    expect((await readJson(moved)).data).toMatchObject({ eventCount: 1 })
    expect(calls).toEqual([URL_A, URL_B])

    expect((await app.request('/api/calendar/sources/1', json('PATCH', {}))).status).toBe(400)
    expect((await app.request('/api/calendar/sources/9', json('PATCH', { name: 'z' }))).status).toBe(404)
  })

  test('DELETE removes the calendar and its events; a second delete is 404', async () => {
    const { app, db } = appWithCalendar()
    await app.request('/api/calendar/sources', json('POST', { name: 'a', url: URL_A }))
    expect((await app.request('/api/calendar/sources/1', { method: 'DELETE' })).status).toBe(200)
    expect((await app.request('/api/calendar/sources/1', { method: 'DELETE' })).status).toBe(404)
    expect(calendarRepo.listAll(db)).toEqual([])
    const events = await app.request('/api/calendar/events?date=2026-11-03')
    expect((await readJson(events)).data).toMatchObject({ status: { configured: false }, events: [] })
  })

  test('POST /sources/:id/refresh refetches one calendar', async () => {
    const { app, calls } = appWithCalendar()
    await app.request('/api/calendar/sources', json('POST', { name: 'a', url: URL_A }))
    await app.request('/api/calendar/sources', json('POST', { name: 'b', url: URL_B }))
    const res = await app.request('/api/calendar/sources/2/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await readJson(res)).data).toMatchObject({ id: 2, error: null })
    expect(calls).toEqual([URL_A, URL_B, URL_B])
    expect((await app.request('/api/calendar/sources/9/refresh', { method: 'POST' })).status).toBe(404)
  })
})

describe('GET /api/calendar/events', () => {
  test('requires a real date', async () => {
    const { app } = appWithCalendar()
    expect((await app.request('/api/calendar/events')).status).toBe(400)
    expect((await app.request('/api/calendar/events?date=2026-02-30')).status).toBe(400)
  })

  test('unconfigured returns an empty list with configured: false', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/calendar/events?date=2026-11-03')
    expect(res.status).toBe(200)
    expect((await readJson(res)).data).toEqual({
      status: { configured: false, calendars: [], refreshing: false, windowFrom: null, windowTo: null },
      events: [],
    })
  })
})

describe('browser-only', () => {
  test('every calendar route is rejected with an API token', async () => {
    const { app } = createTestApp({ apiToken: 'secret-token' })
    const headers = { authorization: 'Bearer secret-token' }
    for (const [path, init] of [
      ['/api/calendar/events?date=2026-11-03', { headers }],
      ['/api/calendar/refresh', { method: 'POST', headers }],
      ['/api/calendar/sources', { headers }],
      ['/api/calendar/sources', { ...json('POST', { name: 'x', url: URL_A }), headers: { ...headers, 'content-type': 'application/json' } }],
    ] as const) {
      expect((await app.request(path, init as RequestInit)).status).toBe(403)
    }
  })
})
