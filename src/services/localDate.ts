// ローカル暦の日付計算。週次レポートの「今週の月曜」や週の範囲は人間の暦
// (ローカル)の概念なので、保存(UTC の datetime('now'))とは切り離してここで
// 扱う。SQL 側の date(x, 'localtime') と同じ暦になる。

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function addDaysLocal(dateStr: string, days: number): string {
  const parts = dateStr.split('-').map(Number)
  const date = new Date(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1)
  date.setDate(date.getDate() + days)
  return formatLocalDate(date)
}

export function mostRecentMonday(now: Date): string {
  const day = now.getDay() // 0 = Sunday .. 6 = Saturday, local time
  const diffToMonday = day === 0 ? 6 : day - 1
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday)
  return formatLocalDate(monday)
}

// SQLite の datetime('now') ("YYYY-MM-DD HH:MM:SS"、UTC、タイムゾーン表記
// なし)をローカル暦の日付に直す。Date にそのまま渡すとローカル時刻として
// 読まれて日付がずれるので、Z を付けてから変換する。
export function sqliteUtcToLocalDate(value: string): string {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const date = new Date(`${normalized}Z`)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Not a SQLite UTC timestamp: ${value}`)
  }
  return formatLocalDate(date)
}
