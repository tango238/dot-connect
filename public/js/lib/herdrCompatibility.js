import { escapeHtml } from '../utils.js'

const labels = {
  unchecked: '未確認', 'verified-parser': 'CLI引数検証済み', unverified: '未検証版',
  incompatible: 'CLI形式が非対応', missing: '未インストール／パス不明', error: '確認失敗',
}
function date(value) {
  return value ? new Date(value).toLocaleString('ja-JP') : '未確認'
}

export function herdrCompatibilityHtml(info, checking = false, error = '') {
  const row = (label, value) => `<div class="settings-row"><div class="settings-label">${escapeHtml(label)}</div><div class="settings-value">${escapeHtml(value)}</div></div>`
  let content = '<p class="field-hint">バージョンと利用可能な操作を確認します。</p>'
  if (info) {
    content = row('インストール済み', info.installedVersion ?? '不明')
      + row('対応状況', labels[info.status] ?? '不明')
      + row('実引数パーサー', info.promptParserVerified ? '検証済み（実送信なし）' : '未検証')
      + row('依頼送信', info.dispatchAllowed ? '利用可能（agent prompt）' : '停止中')
      + row('最終確認', date(info.checkedAt))
      + row('前回確認成功', date(info.lastSuccessfulCheckAt))
      + row('次回確認', `${date(info.nextCheckAt)} / 通常 ${info.intervalMs / 3600000} 時間ごと`)
      + row('最新公開版', info.latestPublishedVersion ?? info.latestPublishedNote)
      + (info.changedAt ? row('版の変更を検出', `${info.previousVersion} → ${info.installedVersion ?? '不明'} (${date(info.changedAt)})`) : '')
      + `<p class="field-hint">${escapeHtml(info.message)}</p>`
      + '<details><summary>操作ごとの検出結果・対応表</summary>'
      + (info.operations.length ? info.operations.map(op => row(op.label, `${op.detected ? 'CLI形式を検出' : '未確認'} · ${op.command}`)).join('') : '<p class="field-hint">機能を確認できていません。</p>')
      + info.verifiedVersions.map(v => row(`対応版 ${v.version}`, `${v.difference} ${v.evidence}`)).join('')
      + '<p class="field-hint">その他の版は未検証です。機能検出のみでは送信を許可しません。旧 agent send への自動切替やHerdrの自動更新は行いません。</p></details>'
  }
  return `<h3>Herdr の互換性</h3>${content}
    ${error ? `<p role="alert" class="field-hint">${escapeHtml(error)}（表示済みの情報は過去の結果です）</p>` : ''}
    <button type="button" class="btn" data-action="check-herdr" ${checking ? 'disabled' : ''}>${checking ? '確認中…' : '今すぐ再確認'}</button>`
}
