import type { Database } from 'bun:sqlite'
import * as appSettingsRepo from '../db/appSettingsRepo'

// 自動投入(auto mode)の設定。有効なら、画面側(autoRun.js)が「今週終わらせる
// タスク」の並びから、WIP可能数 − バッファ の空きがある間、上から順に herdr
// への投入を提案する。投入そのものは必ずユーザーの許可を待つ(勝手に始めると
// herdr 側で権限の確認に引っかかることがあるため)ので、サーバー側は値を
// 持つだけで、何も自動では動かさない。

export const AUTO_RUN_ENABLED_KEY = 'auto_run_enabled'
export const AUTO_RUN_BUFFER_KEY = 'auto_run_buffer'
export const DEFAULT_AUTO_RUN_BUFFER = 1
export const MIN_AUTO_RUN_BUFFER = 0
export const MAX_AUTO_RUN_BUFFER = 29

export interface AutoRunSettings {
  readonly enabled: boolean
  // 同時に走らせる上限は WIP可能数 − buffer。
  readonly buffer: number
}

export function resolveAutoRun(db: Database): AutoRunSettings {
  const enabled = appSettingsRepo.get(db, AUTO_RUN_ENABLED_KEY) === '1'
  const raw = appSettingsRepo.get(db, AUTO_RUN_BUFFER_KEY)
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  const valid = Number.isInteger(parsed) && parsed >= MIN_AUTO_RUN_BUFFER && parsed <= MAX_AUTO_RUN_BUFFER
  return { enabled, buffer: valid ? parsed : DEFAULT_AUTO_RUN_BUFFER }
}
