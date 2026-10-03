import type { Database } from 'bun:sqlite'
import { dirname, join } from 'node:path'
import * as appSettingsRepo from './appSettingsRepo'

// 保存先フォルダの「解決」だけがここにある(存在確認や書き込み可否の検査は
// services/uploadDirService.ts)。db 層に置いてあるのは、todoRepo が添付の絶対
// パスを組み立てるのにこれを必要とするため —— db → services の import を作ると、
// 逆向き(サービスが todoRepo を使う。例: 孤児ファイルの掃除)が生えた瞬間に
// ESM の循環参照になる。
export const UPLOAD_DIR_KEY = 'upload_dir'

// 既定は DB ファイルの隣。デスクトップ版ならアプリのデータ領域内、開発時は
// リポジトリの data/ 配下に落ちるので、環境変数を増やさずに両方で筋の通った
// 場所になる。
export function resolveUploadDir(
  db: Database,
  dbPath: string
): { path: string; isDefault: boolean } {
  const configured = appSettingsRepo.get(db, UPLOAD_DIR_KEY)
  if (configured) {
    return { path: configured, isDefault: false }
  }
  return { path: join(dirname(dbPath), 'attachments'), isDefault: true }
}

// 開いているDBハンドル自身が、開かれたファイルの位置を知っている。dbPath を
// 引数で持っていない層(todoRepo)でも保存先を解決できるようにするための入口
// で、AppDependencies.dbPath を持つ呼び出し側は resolveUploadDir を直接使う。
export function resolveUploadDirFor(db: Database): string {
  return resolveUploadDir(db, db.filename).path
}
