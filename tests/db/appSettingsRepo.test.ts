import { describe, expect, test } from 'bun:test'
import { createDatabase } from '../../src/db/database'
import * as appSettingsRepo from '../../src/db/appSettingsRepo'

describe('appSettingsRepo', () => {
  test('未設定のキーは null', () => {
    const db = createDatabase(':memory:')
    expect(appSettingsRepo.get(db, 'upload_dir')).toBeNull()
  })

  test('set した値を get で読める', () => {
    const db = createDatabase(':memory:')
    appSettingsRepo.set(db, 'upload_dir', '/tmp/a')
    expect(appSettingsRepo.get(db, 'upload_dir')).toBe('/tmp/a')
  })

  test('同じキーへの set は上書きになる(行が増えない)', () => {
    const db = createDatabase(':memory:')
    appSettingsRepo.set(db, 'upload_dir', '/tmp/a')
    appSettingsRepo.set(db, 'upload_dir', '/tmp/b')
    expect(appSettingsRepo.get(db, 'upload_dir')).toBe('/tmp/b')
    const count = db.query('SELECT COUNT(*) AS n FROM app_settings').get() as { n: number }
    expect(count.n).toBe(1)
  })
})
