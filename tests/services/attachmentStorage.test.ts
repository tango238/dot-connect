import { describe, expect, test } from 'bun:test'
import { buildStoredName } from '../../src/services/attachmentStorage'

describe('buildStoredName', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

  test('拡張子を保つ', () => {
    const name = buildStoredName('report.pdf')
    expect(name).toMatch(UUID)
    expect(name.endsWith('.pdf')).toBe(true)
  })

  // 末尾までアンカーして「UUID と拡張子以外は何も残っていない」ことを固定する。
  // 上の UUID 正規表現は前方一致なので、元ファイル名をサニタイズして混ぜる実装
  // (`<uuid>-QuarterlyReport.pdf` など)を素通ししてしまう。
  test('元ファイル名は保存名に一切残らない', () => {
    expect(buildStoredName('QuarterlyReport.pdf')).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    expect(buildStoredName('Makefile')).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('毎回異なる名前になる', () => {
    expect(buildStoredName('a.png')).not.toBe(buildStoredName('a.png'))
  })

  test('複合拡張子は最後だけ使う', () => {
    expect(buildStoredName('archive.tar.gz').endsWith('.gz')).toBe(true)
  })

  test('拡張子なしは拡張子なし', () => {
    expect(buildStoredName('Makefile').includes('.')).toBe(false)
  })

  test('パス区切りや .. を含む名前でも安全な名前になる', () => {
    const name = buildStoredName('../../etc/passwd')
    expect(name.includes('/')).toBe(false)
    expect(name.includes('..')).toBe(false)
  })

  test('非ASCIIや記号の拡張子は落とす', () => {
    expect(buildStoredName('写真.画像').includes('.')).toBe(false)
    expect(buildStoredName('x.p!g').includes('.')).toBe(false)
  })

  test('長すぎる拡張子は落とす', () => {
    expect(buildStoredName('x.abcdefghijk').includes('.')).toBe(false)
  })
})
