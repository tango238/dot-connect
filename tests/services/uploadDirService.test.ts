import { describe, expect, test } from 'bun:test'
import { mkdtempSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../../src/db/database'
import * as appSettingsRepo from '../../src/db/appSettingsRepo'
import { UPLOAD_DIR_KEY, resolveUploadDir, validateUploadDir } from '../../src/services/uploadDirService'

describe('resolveUploadDir', () => {
  test('未設定なら DB と同階層の attachments', () => {
    const db = createDatabase(':memory:')
    const resolved = resolveUploadDir(db, '/Users/x/Library/App/dot-connect.db')
    expect(resolved).toEqual({ path: '/Users/x/Library/App/attachments', isDefault: true })
  })

  test('設定があればそれを使う', () => {
    const db = createDatabase(':memory:')
    appSettingsRepo.set(db, UPLOAD_DIR_KEY, '/tmp/chosen')
    expect(resolveUploadDir(db, '/any/dot-connect.db')).toEqual({ path: '/tmp/chosen', isDefault: false })
  })
})

describe('validateUploadDir', () => {
  test('実在する書き込み可能なディレクトリは null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'updir-'))
    expect(validateUploadDir(dir)).toBeNull()
  })

  test('相対パスは拒否する', () => {
    expect(validateUploadDir('relative/path')).toBeTruthy()
  })

  test('存在しないパスは拒否する', () => {
    expect(validateUploadDir('/tmp/definitely-not-here-9f3a2b')).toBeTruthy()
  })

  test('ディレクトリでないものは拒否する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'updir-'))
    const file = join(dir, 'f.txt')
    writeFileSync(file, 'x')
    expect(validateUploadDir(file)).toBeTruthy()
  })

  test.skipIf(process.getuid?.() === 0)('書き込めないディレクトリは拒否する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'updir-ro-'))
    chmodSync(dir, 0o500)
    expect(validateUploadDir(dir)).toBeTruthy()
    chmodSync(dir, 0o700)
  })
})
