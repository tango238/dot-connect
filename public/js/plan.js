// Plan page: a week-scale timeline of milestones, ranged dynamically from
// their start/target dates (with a one-week margin on each side).

import { computeRange, hasValidRange, posPct } from './lib/planRange.js'
import { getState } from './state.js'
import { $, escapeHtml, formatMonthDay, todayIso } from './utils.js'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function weekTicks(start, end) {
  const ticks = []
  let cursor = new Date(start)
  while (cursor.getTime() <= end.getTime()) {
    const mm = String(cursor.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(cursor.getUTCDate()).padStart(2, '0')
    ticks.push(`${mm}/${dd}`)
    cursor = new Date(cursor.getTime() + WEEK_MS)
  }
  return ticks
}

function planRow(m, start, end, today) {
  const pct = m.status === 'done' ? 100 : m.linkedCount ? Math.round((m.doneCount / m.linkedCount) * 100) : 0
  const left = posPct(m.startDate, start, end)
  const width = Math.max(posPct(m.targetDate, start, end) - left, 3)
  const late = m.status !== 'done' && m.targetDate < today
  const metaSuffix = m.status === 'done' ? ' · 完了' : late ? ' · 期限超過' : ''
  return `<div class="plan-row" data-action="goto-milestones">
    <div class="plan-label">
      <div class="pl-name"><span class="ms-dot" style="width:8px;height:8px;border-radius:3px;background:${escapeHtml(m.color)}"></span>${escapeHtml(m.title)}</div>
      <div class="pl-meta ${late ? 'late' : ''}">${formatMonthDay(m.startDate)} → ${formatMonthDay(m.targetDate)}${metaSuffix}</div>
    </div>
    <div class="plan-track">
      <div class="plan-bar ${m.status === 'done' ? 'pb-done' : ''}" style="left:${left}%;width:${width}%">
        <i style="width:${pct}%;background:${escapeHtml(m.color)}"></i>
        ${width >= 12 ? `<span class="pb-pct">${pct}%</span>` : ''}
      </div>
    </div>
  </div>`
}

function invalidDatesNote(excludedCount) {
  if (excludedCount === 0) return ''
  return `<p class="plan-invalid-note">${excludedCount}件のマイルストーンは日付が不正なため表示できません。</p>`
}

export function renderPlan() {
  const allMilestones = getState().milestones
  const milestones = allMilestones.filter(hasValidRange)
  const excludedCount = allMilestones.length - milestones.length
  const today = todayIso()
  const { start, end } = computeRange(milestones, today)

  $('#plan-range').textContent = `${start.toISOString().slice(0, 10)} 〜 ${end.toISOString().slice(0, 10)}`
  $('#plan-weeks').innerHTML = weekTicks(start, end)
    .map((w) => `<span>${w}</span>`)
    .join('')
  $('#plan-invalid-note').innerHTML = invalidDatesNote(excludedCount)

  if (milestones.length === 0) {
    // Only claim "nothing planned yet" when that's actually true — if every
    // milestone was excluded for bad dates, the note above already explains
    // why the timeline is empty (F34).
    $('#plan-body').innerHTML =
      excludedCount === 0 ? `<p class="plan-empty">マイルストーンがまだありません。</p>` : ''
    $('#plan-legend').innerHTML = ''
    return
  }

  const rows = [...milestones].sort(
    (a, b) => Number(a.status === 'done') - Number(b.status === 'done') || (a.targetDate < b.targetDate ? -1 : 1)
  )
  const todayPct = posPct(today, start, end)
  $('#plan-body').innerHTML =
    rows.map((m) => planRow(m, start, end, today)).join('') +
    `<div class="plan-today" style="left: calc(200px + (100% - 200px) * ${todayPct / 100})"></div>`

  $('#plan-legend').innerHTML = `
    <span><i style="background:var(--ms-a)"></i> 進捗(完了TODO率)</span>
    <span><i style="background:var(--bg-hover);border:1px solid var(--border)"></i> 計画期間</span>
    <span><i class="pl-today"></i> 今日 (${formatMonthDay(today)})</span>
    <span style="color:var(--blocked)">期限超過は赤表示</span>`
}

export function initPlan() {
  $('#plan-body').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-action="goto-milestones"]')) {
      document.querySelector('[data-page="milestones"]').click()
    }
  })
}
