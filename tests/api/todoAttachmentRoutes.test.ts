import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as todoRepo from '../../src/db/todoRepo'
import { type TestApp, createTestApp, readJson } from './testApp'

const MAX_FILE_BYTES = 20 * 1024 * 1024

// Every test gets a throwaway directory of its own, installed as the upload
// dir through the real settings endpoint. dbPath points into the same
// throwaway root as well, so even a code path that fell back to the *default*
// upload dir (a sibling of the db file) could not reach the repo's data/ or
// the developer's own attachments folder.
async function setupApp() {
  const root = mkdtempSync(join(tmpdir(), 'dot-connect-attachments-'))
  const uploadDir = join(root, 'uploads')
  mkdirSync(uploadDir)
  const { app, deps } = createTestApp({ dbPath: join(root, 'dot-connect.db') })
  const settings = await app.request('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadDir }),
  })
  if (settings.status !== 200) {
    throw new Error(`Test setup failed to configure the upload dir: ${settings.status}`)
  }
  const todo = todoRepo.create(deps.db, { title: 'a todo' })
  return { app, deps, uploadDir, todoId: todo.id }
}

// Real FormData, so Bun builds (and the route parses) an actual multipart
// body — boundary, part headers, filename and all — rather than a hand-rolled
// approximation that could pass while the real browser request fails.
function upload(app: TestApp, todoId: number, file: File): Promise<Response> {
  const form = new FormData()
  form.set('file', file)
  return app.request(`/api/todos/${todoId}/attachments`, { method: 'POST', body: form })
}

function textFile(name: string, contents: string): File {
  return new File([contents], name, { type: 'text/plain' })
}

function sizedFile(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' })
}

describe('POST /api/todos/:id/attachments', () => {
  test('保存名を別に振って実ファイルを置き、更新後のTODOを201で返す', async () => {
    const { app, uploadDir, todoId } = await setupApp()
    const res = await upload(app, todoId, textFile('設計メモ.txt', 'hello attachment'))
    const body = await readJson(res)

    expect(res.status).toBe(201)
    expect(body.data.id).toBe(todoId)
    expect(body.data.attachments).toHaveLength(1)

    const attachment = body.data.attachments[0]
    expect(attachment).toMatchObject({
      todoId,
      originalName: '設計メモ.txt',
      sizeBytes: Buffer.byteLength('hello attachment'),
    })
    // 保存名は元の名前をそのまま使わない(元名は original_name 側が持つ)。
    expect(attachment.storedName).not.toBe('設計メモ.txt')
    expect(attachment.path).toBe(join(uploadDir, attachment.storedName))
    expect(existsSync(attachment.path)).toBe(true)
    expect(readFileSync(attachment.path, 'utf8')).toBe('hello attachment')
  })

  test('3件までは受け付け、4件目は400で実ファイルも増えない', async () => {
    const { app, uploadDir, todoId } = await setupApp()
    for (const index of [1, 2, 3]) {
      const res = await upload(app, todoId, textFile(`f${index}.txt`, `body ${index}`))
      expect(res.status).toBe(201)
    }
    expect(readdirSync(uploadDir)).toHaveLength(3)

    const res = await upload(app, todoId, textFile('f4.txt', 'body 4'))
    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('添付は3件までです')
    expect(readdirSync(uploadDir)).toHaveLength(3)
  })

  // 上限チェックと INSERT の間には await が2つ(ボディ読み取りとファイル書き
  // 込み)挟まる。同時に投げれば全部が同じ「まだ0件」を見て全部通ってしまう
  // ——UI での抑止は防御ではない以上、ここが本当の砦になる。
  test('同時に投げても3件を超えず、はみ出した分の実ファイルも残らない', async () => {
    const { app, deps, uploadDir, todoId } = await setupApp()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        upload(app, todoId, textFile(`race${index}.txt`, `payload ${index}`))
      )
    )

    const created = results.filter((res) => res.status === 201)
    expect(created).toHaveLength(3)
    expect(results.filter((res) => res.status === 400)).toHaveLength(5)
    expect(todoRepo.getById(deps.db, todoId)?.attachments).toHaveLength(3)
    expect(readdirSync(uploadDir)).toHaveLength(3)
  })

  // 書き込み済みのファイルは、行の登録に失敗した時点で消さないと「どの行から
  // も参照されない = 二度と消せない」ファイルになる。INSERT だけを失敗させる
  // ため、テーブルを消さずに BEFORE INSERT トリガで ABORT させる(件数を数え
  // る SELECT は生かしたままにする必要がある)。
  test('登録に失敗したら、書き込み済みのファイルを消してから500を返す', async () => {
    const { app, deps, uploadDir, todoId } = await setupApp()
    deps.db.run(
      `CREATE TRIGGER reject_attachment_insert BEFORE INSERT ON todo_attachments
       BEGIN SELECT RAISE(ABORT, 'insert rejected for test'); END`
    )

    const res = await upload(app, todoId, textFile('doomed.txt', 'doomed'))

    expect(res.status).toBe(500)
    expect(readdirSync(uploadDir)).toHaveLength(0)
    expect(todoRepo.getById(deps.db, todoId)?.attachments).toHaveLength(0)
  })

  // mkdirSync succeeds on an already-existing (but read-only) directory, so
  // it's Bun.write that throws EACCES. That must surface as a 400 naming the
  // directory rather than falling through to a generic 500 — root ignores
  // the read-only bit, so this is skipped when running as root.
  test.skipIf(process.getuid?.() === 0)(
    '書き込めないアップロード先フォルダは400で、フォルダを名指しする',
    async () => {
      const { app, uploadDir, todoId } = await setupApp()
      chmodSync(uploadDir, 0o500)
      try {
        const res = await upload(app, todoId, textFile('locked.txt', 'locked'))
        const body = await readJson(res)

        expect(res.status).toBe(400)
        expect(body.error).toContain(uploadDir)
        // 0o500 still grants read+execute, so the directory listing itself
        // isn't blocked — this pins that the partially-written file was
        // cleaned up rather than merely assuming it.
        expect(readdirSync(uploadDir)).toHaveLength(0)
      } finally {
        chmodSync(uploadDir, 0o700)
      }
    }
  )

  test('上限ちょうど(20MB)は受け付ける', async () => {
    const { app, todoId } = await setupApp()
    const res = await upload(app, todoId, sizedFile('exactly-at-the-limit.bin', MAX_FILE_BYTES))
    const body = await readJson(res)

    expect(res.status).toBe(201)
    expect(body.data.attachments[0].sizeBytes).toBe(MAX_FILE_BYTES)
  })

  test('上限を1バイト超えると400で、実ファイルは書かれない', async () => {
    const { app, uploadDir, todoId } = await setupApp()
    const res = await upload(app, todoId, sizedFile('one-byte-over.bin', MAX_FILE_BYTES + 1))

    expect(res.status).toBe(400)
    expect((await readJson(res)).error).toBe('ファイルは20MBまでです')
    expect(readdirSync(uploadDir)).toHaveLength(0)
  })

  test('file フィールドの無いPOSTは400', async () => {
    const { app, uploadDir, todoId } = await setupApp()
    const res = await app.request(`/api/todos/${todoId}/attachments`, {
      method: 'POST',
      body: new FormData(),
    })

    expect(res.status).toBe(400)
    expect(readdirSync(uploadDir)).toHaveLength(0)
  })

  test('ボディの無いPOSTは400(500にはしない)', async () => {
    const { app, uploadDir, todoId } = await setupApp()
    const res = await app.request(`/api/todos/${todoId}/attachments`, { method: 'POST' })

    expect(res.status).toBe(400)
    expect(readdirSync(uploadDir)).toHaveLength(0)
  })

  test('存在しないTODOへのPOSTは404で、保存先には何も書かれない', async () => {
    const { app, uploadDir } = await setupApp()
    const res = await upload(app, 9999, textFile('orphan.txt', 'orphan'))

    expect(res.status).toBe(404)
    expect(readdirSync(uploadDir)).toHaveLength(0)
  })

  // multipart は Content-Type の検査だけを免除されている。Origin の検査は
  // 他のPOSTと同じくそのまま効いていること —— ここが緩むと、任意のページの
  // <form enctype="multipart/form-data"> がそのままアップロードになる。
  test('別オリジンからのアップロードは403で、実ファイルは書かれない', async () => {
    const { app, uploadDir, todoId } = await setupApp()
    const form = new FormData()
    form.set('file', textFile('evil.txt', 'evil'))
    const res = await app.request(`/api/todos/${todoId}/attachments`, {
      method: 'POST',
      body: form,
      headers: { origin: 'http://evil.example' },
    })

    expect(res.status).toBe(403)
    expect(readdirSync(uploadDir)).toHaveLength(0)
  })
})

describe('DELETE /api/todos/:id/attachments/:attachmentId', () => {
  test('行と実ファイルの両方を消し、更新後のTODOを返す', async () => {
    const { app, todoId } = await setupApp()
    const uploaded = await readJson(await upload(app, todoId, textFile('a.txt', 'a')))
    const attachment = uploaded.data.attachments[0]
    expect(existsSync(attachment.path)).toBe(true)

    const res = await app.request(`/api/todos/${todoId}/attachments/${attachment.id}`, {
      method: 'DELETE',
    })

    expect(res.status).toBe(200)
    expect((await readJson(res)).data.attachments).toHaveLength(0)
    expect(existsSync(attachment.path)).toBe(false)
  })

  test('他のTODOの添付IDを指定した削除は404で、実ファイルも残る', async () => {
    const { app, deps, todoId } = await setupApp()
    const other = todoRepo.create(deps.db, { title: 'other todo' })
    const uploaded = await readJson(await upload(app, todoId, textFile('a.txt', 'a')))
    const attachment = uploaded.data.attachments[0]

    const res = await app.request(`/api/todos/${other.id}/attachments/${attachment.id}`, {
      method: 'DELETE',
    })

    expect(res.status).toBe(404)
    expect(existsSync(attachment.path)).toBe(true)
    expect(todoRepo.getById(deps.db, todoId)?.attachments).toHaveLength(1)
  })
})

describe('DELETE /api/todos/:id', () => {
  test('TODOを消すと添付の実ファイルも消える', async () => {
    const { app, deps, uploadDir, todoId } = await setupApp()
    await upload(app, todoId, textFile('a.txt', 'a'))
    await upload(app, todoId, textFile('b.txt', 'b'))
    expect(readdirSync(uploadDir)).toHaveLength(2)

    const res = await app.request(`/api/todos/${todoId}`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(todoRepo.getById(deps.db, todoId)).toBeNull()
    expect(readdirSync(uploadDir)).toHaveLength(0)
  })

  test('添付の無いTODOの削除はこれまでどおり成功する', async () => {
    const { app, deps } = await setupApp()
    const bare = todoRepo.create(deps.db, { title: 'no attachments' })

    const res = await app.request(`/api/todos/${bare.id}`, { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(todoRepo.getById(deps.db, bare.id)).toBeNull()
  })
})
