import { randomUUID } from 'node:crypto'

// 保存名に残してよい拡張子。英数字のみ・10文字までに絞ることで、元ファイル名
// に含まれうるパス区切り (`../`)、空白、記号、非ASCII が保存名に一切漏れない
// ——保存名はディスク上のファイル名になるので、ここが唯一の防波堤になる。
const SAFE_EXTENSION = /^[A-Za-z0-9]{1,10}$/

function extensionOf(originalName: string): string | null {
  const lastDot = originalName.lastIndexOf('.')
  if (lastDot === -1) {
    return null
  }
  const extension = originalName.slice(lastDot + 1)
  return SAFE_EXTENSION.test(extension) ? extension : null
}

/**
 * ディスクに置くファイル名を作る。中身は UUID なので、元ファイル名が何であれ
 * フォルダ内で衝突せず、元の名前が保存名に影響するのは「安全と判断できた拡張
 * 子」だけ。拡張子を残すのは、フォルダを直接開いた人やOSがファイル種別を判断
 * できるようにするため(人が読む名前は original_name 側が持つ)。
 */
export function buildStoredName(originalName: string): string {
  const extension = extensionOf(originalName)
  return extension === null ? randomUUID() : `${randomUUID()}.${extension}`
}
