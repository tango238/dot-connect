// Weekly report page: latest generated report (with ← → week navigation),
// or an empty/error state. Generation calls out to `claude -p` on the
// backend, which is slow, so it gets its own spinner state.

import { api, ApiError } from './api.js'
import { addDaysToDateStr, laterWeekStart, mondayOf } from './lib/week.js'
import { canGoNext } from './lib/reportNav.js'
import { getState, setState } from './state.js'
import { $, escapeHtml, toast, toastError, todayIso } from './utils.js'

function reportCards(report) {
  const rate = report.completedCount
    ? Math.round((report.milestoneLinkedCount / report.completedCount) * 100)
    : 0
  const unplannedPct = report.completedCount
    ? Math.round((report.unplannedCount / report.completedCount) * 100)
    : 0
  return `<div class="rep-cards">
    <div class="rep-card">
      <div class="rep-num">${report.completedCount}</div>
      <div class="rep-label">完了したTODO</div>
    </div>
    <div class="rep-card">
      <div class="rep-num">${report.milestoneLinkedCount}<small> / ${report.completedCount}</small></div>
      <div class="rep-label">うちマイルストーン関連</div>
      <div class="rep-delta ${rate >= 70 ? 'up' : 'warn'}">関連率 ${rate}%</div>
    </div>
    <div class="rep-card">
      <div class="rep-num">${report.unplannedCount}</div>
      <div class="rep-label">計画外の作業</div>
      <div class="rep-delta warn">全体の ${unplannedPct}%</div>
    </div>
    <div class="rep-card">
      <div class="rep-num">${report.dispatchCount}<small> 回</small></div>
      <div class="rep-label">herdrセッション投入</div>
    </div>
  </div>`
}

function gapItem(icon, text) {
  return `<div class="gap-item"><div class="gap-ico">${icon}</div><div class="gap-body">${escapeHtml(text)}</div></div>`
}

function llmErrorNotice(report) {
  if (!report.llmError) return ''
  return gapItem('⚠️', `AI分析の生成に失敗しました(数値集計は保存済みです): ${report.llmError}`)
}

function analysisSection(report) {
  if (!report.llmAnalysis) {
    // Numbers saved but the AI analysis failed (or was never run) — let the
    // user retry it without re-navigating away and back (F30).
    const retryBtn = `<button class="btn" id="generate-report-btn">AI分析を再生成</button>`
    return `<div class="rep-sec"><h2>方向性 vs 実績の差分 <span class="ai-tag">claude -p 生成</span></h2>
      ${llmErrorNotice(report) || '<p>この週のAI分析はまだありません。</p>'}
      <div style="margin-top:10px">${retryBtn}</div>
    </div>`
  }
  const { summary, warnings, suggestions } = report.llmAnalysis
  const warningItems = (warnings ?? []).map((w) => gapItem('⚠️', w)).join('')
  const suggestionItems = (suggestions ?? []).map((s) => gapItem('💡', s)).join('')
  return `<div class="rep-sec">
    <h2>方向性 vs 実績の差分 <span class="ai-tag">claude -p 生成</span></h2>
    <p>${escapeHtml(summary)}</p>
    ${llmErrorNotice(report)}${warningItems}${suggestionItems}
  </div>`
}

function weekNav(weekStart, latestWeekStart) {
  if (!weekStart) return ''
  return `<div class="rep-week-nav">
    <button class="btn btn-ghost" id="prev-week-btn" aria-label="前週">←</button>
    <span class="rep-week">${escapeHtml(weekStart)}</span>
    <button class="btn btn-ghost" id="next-week-btn" aria-label="次週" ${canGoNext(weekStart, latestWeekStart) ? '' : 'disabled'}>→</button>
  </div>`
}

function reportHeader(report, weekStart, latestWeekStart) {
  return `<div class="page-head" style="margin-bottom:14px">
    <span class="rep-week">${escapeHtml(report.weekStart)} 〜 ${escapeHtml(report.weekEnd)}</span>
    ${weekNav(weekStart, latestWeekStart)}
  </div>`
}

function emptyState(weekStart, latestWeekStart) {
  return `${weekNav(weekStart, latestWeekStart)}
  <div class="rep-empty">
    <p>${weekStart ? `${escapeHtml(weekStart)} 週のレポートはありません。` : 'まだ週次レポートが生成されていません。'}</p>
    <button class="btn btn-accent" id="generate-report-btn">レポート生成</button>
  </div>`
}

function errorState(weekStart, latestWeekStart) {
  return `${weekNav(weekStart, latestWeekStart)}
  <div class="rep-empty">
    <p>レポートの取得に失敗しました。</p>
    <button class="btn btn-accent" id="retry-report-btn">再試行</button>
  </div>`
}

function generatingState() {
  return `<div class="rep-empty"><p><span class="spinner"></span>レポートを生成しています… claude -p の実行のため数十秒かかる場合があります</p></div>`
}

export function renderReport() {
  const { report, reportStatus, reportWeekStart, reportLatestWeekStart } = getState()
  const container = $('#report-content')

  if (reportStatus === 'loading') {
    container.innerHTML = `<p class="page-sub">読み込み中…</p>`
    return
  }
  if (reportStatus === 'generating') {
    container.innerHTML = generatingState()
    return
  }
  if (reportStatus === 'error') {
    container.innerHTML = errorState(reportWeekStart, reportLatestWeekStart)
    return
  }
  if (reportStatus === 'empty' || !report) {
    container.innerHTML = emptyState(reportWeekStart, reportLatestWeekStart)
    return
  }
  container.innerHTML =
    reportHeader(report, reportWeekStart, reportLatestWeekStart) +
    reportCards(report) +
    analysisSection(report)
}

async function loadWeek(weekStart) {
  setState({ reportStatus: 'loading', reportWeekStart: weekStart })
  try {
    const report = await api.getReportByWeek(weekStart)
    const { reportLatestWeekStart } = getState()
    setState({
      report,
      reportStatus: 'ready',
      reportWeekStart: report.weekStart,
      reportLatestWeekStart: laterWeekStart(reportLatestWeekStart, report.weekStart),
    })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      setState({ report: null, reportStatus: 'empty', reportWeekStart: weekStart })
    } else {
      toastError(err.message)
      setState({ reportStatus: 'error', reportWeekStart: weekStart })
    }
  }
}

export async function ensureReportLoaded() {
  if (getState().reportStatus !== 'idle') return
  setState({ reportStatus: 'loading' })
  try {
    const report = await api.getLatestReport()
    setState({
      report,
      reportStatus: 'ready',
      reportWeekStart: report.weekStart,
      reportLatestWeekStart: report.weekStart,
    })
  } catch (err) {
    // todayIso() reads local wall-clock date; new Date().toISOString() would
    // read UTC and land a day early during JST 00:00-09:00 (F28).
    const anchorWeek = mondayOf(todayIso())
    if (err instanceof ApiError && err.status === 404) {
      setState({
        report: null,
        reportStatus: 'empty',
        reportWeekStart: anchorWeek,
        reportLatestWeekStart: null,
      })
    } else {
      toastError(err.message)
      setState({ reportStatus: 'error', reportWeekStart: anchorWeek, reportLatestWeekStart: null })
    }
  }
}

function prevWeek() {
  const { reportWeekStart } = getState()
  if (!reportWeekStart) return
  loadWeek(addDaysToDateStr(reportWeekStart, -7))
}

function nextWeek() {
  const { reportWeekStart, reportLatestWeekStart } = getState()
  if (!canGoNext(reportWeekStart, reportLatestWeekStart)) return
  loadWeek(addDaysToDateStr(reportWeekStart, 7))
}

/** After a failed generate call, check once whether the report actually made
 * it to the DB — a dropped connection (timeout, etc.) can fail the request
 * even though the backend finished the work, and re-showing an error for a
 * report that already exists would be misleading (F37). */
async function recoverAfterGenerateFailure(targetWeek) {
  try {
    const report = targetWeek ? await api.getReportByWeek(targetWeek) : await api.getLatestReport()
    const { reportLatestWeekStart } = getState()
    setState({
      report,
      reportStatus: 'ready',
      reportWeekStart: report.weekStart,
      reportLatestWeekStart: laterWeekStart(reportLatestWeekStart, report.weekStart),
    })
    toast('レポートは生成されていました(接続エラーで失敗表示になっていましたが、実際は保存済みでした)')
  } catch {
    // Genuinely not there — keep the error toast already shown and fall
    // back to whatever we had before generating.
    setState({ reportStatus: getState().report ? 'ready' : 'empty' })
  }
}

async function generateReport() {
  const targetWeek = getState().reportWeekStart
  setState({ reportStatus: 'generating' })
  try {
    const report = await api.generateReport(targetWeek)
    const { reportLatestWeekStart } = getState()
    setState({
      report,
      reportStatus: 'ready',
      reportWeekStart: report.weekStart,
      reportLatestWeekStart: laterWeekStart(reportLatestWeekStart, report.weekStart),
    })
  } catch (err) {
    toastError(err.message)
    await recoverAfterGenerateFailure(targetWeek)
  }
}

// ネイティブメニューから呼ばれる版: 画面がどの週を表示していても最新週を
// 対象にする。weekStart を渡さないと API 側が最新週を選ぶ(api.js の
// generateReport 参照)。レポート画面を開いていなくても呼ばれうるので、
// 進行状況は state ではなくトーストで知らせる。
//
// claude -p の実行に数十秒かかるうえクライアント側にタイムアウトが無く、
// トーストは4秒ほどで消えて画面上には進行中を示すものが何も残らない。その
// 隙にメニューを再度選ぶと同じ週に対して2本目の claude -p が走ってしまう
// ため、todoDetailDialog.js の busy フラグと同じパターンで多重起動を防ぐ。
let regeneratingLatestReport = false

export async function regenerateLatestReport() {
  if (regeneratingLatestReport) {
    toast('再生成中です')
    return
  }
  regeneratingLatestReport = true
  toast('週次レポートを再生成しています…')
  try {
    const report = await api.generateReport(null)
    const { reportLatestWeekStart } = getState()
    setState({
      report,
      reportStatus: 'ready',
      reportWeekStart: report.weekStart,
      reportLatestWeekStart: laterWeekStart(reportLatestWeekStart, report.weekStart),
    })
    toast('週次レポートを再生成しました')
  } catch (err) {
    toastError(err.message)
    // Passing null here would make recoverAfterGenerateFailure fall back to
    // getLatestReport() — which returns the newest EXISTING report, not
    // necessarily the week this call targeted. If week W was never
    // generated and this request fails before the upsert, that would
    // resolve to W-1's report and misreport success (worse than F37's
    // original problem: a false success instead of a false failure). Anchor
    // on the actual current week instead, same as ensureReportLoaded's F28
    // anchor — getReportByWeek(W) then correctly 404s when nothing was
    // saved, so the pre-fix "genuinely failed" toast is preserved.
    await recoverAfterGenerateFailure(mondayOf(todayIso()))
  } finally {
    regeneratingLatestReport = false
  }
}

export function initReport() {
  $('#report-content').addEventListener('click', (ev) => {
    if (ev.target.id === 'generate-report-btn') generateReport()
    else if (ev.target.id === 'retry-report-btn') loadWeek(getState().reportWeekStart)
    else if (ev.target.id === 'prev-week-btn') prevWeek()
    else if (ev.target.id === 'next-week-btn') nextWeek()
  })
}
