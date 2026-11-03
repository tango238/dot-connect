// Grill: a herdr session where Claude Code interviews the user to firm up a
// TODO. Which button a row shows is decided here so it stays testable.

// Returns null when the row should offer neither (done, or an ordinary
// task session is already running).
export function grillButton(todo) {
  if (todo.status === 'done') return null
  // grillDir wins over sessionState: the session may have died, but the
  // result can still be applied (or the server reports the grill cancelled).
  if (todo.grillDir) {
    return {
      action: 'grilled',
      label: 'Grilled',
      title: '内容が固まったら押すと、整理した内容で TODO を更新します',
    }
  }
  if (todo.sessionState) return null
  return {
    action: 'grill',
    label: 'Grill me',
    title: 'herdr セッションで質問しながら詳細を詰めます',
  }
}

/** Grilled 済み(Grill の結果を反映した後)か。Grill 中は含めない。 */
export function isGrilled(todo) {
  return !!todo?.grilledAt && !todo.grillDir
}

/**
 * TODO 一覧の「目標に登録」: Grilled 済みの未完了 TODO を、今週終わらせる
 * タスク(目標ページ)に足す導線。既に入っていれば押せない印に
 * なる。セッション中・Grill 中は出さない(その行には別のボタンがある)。
 * @param {object} todo
 * @param {number[]} currentWeekIds 今週の並びにある TODO の id
 * @returns {{ registered: boolean, action?: string, label: string, title: string } | null}
 */
export function weekGoalButton(todo, currentWeekIds = []) {
  if (!todo || todo.status === 'done' || !isGrilled(todo) || todo.sessionState) return null
  if (currentWeekIds.includes(todo.id)) {
    return { registered: true, label: '今週の目標', title: '目標の「今週終わらせるタスク」に入っています' }
  }
  return {
    registered: false,
    action: 'add-to-week',
    label: '目標に登録',
    title: '目標の「今週終わらせるタスク」に追加します。期日が無ければ週末が付きます',
  }
}
