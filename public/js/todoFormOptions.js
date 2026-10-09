// <option> lists shared by the new-todo form (todos.js) and the edit form in
// the TODO detail dialog (todoDetailDialog.js).

import { buildModelSelectChoices } from './lib/modelOptions.js'
import { getState } from './state.js'
import { escapeHtml } from './utils.js'

export function priorityOptions(selected) {
  const options = [
    { value: 'none', label: 'なし' },
    { value: 'low', label: '低' },
    { value: 'high', label: '高' },
  ]
  return options
    .map((o) => `<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`)
    .join('')
}

export function modelOptions(selected) {
  return buildModelSelectChoices(getState().models)
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}" ${o.value === selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
    )
    .join('')
}
