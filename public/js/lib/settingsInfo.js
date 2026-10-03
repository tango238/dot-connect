// 設定ダイアログに並べる「外部からの接続情報」を組み立てる純粋関数。
// DOM もフェッチもここには無いので、表示ロジックだけを単体でテストできる。

import { mcpAddCommand } from './capabilities.js'

/**
 * @param {{ mcpBinPath: string|null }|null} capabilities /api/capabilities の結果(未取得なら null)
 * @param {string} origin window.location.origin
 * @returns {{ label: string, value: string, copyable: boolean }[]}
 */
export function buildSettingsRows(capabilities, origin) {
  const rows = [{ label: 'APIのベースURL', value: origin, copyable: true }]
  // MCP バイナリを同梱するデスクトップビルドでしか出せない行。ブラウザ運用
  // では mcpAddCommand が null を返すので、その場合は黙って省く。
  const command = mcpAddCommand(capabilities, origin)
  if (command !== null) {
    rows.push({ label: 'MCP登録コマンド', value: command, copyable: true })
  }
  return rows
}
