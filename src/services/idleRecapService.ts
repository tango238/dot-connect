// アイドル監視のしきい値(分)。herdr 上の Claude Code セッションが「ユーザーから
// この時間応答が無ければ recap を作業ログに書く」判断に使う。値そのものは
// dot-connect 側では使わず、セッション側のスクリプトが GET /api/settings で
// 読む —— 設定ダイアログから変えられるよう、保存場所だけここに置いている。

import type { Database } from 'bun:sqlite'
import * as appSettingsRepo from '../db/appSettingsRepo'

export const IDLE_RECAP_MINUTES_KEY = 'idle_recap_minutes'
export const DEFAULT_IDLE_RECAP_MINUTES = 180
export const MIN_IDLE_RECAP_MINUTES = 1
export const MAX_IDLE_RECAP_MINUTES = 1440

export function resolveIdleRecapMinutes(db: Database): number {
  const raw = appSettingsRepo.get(db, IDLE_RECAP_MINUTES_KEY)
  if (raw === null) {
    return DEFAULT_IDLE_RECAP_MINUTES
  }
  const parsed = Number.parseInt(raw, 10)
  // 壊れた値(手で DB を触った等)は既定に倒す。範囲外も同様。
  if (!Number.isInteger(parsed) || parsed < MIN_IDLE_RECAP_MINUTES || parsed > MAX_IDLE_RECAP_MINUTES) {
    return DEFAULT_IDLE_RECAP_MINUTES
  }
  return parsed
}
