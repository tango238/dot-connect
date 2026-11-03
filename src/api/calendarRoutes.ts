import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { calendarEventsQuerySchema, createCalendarSchema, idParamSchema, updateCalendarSchema } from './schemas'
import { parseOrThrow } from './validation'
import { normalizeIcsUrl } from '../services/calendarSync'

// Google カレンダー(iCal 非公開 URL)の予定と、登録一覧の管理。スケジュール
// ページが日ごとの予定を読み、設定画面がカレンダーを足したり消したりする。
// ブラウザ UI 専用: apiTokenAuth.ts の許可リストには入れていない(予定は
// TODO ではないので MCP やスクリプトに見せる理由がなく、URL は秘密)。

function eventsHandler(deps: AppDependencies) {
  return (c: Context) =>
    handle(c, async () => {
      const { date } = parseOrThrow(calendarEventsQuerySchema, c.req.query())
      return ok(c, { status: deps.calendar.status(), events: deps.calendar.eventsOn(date) })
    })
}

export function createCalendarRoutes(deps: AppDependencies): Hono {
  const app = new Hono()
  app.get('/events', eventsHandler(deps))
  app.post('/refresh', (c) => handle(c, async () => ok(c, { status: await deps.calendar.refresh() })))

  // 登録一覧(URL 込み)。設定画面の初期表示用。
  app.get('/sources', (c) => handle(c, async () => ok(c, deps.calendar.sources())))

  // 追加して初回の取得まで待つ —— 設定画面が「取れた/取れない」をその場で
  // 出せるように。取得は calendarSync 側で 20 秒で打ち切られる。
  app.post('/sources', (c) =>
    handle(c, async () => {
      const input = parseOrThrow(createCalendarSchema, await c.req.json())
      const url = normalizeIcsUrl(input.url)
      if ('error' in url) return fail(c, 400, url.error)
      const status = await deps.calendar.addCalendar({ name: input.name, url: url.url, color: input.color })
      return ok(c, status, 201)
    })
  )

  app.patch('/sources/:id', (c) =>
    handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const input = parseOrThrow(updateCalendarSchema, await c.req.json())
      let url: string | undefined
      if (input.url !== undefined) {
        const normalized = normalizeIcsUrl(input.url)
        if ('error' in normalized) return fail(c, 400, normalized.error)
        url = normalized.url
      }
      const status = await deps.calendar.updateCalendar(id, { name: input.name, url, color: input.color })
      if (status === null) return fail(c, 404, 'そのカレンダーは既に削除されています')
      return ok(c, status)
    })
  )

  app.post('/sources/:id/refresh', (c) =>
    handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const status = await deps.calendar.refresh(id)
      const source = status.calendars.find((s) => s.id === id)
      if (!source) return fail(c, 404, 'そのカレンダーは既に削除されています')
      return ok(c, source)
    })
  )

  app.delete('/sources/:id', (c) =>
    handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      if (!(await deps.calendar.removeCalendar(id))) return fail(c, 404, 'そのカレンダーは既に削除されています')
      return ok(c, { removed: true })
    })
  )

  return app
}
