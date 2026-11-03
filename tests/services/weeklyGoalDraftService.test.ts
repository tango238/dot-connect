import { describe, expect, test } from 'bun:test'
import { createDatabase } from '../../src/db/database'
import * as milestoneRepo from '../../src/db/milestoneRepo'
import * as todoRepo from '../../src/db/todoRepo'
import { buildWeeklyGoalDraft, MAX_PRIORITY_PICKS } from '../../src/services/weeklyGoalDraftService'

// 週: 2026-11-02(月)〜2026-11-08(日)。今日は 11/03。
const WEEK = '2026-11-02'
const TODAY = '2026-11-03'

describe('buildWeeklyGoalDraft', () => {
  test('says so when nothing qualifies', () => {
    const db = createDatabase(':memory:')
    todoRepo.create(db, { title: '普通', dueDate: '2026-12-01' })
    expect(buildWeeklyGoalDraft(db, WEEK, TODAY).body).toBe(
      '## 今週の目標(11/2〜11/8)\n\n- 今週に期限のあるマイルストーン・TODO、緊急度・重要度の高いものはありません。'
    )
  })

  test('picks milestones and todos due this week, overdue ones, and high-priority ones, skipping done items and duplicates', () => {
    const db = createDatabase(':memory:')
    const due = milestoneRepo.create(db, { title: '今週MS', startDate: '2026-10-01', targetDate: '2026-11-06', urgency: 5, importance: 4 })
    milestoneRepo.create(db, { title: '超過MS', startDate: '2026-09-01', targetDate: '2026-10-20' })
    milestoneRepo.create(db, { title: '重要MS', startDate: '2026-10-01', targetDate: '2026-12-20', importance: 4 })
    milestoneRepo.create(db, { title: '普通MS', startDate: '2026-10-01', targetDate: '2026-12-25' })
    const doneMs = milestoneRepo.create(db, { title: '完了MS', startDate: '2026-10-01', targetDate: '2026-11-05', urgency: 5 })
    milestoneRepo.complete(db, doneMs.id)

    const t1 = todoRepo.create(db, { title: '今週A', dueDate: '2026-11-05', milestoneId: due.id })
    const t2 = todoRepo.create(db, { title: '今週B(優先)', dueDate: '2026-11-05', urgency: 5, importance: 2 })
    const t3 = todoRepo.create(db, { title: '超過', dueDate: '2026-10-30', urgency: 4 })
    const t4 = todoRepo.create(db, { title: '急ぎ', urgency: 4 })
    todoRepo.create(db, { title: '普通(期日なし)' })
    todoRepo.create(db, { title: '来週', dueDate: '2026-11-10', urgency: 3, importance: 3 })
    const doneTodo = todoRepo.create(db, { title: '完了', dueDate: '2026-11-04', urgency: 5 })
    todoRepo.complete(db, doneTodo.id)
    for (const t of [t1, t2]) db.run('UPDATE todos SET milestone_id = ? WHERE id = ?', [due.id, t.id])

    expect(buildWeeklyGoalDraft(db, WEEK, TODAY).body).toBe(
      [
        '## 今週の目標(11/2〜11/8)',
        '',
        '### 期限が今週のマイルストーン',
        '- [ ] 今週MS(期限 11/6、進捗 0%、緊5 重4)',
        '',
        '### 期限超過のマイルストーン',
        '- [ ] 超過MS(期限 10/20、進捗 0%)',
        '',
        '### 優先度の高いマイルストーン',
        '- [ ] 重要MS(期限 12/20、進捗 0%、緊1 重4)',
        '',
        '### 今週が期日のTODO',
        `- [ ] #${t2.id} 今週B(優先)(期日 11/5 / 今週MS、緊5 重2)`,
        `- [ ] #${t1.id} 今週A(期日 11/5 / 今週MS)`,
        '',
        '### 期限超過のTODO',
        `- [ ] #${t3.id} 超過(期日 10/30、緊4 重1)`,
        '',
        '### 優先度の高いTODO',
        `- [ ] #${t4.id} 急ぎ(期日なし、緊4 重1)`,
      ].join('\n')
    )
    expect(buildWeeklyGoalDraft(db, WEEK, TODAY).todoIds).toEqual([t2.id, t1.id, t3.id, t4.id])
  })

  test('caps the undated high-priority todos', () => {
    const db = createDatabase(':memory:')
    for (let i = 0; i < MAX_PRIORITY_PICKS + 3; i++) todoRepo.create(db, { title: `p${i}`, importance: 5 })
    const draft = buildWeeklyGoalDraft(db, WEEK, TODAY).body
    expect(draft.match(/^- \[ \] /gm)).toHaveLength(MAX_PRIORITY_PICKS)
  })
})
