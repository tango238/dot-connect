// <option> lists shared by the new-todo form (todos.js) and the edit form in
// the TODO detail dialog (todoDetailDialog.js).

import { buildModelSelectChoices } from './lib/modelOptions.js'
import { getState } from './state.js'
import { escapeHtml } from './utils.js'

// 緊急度・重要度(1〜5)の <select>。中身は lib/priority.js の levelOptions。
export { levelOptions as priorityLevelOptions } from './lib/priority.js'

export function modelOptions(selected) {
  return buildModelSelectChoices(getState().models)
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}" ${o.value === selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
    )
    .join('')
}
