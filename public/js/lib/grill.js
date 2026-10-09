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
