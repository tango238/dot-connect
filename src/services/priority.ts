// TODO とマイルストーンに共通の優先順位: 緊急度(urgency)と重要度
// (importance)をそれぞれ 1〜5 で持つ。1 が最低(未設定と同じ扱い)、5 が
// 最高。並べ替えは「合計点(緊急度+重要度)が高い順、同点なら緊急度が高い
// 順」で、フロントの public/js/lib/priority.js と同じ規則。
//
// かつて TODO にあった 3 段階の優先度(none/low/high)は緊急度に移した:
// high → 5、low → 3、none → 1(database.ts の列追加時のバックフィル)。

export const PRIORITY_MIN = 1
export const PRIORITY_MAX = 5
export const PRIORITY_DEFAULT = 1

export interface Prioritized {
  readonly urgency: number
  readonly importance: number
}

export function priorityScore(item: Prioritized): number {
  return item.urgency + item.importance
}

/** 高い順(降順)。並べ替えの最後の決着(日付や id)は呼び出し側で付ける。 */
export function comparePriority(a: Prioritized, b: Prioritized): number {
  return priorityScore(b) - priorityScore(a) || b.urgency - a.urgency
}

// SQL の ORDER BY に埋め込む同じ規則。`alias` は todos/milestones の別名。
export function prioritySqlOrder(alias: string): string {
  return `(${alias}.urgency + ${alias}.importance) DESC, ${alias}.urgency DESC`
}
