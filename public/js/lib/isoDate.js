// YYYY-MM-DD かどうかの判定だけを持つ最小モジュール。
//
// 期限まわりは「バッジ」「期日超過フィルタ」「並び順」の3か所が同じ値を
// 見ており、そこで“不正な日付”の線引きがずれると、バッジは出ないのに
// 超過扱いで並ぶ——といった食い違いが起きる。判定を1か所に置いて、
// 3つが必ず同じ結論になるようにする。

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** @param {unknown} value @returns {boolean} */
export function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE_PATTERN.test(value)
}

// YYYY-MM-DD を日数ぶんずらす。UTC 正午で計算するのは、夏時間のある地域でも
// 日付境界の丸めがずれないため。
/** @param {string} iso @param {number} days @returns {string} */
export function shiftIsoDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d, 12) + days * 86_400_000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}
