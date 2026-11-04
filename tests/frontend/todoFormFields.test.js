import { describe, expect, test } from 'bun:test'
import { TODO_FORM_FIELDS, todoFormFieldIds, todoFormFieldsHtml } from '../../public/js/lib/todoFormFields.js'

const options = {
  priority: (selected) => `<option value="${selected}" selected>${selected}</option>`,
  model: (selected) => `<option value="${selected}" selected>${selected || '既定'}</option>`,
}

function render(overrides = {}) {
  return todoFormFieldsHtml({
    prefix: 'detail-edit',
    values: {
      title: 'T',
      description: 'D',
      urgency: '3',
      importance: '4',
      dueDate: '2026-11-10',
      schedDate: '2026-11-05',
      schedStart: '10:00',
      schedEnd: '11:00',
      workspacePath: '/Users/you/app',
      model: 'opus',
    },
    options,
    ...overrides,
  })
}

function sectionTitles(html) {
  return [...html.matchAll(/class="form-section-title">([^<]+)</g)].map((m) => m[1])
}

describe('todoFormFieldsHtml', () => {
  test('renders the three sections in order, with every field id under the prefix', () => {
    const html = render()
    expect(sectionTitles(html)).toEqual(['内容', '優先度・日程', 'herdr 投入'])
    for (const suffix of Object.keys(TODO_FORM_FIELDS)) {
      if (suffix === 'ms') continue // マイルストーン欄は新規フォームだけ
      expect(html).toContain(`id="detail-edit-${suffix}"`)
    }
    expect(html).not.toContain('id="detail-edit-ms"')
  })

  test('fills the current values in and escapes them', () => {
    const html = render({ values: { title: 'a<b>&"c"', description: '<x>', urgency: 2, importance: 5, model: '' } })
    expect(html).toContain('value="a&lt;b&gt;&amp;&quot;c&quot;"')
    expect(html).toContain('>&lt;x&gt;</textarea>')
    expect(html).toContain('<option value="2" selected>2</option>')
    expect(html).toContain('<option value="5" selected>5</option>')
    // 未設定の欄は空文字(undefined を文字にしない)
    expect(html).toContain('id="detail-edit-due" type="date" value=""')
    expect(html).not.toContain('undefined')
  })

  test('shows the milestone select only when a milestone option builder is given', () => {
    const html = todoFormFieldsHtml({
      prefix: 'new-todo',
      values: { milestoneId: 7 },
      options: { ...options, milestone: (selected) => `<option value="${selected}">ms</option>` },
    })
    expect(html).toContain('id="new-todo-ms"')
    expect(html).toContain('<option value="7">ms</option>')
    expect(sectionTitles(html)).toEqual(['内容', '優先度・日程', 'herdr 投入'])
  })

  test('short fields share a row: 緊急度/重要度/期限 together, 作業ディレクトリ/モデル together', () => {
    const html = render()
    // 各 .form-row の中身(行を閉じる 4 空白インデントの </div> まで)
    const rows = html.split('class="form-row"').slice(1).map((seg) => seg.split('\n    </div>')[0])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('detail-edit-urgency')
    expect(rows[0]).toContain('detail-edit-importance')
    expect(rows[0]).toContain('detail-edit-due')
    expect(rows[0]).not.toContain('detail-edit-sched-date')
    expect(rows[1]).toContain('detail-edit-ws')
    expect(rows[1]).toContain('detail-edit-model')
  })

  test('todoFormFieldIds maps prefixed ids to draft keys', () => {
    const ids = todoFormFieldIds('detail-edit')
    expect(ids['detail-edit-title']).toBe('title')
    expect(ids['detail-edit-sched-start']).toBe('schedStart')
    expect(ids['detail-edit-ws']).toBe('workspacePath')
    expect(Object.keys(ids)).toHaveLength(Object.keys(TODO_FORM_FIELDS).length)
  })
})
