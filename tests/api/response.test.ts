import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { HerdrCommandError } from '../../src/herdr/herdrClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../src/services/errors'
import { ValidationError } from '../../src/api/validation'
import { fail, handle, ok } from '../../src/api/response'

function appWithRoute(fn: () => Promise<Response>): Hono {
  const app = new Hono()
  app.get('/x', (c) => handle(c, fn))
  return app
}

describe('ok / fail', () => {
  test('ok wraps data in {success: true, data}', async () => {
    const app = new Hono()
    app.get('/x', (c) => ok(c, { a: 1 }))
    const res = await app.request('/x')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { a: 1 } })
  })

  test('fail wraps the error and merges extra fields', async () => {
    const app = new Hono()
    app.get('/x', (c) => fail(c, 409, 'conflict', { remaining: 3 }))
    const res = await app.request('/x')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'conflict', remaining: 3 })
  })
})

describe('handle error mapping', () => {
  test('maps ValidationError to 400', async () => {
    const app = appWithRoute(async () => {
      throw new ValidationError('bad input')
    })
    const res = await app.request('/x')
    expect(res.status).toBe(400)
  })

  test('maps BadRequestError to 400', async () => {
    const app = appWithRoute(async () => {
      throw new BadRequestError('workspacePath required')
    })
    const res = await app.request('/x')
    expect(res.status).toBe(400)
  })

  test('maps NotFoundError to 404', async () => {
    const app = appWithRoute(async () => {
      throw new NotFoundError('missing')
    })
    const res = await app.request('/x')
    expect(res.status).toBe(404)
  })

  test('maps ConflictError to 409 and includes its data', async () => {
    const app = appWithRoute(async () => {
      throw new ConflictError('busy', { remaining: 2 })
    })
    const res = await app.request('/x')
    expect(res.status).toBe(409)
    const body = (await res.json()) as { remaining: number }
    expect(body.remaining).toBe(2)
  })

  test('maps HerdrCommandError to 502 with a message identifying herdr as the cause', async () => {
    const app = appWithRoute(async () => {
      throw new HerdrCommandError("herdr command 'herdr pane run w1:p1 claude' failed (exit 1): boom")
    })
    const res = await app.request('/x')
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('herdrコマンドに失敗しました')
    expect(body.error).toContain('boom')
  })

  test('maps a JSON.parse SyntaxError to 400 "Malformed JSON body"', async () => {
    const app = appWithRoute(async () => {
      JSON.parse('{not valid json')
      throw new Error('unreachable')
    })
    const res = await app.request('/x')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Malformed JSON body')
  })

  test('maps an unexpected Error to 500', async () => {
    const app = appWithRoute(async () => {
      throw new Error('boom')
    })
    const res = await app.request('/x')
    expect(res.status).toBe(500)
  })

  test('maps a thrown non-Error value to 500', async () => {
    const app = appWithRoute(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'a plain string'
    })
    const res = await app.request('/x')
    expect(res.status).toBe(500)
  })
})
