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
    expect((await readJson(res)).data).toEqual({ uploadDir: '/tmp/x/attachments', uploadDirIsDefault: true })
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
    expect((await readJson(res)).data).toEqual({ uploadDir: dir, uploadDirIsDefault: false })

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
