import { describe, expect, test } from 'bun:test'
import {
  addDays,
  eventsOnDate,
  expandIcs,
  IcsParseError,
  toLocalDateTime,
  type CalendarOccurrence,
} from '../../src/services/calendarIcs'

// Google カレンダーのエクスポートに近い形。VTIMEZONE を2つ持ち、TZID 付き・
// UTC・終日・日またぎ・繰り返し(+移動した回)を含む。
export const SAMPLE_ICS = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:仕事
X-WR-TIMEZONE:Asia/Tokyo
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VTIMEZONE
TZID:Asia/Tokyo
BEGIN:STANDARD
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
TZNAME:JST
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=Asia/Tokyo:20261103T100000
DTEND;TZID=Asia/Tokyo:20261103T113000
RRULE:FREQ=WEEKLY;BYDAY=TU
UID:weekly@google.com
SUMMARY:週次ミーティング
LOCATION:会議室A
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Tokyo:20261110T140000
DTEND;TZID=Asia/Tokyo:20261110T150000
RECURRENCE-ID;TZID=Asia/Tokyo:20261110T100000
UID:weekly@google.com
SUMMARY:週次ミーティング(移動)
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20261104T090000
DTEND;TZID=America/New_York:20261104T100000
UID:ny@google.com
SUMMARY:NY call
END:VEVENT
BEGIN:VEVENT
DTSTART:20261105T010000Z
DTEND:20261105T020000Z
UID:utc@google.com
SUMMARY:UTC event
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261106
DTEND;VALUE=DATE:20261108
UID:allday@google.com
SUMMARY:出張
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Tokyo:20261107T230000
DTEND;TZID=Asia/Tokyo:20261108T010000
UID:overnight@google.com
SUMMARY:夜更かし
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Tokyo:20261109T090000
UID:noend@google.com
SUMMARY:
END:VEVENT
END:VCALENDAR`

const WINDOW = { from: '2026-11-01', to: '2026-11-30', zone: 'Asia/Tokyo' }

function byUid(occurrences: CalendarOccurrence[], uid: string) {
  return occurrences.filter((o) => o.uid === uid)
}

describe('toLocalDateTime / addDays', () => {
  test('converts an instant into the zone wall clock', () => {
    const at = new Date('2026-11-05T01:00:00Z')
    expect(toLocalDateTime(at, 'Asia/Tokyo')).toBe('2026-11-05T10:00')
    expect(toLocalDateTime(at, 'UTC')).toBe('2026-11-05T01:00')
    expect(toLocalDateTime(at, 'America/New_York')).toBe('2026-11-04T20:00')
    // 0 時は "00" で、"24" にならない
    expect(toLocalDateTime(new Date('2026-11-04T15:00:00Z'), 'Asia/Tokyo')).toBe('2026-11-05T00:00')
  })

  test('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addDays('2026-11-06T10:00', 2)).toBe('2026-11-08')
  })
})

describe('expandIcs', () => {
  test('converts every timezone form into the display zone wall clock', () => {
    const occ = expandIcs(SAMPLE_ICS, WINDOW)
    expect(byUid(occ, 'ny@google.com')).toEqual([
      { uid: 'ny@google.com', title: 'NY call', location: null, allDay: false, start: '2026-11-04T23:00', end: '2026-11-05T00:00' },
    ])
    expect(byUid(occ, 'utc@google.com')[0]).toMatchObject({ start: '2026-11-05T10:00', end: '2026-11-05T11:00' })
    expect(byUid(occ, 'overnight@google.com')[0]).toMatchObject({ start: '2026-11-07T23:00', end: '2026-11-08T01:00' })
  })

  test('keeps all-day events as dates regardless of zone', () => {
    const tokyo = byUid(expandIcs(SAMPLE_ICS, WINDOW), 'allday@google.com')
    const ny = byUid(expandIcs(SAMPLE_ICS, { ...WINDOW, zone: 'America/New_York' }), 'allday@google.com')
    expect(tokyo).toEqual([{ uid: 'allday@google.com', title: '出張', location: null, allDay: true, start: '2026-11-06', end: '2026-11-08' }])
    expect(ny).toEqual(tokyo)
  })

  test('expands a weekly rule inside the window and applies the moved instance', () => {
    const weekly = byUid(expandIcs(SAMPLE_ICS, WINDOW), 'weekly@google.com')
    expect(weekly.map((o) => [o.start, o.end, o.title])).toEqual([
      ['2026-11-03T10:00', '2026-11-03T11:30', '週次ミーティング'],
      ['2026-11-10T14:00', '2026-11-10T15:00', '週次ミーティング(移動)'],
      ['2026-11-17T10:00', '2026-11-17T11:30', '週次ミーティング'],
      ['2026-11-24T10:00', '2026-11-24T11:30', '週次ミーティング'],
    ])
    expect(weekly[0]!.location).toBe('会議室A')
  })

  test('the window cuts recurrences at both ends but keeps events overlapping its start', () => {
    const later = expandIcs(SAMPLE_ICS, { from: '2026-11-15', to: '2026-11-20', zone: 'Asia/Tokyo' })
    expect(later.map((o) => o.start)).toEqual(['2026-11-17T10:00'])
    // 窓の前日 23 時に始まって窓の初日に終わる予定は入る。終日の 11/6〜11/7
    // (DTEND 11/8 は排他的)は 11/8 にはかからない。
    const edge = expandIcs(SAMPLE_ICS, { from: '2026-11-08', to: '2026-11-08', zone: 'Asia/Tokyo' })
    expect(edge.map((o) => o.uid)).toEqual(['overnight@google.com'])
    const dayBefore = expandIcs(SAMPLE_ICS, { from: '2026-11-07', to: '2026-11-07', zone: 'Asia/Tokyo' })
    expect(dayBefore.map((o) => o.uid)).toEqual(['allday@google.com', 'overnight@google.com'])
  })

  test('an event without DTEND and without a title gets a zero-length slot and a placeholder title', () => {
    const occ = byUid(expandIcs(SAMPLE_ICS, WINDOW), 'noend@google.com')
    expect(occ).toEqual([
      { uid: 'noend@google.com', title: '(タイトルなし)', location: null, allDay: false, start: '2026-11-09T09:00', end: '2026-11-09T09:00' },
    ])
  })

  test('caps the number of occurrences per event', () => {
    const daily = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:d\nDTSTART:20260101T000000Z\nDTEND:20260101T003000Z\nRRULE:FREQ=DAILY\nSUMMARY:毎日\nEND:VEVENT\nEND:VCALENDAR`
    const occ = expandIcs(daily, { from: '2026-01-01', to: '2026-12-31', zone: 'UTC', maxOccurrencesPerEvent: 5 })
    expect(occ).toHaveLength(5)
  })

  test('rejects text that is not a calendar', () => {
    expect(() => expandIcs('hello', WINDOW)).toThrow(IcsParseError)
    // 行の形は正しいが VCALENDAR の外にある(URL を間違えたときの典型)
    expect(() => expandIcs('X-TOKEN:abc\nBEGIN:VEVENT\nEND:VEVENT', WINDOW)).toThrow(/BEGIN:VCALENDAR で始まっていません/)
    expect(() => expandIcs('{"error":"not found"}', WINDOW)).toThrow(/iCal 形式ではありません/)
    expect(() => expandIcs('BEGIN:VEVENT\nEND:VEVENT', WINDOW)).toThrow(IcsParseError)
    expect(() => expandIcs(SAMPLE_ICS, { ...WINDOW, zone: 'Mars/Olympus' })).toThrow(IcsParseError)
  })

  test('results are sorted by start', () => {
    const starts = expandIcs(SAMPLE_ICS, WINDOW).map((o) => o.start)
    expect([...starts].sort()).toEqual(starts)
  })
})

describe('eventsOnDate', () => {
  const occurrences = expandIcs(SAMPLE_ICS, WINDOW)

  test('returns only that day, all-day first, clipped to the day', () => {
    expect(eventsOnDate(occurrences, '2026-11-07').map((e) => [e.title, e.allDay, e.start, e.end, e.continuesBefore, e.continuesAfter])).toEqual([
      ['出張', true, null, null, true, false],
      ['夜更かし', false, '23:00', '24:00', false, true],
    ])
    expect(eventsOnDate(occurrences, '2026-11-08').map((e) => [e.title, e.start, e.end, e.continuesBefore])).toEqual([
      ['夜更かし', '00:00', '01:00', true],
    ])
  })

  test('all-day end is exclusive and a multi-day all-day marks its continuation', () => {
    expect(eventsOnDate(occurrences, '2026-11-06')[0]).toMatchObject({ title: '出張', continuesBefore: false, continuesAfter: true })
    expect(eventsOnDate(occurrences, '2026-11-08').some((e) => e.title === '出張')).toBe(false)
  })

  test('an event ending exactly at midnight belongs to the previous day only', () => {
    expect(eventsOnDate(occurrences, '2026-11-04').map((e) => e.title)).toEqual(['NY call'])
    expect(eventsOnDate(occurrences, '2026-11-05').map((e) => e.title)).toEqual(['UTC event'])
  })

  test('ids are unique per occurrence and day', () => {
    const ids = ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-10'].flatMap((d) => eventsOnDate(occurrences, d).map((e) => e.id))
    expect(new Set(ids).size).toBe(ids.length)
  })
})
