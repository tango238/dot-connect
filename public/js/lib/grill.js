import { isHerdrTask } from './dispatchMode.js'

// Grill: a herdr session where Claude Code interviews the user to firm up a
// TODO. Which button a row shows is decided here so it stays testable.

// Returns null when the row should offer neither (done, an ordinary task
// session is already running, or the todo is already Grilled — then the
// row offers 「目標に登録」 instead; see weekGoalButton).
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
  if (isGrilled(todo)) return null
  return {
    action: 'grill',
    label: 'プロンプトを作成',
    title: 'herdr セッションで質問しながら詳細を詰めます',
  }
}

/** Grilled 済み(Grill の結果を反映した後)か。Grill 中は含めない。 */
export function isGrilled(todo) {
  return !!todo?.grilledAt && !todo.grillDir
}

/**
 * TODO 一覧の「目標に登録」: 未完了 TODO を今週終わらせるタスク(目標ページ)に
 * 足す導線。herdr か自分かは TODO 側の判定(dispatchMode.js: 明示指定、無ければ
 * 作業ディレクトリか Grilled があれば herdr)で、自分でやるタスクなら self: true
 * (herdr には流さない)。既に入っていれば押せない印になる。セッション中・
 * Grill 中は出さない(その行には別のボタンがある)。
 * @param {object} todo
 * @param {number[]} currentWeekIds 今週の並びにある TODO の id
 * @returns {{ registered: boolean, self?: boolean, action?: string, label: string, title: string } | null}
 */
export function weekGoalButton(todo, currentWeekIds = []) {
  if (!todo || todo.status === 'done' || todo.grillDir || todo.sessionState) return null
  if (currentWeekIds.includes(todo.id)) {
    return { registered: true, label: '今週の目標', title: '目標の「今週終わらせるタスク」に入っています' }
  }
  if (!isHerdrTask(todo)) {
    return {
      registered: false,
      self: true,
      action: 'add-to-week',
      label: '目標に登録',
      title: 'herdr には投入せず、自分でやるタスクとして目標の「今週終わらせるタスク」に追加します(作業ディレクトリを設定するか「プロンプトを作成」→ Grilled にすると herdr になります。詳細の「投入先」でも選べます)。期日が無ければ週末が付きます',
    }
  }
  return {
    registered: false,
    self: false,
    action: 'add-to-week',
    label: '目標に登録',
    title: 'herdr に投入する対象として目標の「今週終わらせるタスク」に追加します。期日が無ければ週末が付きます',
  }
}
