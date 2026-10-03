import { describe, expect, test } from 'bun:test'
import {
  appendAttachmentPaths,
  attachmentLimitReached,
  formatFileSize,
  uploadDisabledReason,
} from '../../public/js/lib/attachment.js'

describe('formatFileSize', () => {
  test('1KB未満はバイト表記', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(820)).toBe('820 B')
  })
  test('KB / MB は小数第1位', () => {
    expect(formatFileSize(12_698)).toBe('12.4 KB')
    expect(formatFileSize(3_670_016)).toBe('3.5 MB')
  })
  test('ちょうど1024はKB', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB')
  })
})

describe('attachmentLimitReached / uploadDisabledReason', () => {
  const withCount = (n) => ({ attachments: Array.from({ length: n }, (_, i) => ({ id: i })) })

  test('3件未満は未到達', () => {
    expect(attachmentLimitReached(withCount(2))).toBe(false)
    expect(uploadDisabledReason(withCount(2))).toBeNull()
  })
  test('3件で到達', () => {
    expect(attachmentLimitReached(withCount(3))).toBe(true)
    expect(uploadDisabledReason(withCount(3))).toContain('3')
  })
  test('attachments が無くても落ちない', () => {
    expect(attachmentLimitReached({})).toBe(false)
  })
})

describe('appendAttachmentPaths', () => {
  test('選択が空なら本文そのまま', () => {
    expect(appendAttachmentPaths('やること', [])).toBe('やること')
  })
  test('パスを1行で追記する', () => {
    const result = appendAttachmentPaths('やること', ['/tmp/a.png', '/tmp/b.pdf'])
    expect(result).toBe('やること 添付ファイル: "/tmp/a.png" "/tmp/b.pdf"')
    expect(result.includes('\n')).toBe(false)
  })
  test('本文が空でも壊れない', () => {
    expect(appendAttachmentPaths('', ['/tmp/a.png'])).toBe('添付ファイル: "/tmp/a.png"')
  })
  // The default upload dir lives under "Application Support" on the desktop
  // build, and any user-chosen folder can contain spaces too — an unquoted
  // join would make two such paths indistinguishable from each other.
  test('スペースを含むパスは個別に引用符で囲む', () => {
    const spacedPath = '/Users/you/Library/Application Support/net.tech-square.dot-connect/attachments/x.png'
    const result = appendAttachmentPaths('やること', [spacedPath, '/tmp/b.pdf'])
    expect(result).toBe(`やること 添付ファイル: "${spacedPath}" "/tmp/b.pdf"`)
    expect(result.includes('\n')).toBe(false)
  })
})
