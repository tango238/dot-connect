import { expect, test } from 'bun:test'
import { herdrCompatibilityHtml } from '../../public/js/lib/herdrCompatibility.js'

test('unknown/error status is distinct from installed, public and verified versions; HTML is escaped', () => {
  const html = herdrCompatibilityHtml({
    installedVersion: '<unsafe>', status: 'unverified', dispatchAllowed: false,
    checkedAt: '2026-10-05T00:00:00Z', lastSuccessfulCheckAt: null, nextCheckAt: null,
    intervalMs: 86400_000, latestPublishedVersion: null, latestPublishedNote: '未確認',
    message: '<script>', operations: [{ label: '依頼送信', command: 'herdr agent prompt', detected: true }],
    verifiedVersions: [{ version: '0.9.3', difference: 'Enter込み', evidence: '実送信は未検証' }],
  }, true, 'API failed')
  for (const text of ['インストール済み', '最新公開版', '対応版 0.9.3', '未検証版', '停止中', 'disabled', '過去の結果', '&lt;unsafe&gt;', '&lt;script&gt;']) expect(html).toContain(text)
  expect(html).not.toContain('<script>')
})
