import { randomUUID } from 'node:crypto'
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

// 保存先の解決そのものは db 層(uploadDirLocation.ts)に置いてある —— todoRepo
// がそれを使うので、ここに置いたままだと db → services の import になり、将来
// サービス側が todoRepo を使った瞬間に循環する。呼び出し側は今までどおりこの
// モジュールからも取れるように再輸出しておく。
export { UPLOAD_DIR_KEY, resolveUploadDir, resolveUploadDirFor } from '../db/uploadDirLocation'

// 書き込み可否は実際に一時ファイルを作って消して確かめる。access(2) の結果は
// ACL やマウントオプション次第で実際の書き込み可否と食い違うため。
export function validateUploadDir(path: string): string | null {
  if (!isAbsolute(path)) {
    return '絶対パスを指定してください'
  }
  if (!existsSync(path)) {
    return 'フォルダが見つかりません'
  }
  if (!statSync(path).isDirectory()) {
    return 'フォルダではありません'
  }
  const probeFile = join(path, `.dot-connect-write-check-${randomUUID()}`)
  try {
    writeFileSync(probeFile, '')
    unlinkSync(probeFile)
  } catch {
    return '書き込みできません'
  }
  return null
}
