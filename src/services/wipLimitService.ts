// カンバンの WIP 制限。有効にすると、herdr セッションを抱えた未完了TODOの数が
// 上限に達した時点で、それ以上の投入(dispatch)を断る。枠を空けるには TODO を
// 完了にするか削除する。既定は無効で、無効なら従来どおり何件でも投入できる。

import type { Database } from 'bun:sqlite'
import * as appSettingsRepo from '../db/appSettingsRepo'
import { ConflictError } from './errors'

export const WIP_LIMIT_ENABLED_KEY = 'wip_limit_enabled'
export const WIP_LIMIT_KEY = 'wip_limit'
export const DEFAULT_WIP_LIMIT = 10
export const MIN_WIP_LIMIT = 1
export const MAX_WIP_LIMIT = 30

export interface WipLimitSettings {
  readonly enabled: boolean
  readonly limit: number
}

export function resolveWipLimit(db: Database): WipLimitSettings {
  const enabled = appSettingsRepo.get(db, WIP_LIMIT_ENABLED_KEY) === '1'
  const raw = appSettingsRepo.get(db, WIP_LIMIT_KEY)
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  // 壊れた値・範囲外は既定に倒す(idleRecapService と同じ扱い)。
  const valid = Number.isInteger(parsed) && parsed >= MIN_WIP_LIMIT && parsed <= MAX_WIP_LIMIT
  return { enabled, limit: valid ? parsed : DEFAULT_WIP_LIMIT }
}

// WIP に数えるのは「herdr セッションに紐付いた未完了TODO」。サイドバーの
// 「管理中」件数(state.js の managedSessionCount)と同じ定義にしている。
// 完了済みは、セッションが閉じきれずに残っていても数えない —— 完了が枠を
// 空ける操作だから。
function wipTodoIds(db: Database): number[] {
  const rows = db
    .query(`SELECT id FROM todos WHERE status != 'done' AND session_state IS NOT NULL`)
    .all() as { id: number }[]
  return rows.map((row) => row.id)
}

/**
 * todoId を新たに投入してよいか確かめ、上限に達していれば ConflictError。
 *
 * inFlight は投入処理の途中(workspace 作成待ち等)にある TODO。DB にまだ
 * セッションが記録されていない投入も枠を使うものとして数えないと、並行した
 * 投入が揃って上限チェックを通り抜けてしまう。投入しようとしている TODO
 * 自身は数えない(既に枠を持っているなら、再投入しても増えない)。
 */
export function assertWipAvailable(db: Database, todoId: number, inFlight: Iterable<number> = []): void {
  const { enabled, limit } = resolveWipLimit(db)
  if (!enabled) {
    return
  }
  const occupied = new Set([...wipTodoIds(db), ...inFlight])
  occupied.delete(todoId)
  if (occupied.size >= limit) {
    throw new ConflictError(
      `WIP制限(${limit}件)に達しているため投入できません。実行中のTODOを完了にするか削除してください`,
      { code: 'wip_limit_reached', wip: { count: occupied.size, limit } }
    )
  }
}
