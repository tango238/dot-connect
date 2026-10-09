import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestApp, readJson } from './testApp'

describe('GET /api/settings', () => {
  test('未設定なら既定パスと isDefault: true を返す', async () => {
    const { app } = createTestApp({ dbPath: '/tmp/x/dot-connect.db' })
    const res = await app.request('/api/settings')
    expect(res.status).toBe(200)
    expect((await readJson(res)).data).toEqual({
      uploadDir: '/tmp/x/attachments',
      uploadDirIsDefault: true,
      idleRecapMinutes: 180,
    })
  })
})

describe('PATCH /api/settings', () => {
  test('実在する書き込み可能フォルダを保存できる', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-'))
    const { app } = createTestApp({ dbPath: '/tmp/x/dot-connect.db' })
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadDir: dir }),
    })
    expect(res.status).toBe(200)
    expect((await readJson(res)).data).toEqual({ uploadDir: dir, uploadDirIsDefault: false, idleRecapMinutes: 180 })

    const after = await app.request('/api/settings')
    expect((await readJson(after)).data.uploadDir).toBe(dir)
  })

  test('相対パスは400', async () => {
    const { app } = createTestApp({ dbPath: '/tmp/x/dot-connect.db' })
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadDir: 'relative/dir' }),
    })
    expect(res.status).toBe(400)
  })

  test('存在しないパスは400', async () => {
    const { app } = createTestApp({ dbPath: '/tmp/x/dot-connect.db' })
    const res = await app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadDir: '/tmp/definitely-not-here-9f3a2b' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/settings idleRecapMinutes', () => {
  function patch(app: ReturnType<typeof createTestApp>['app'], body: unknown) {
    return app.request('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('分数を保存でき、GET にも反映される', async () => {
    const { app } = createTestApp({ dbPath: '/tmp/x/dot-connect.db' })
    const res = await patch(app, { idleRecapMinutes: 120 })
    expect(res.status).toBe(200)
    expect((await readJson(res)).data.idleRecapMinutes).toBe(120)

    const after = await app.request('/api/settings')
    expect((await readJson(after)).data).toEqual({
      uploadDir: '/tmp/x/attachments',
      uploadDirIsDefault: true,
      idleRecapMinutes: 120,
    })
  })

  test('uploadDir を省略しても分数だけ更新できる(uploadDir は既定のまま)', async () => {
    const { app } = createTestApp({ dbPath: '/tmp/x/dot-connect.db' })
    const res = await patch(app, { idleRecapMinutes: 30 })
    expect(res.status).toBe(200)
    expect((await readJson(res)).data.uploadDirIsDefault).toBe(true)
  })

  test('0 / 1441 / 小数 / 文字列は400', async () => {
    const { app } = createTestApp({ dbPath: '/tmp/x/dot-connect.db' })
    for (const value of [0, 1441, 90.5, '120']) {
      const res = await patch(app, { idleRecapMinutes: value })
      expect(res.status).toBe(400)
    }
  })

  test('何も指定しない空オブジェクトは400', async () => {
    const { app } = createTestApp({ dbPath: '/tmp/x/dot-connect.db' })
    const res = await patch(app, {})
    expect(res.status).toBe(400)
  })

  test('uploadDir が不正なら分数も保存されない', async () => {
    const { app } = createTestApp({ dbPath: '/tmp/x/dot-connect.db' })
    const res = await patch(app, { uploadDir: 'relative/dir', idleRecapMinutes: 45 })
    expect(res.status).toBe(400)
    const after = await app.request('/api/settings')
    expect((await readJson(after)).data.idleRecapMinutes).toBe(180)
  })
})
