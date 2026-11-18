// 「プロンプトから複数登録」: dot-connect スキル(/dot-connect)で依頼文を
// 複数の TODO に分解・登録するための herdr セッションを開く。
//
// スキルの記録ファイル置き場(notesDir)を cwd にして Claude Code を起動し、
// 入力欄に「/dot-connect 」とだけ打ち込んで止める。依頼文はユーザーが続けて
// 入力して送信する。TODO はまだ無いので、このセッションは DB に記録しない
// (WIP にも数えず、dot-connect 側から閉じることもしない)。

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ExecFn } from '../herdr/exec'
import type { CreatedWorkspace, HerdrClient } from '../herdr/herdrClient'
import { assertPromptTextSupported } from '../herdr/promptArgs'
import { logger } from '../logger'
import { type AgentLaunchOptions, startAgentInPane } from './dispatchService'
import { ConflictError } from './errors'
import { activateTerminal } from './sessionService'
import { skillStatus } from './skillInstallService'
import { ensureNotesDir } from './skillNotesService'

export const SKILL_SESSION_LABEL = 'dot-connect: TODO 一括登録'
// 末尾の空白が要点: Claude Code はスラッシュコマンドの補完メニューを出すが、
// 空白を打つとそれが閉じて、続きが引数(依頼文)として入力できる状態になる。
export const SKILL_INVOCATION_TEXT = '/dot-connect '

export interface SkillSessionOptions extends AgentLaunchOptions {
  readonly claudeBin: string
  /** スキルが入っているか確認する先(<claude config dir>/skills)。 */
  readonly claudeSkillsDir: string
  /** セッションの cwd。無ければ作る。 */
  readonly notesDir: string
  readonly terminalApp: string | null
  readonly exec: ExecFn
}

export type SkillSessionResult = CreatedWorkspace

function ensureSkillInstalled(claudeSkillsDir: string): void {
  const status = skillStatus(claudeSkillsDir)
  // 'outdated' は中身が同梱版と違うだけで、/dot-connect 自体は使える。
  if (status.state === 'not_installed') {
    throw new ConflictError(
      'dot-connect スキルがインストールされていません。設定の「スキルをインストール」を押してから使ってください',
      { code: 'skill_not_installed', path: status.path }
    )
  }
}

export async function startSkillSession(herdr: HerdrClient, options: SkillSessionOptions): Promise<SkillSessionResult> {
  ensureSkillInstalled(options.claudeSkillsDir)
  assertPromptTextSupported(SKILL_INVOCATION_TEXT)
  await herdr.assertDispatchCompatible?.()
  ensureNotesDir(options.notesDir)
  return openClaudeSession(herdr, options, {
    cwd: options.notesDir,
    label: SKILL_SESSION_LABEL,
    initialText: SKILL_INVOCATION_TEXT,
  })
}

// 「対応してから登録」: 先に作業してから TODO にする。dot-connect が作った
// 空のテンポラリディレクトリで Claude Code を開くだけで、入力欄には何も
// 打たない。作業が済んだらユーザーがそこで /dot-connect を呼び、スキルが
// 目印ファイル(ADHOC_MARKER_FILE)を見て「このセッションの要約を完了済み
// TODO として登録する」モードに入る(SKILL.md 手順8)。
export const ADHOC_SESSION_LABEL = 'dot-connect: 対応してから登録'
export const ADHOC_MARKER_FILE = '.dot-connect-adhoc'
const ADHOC_DIR_PREFIX = 'dot-connect-adhoc-'

export interface AdhocSessionOptions extends SkillSessionOptions {
  /** テンポラリディレクトリを作る親。既定は OS の一時ディレクトリ。 */
  readonly tempRoot?: string
  readonly now?: () => Date
}

export interface AdhocSessionResult extends CreatedWorkspace {
  readonly cwd: string
}

export function createAdhocDir(tempRoot: string = tmpdir(), now: Date = new Date()): string {
  const dir = mkdtempSync(join(tempRoot, ADHOC_DIR_PREFIX))
  writeFileSync(
    join(dir, ADHOC_MARKER_FILE),
    `${JSON.stringify({ kind: 'dot-connect-adhoc', createdAt: now.toISOString() })}\n`
  )
  return dir
}

export async function startAdhocSession(herdr: HerdrClient, options: AdhocSessionOptions): Promise<AdhocSessionResult> {
  // 最後に /dot-connect で登録するので、スキルが無ければ始める前に止める。
  ensureSkillInstalled(options.claudeSkillsDir)
  await herdr.assertDispatchCompatible?.()
  const cwd = createAdhocDir(options.tempRoot, options.now?.() ?? new Date())
  const workspace = await openClaudeSession(herdr, options, { cwd, label: ADHOC_SESSION_LABEL, initialText: null })
  return { ...workspace, cwd }
}

interface SessionTarget {
  readonly cwd: string
  readonly label: string
  /** 入力欄に打ち込むだけで送信しない文字列。null なら何も打たない。 */
  readonly initialText: string | null
}

// どちらのセッションも TODO に属さないので DB に記録しない(WIP にも数えず、
// dot-connect 側から閉じることもしない)。
async function openClaudeSession(
  herdr: HerdrClient,
  options: SkillSessionOptions,
  target: SessionTarget
): Promise<CreatedWorkspace> {
  logger.info('Creating herdr workspace for a dot-connect skill session', { cwd: target.cwd, label: target.label })
  const workspace = await herdr.createWorkspace({ cwd: target.cwd, label: target.label })

  try {
    // モデルは Claude Code の既定。スキルは TODO の分解と登録をするだけなので、
    // 投入時のモデル指定とは無関係。
    // cwd は dot-connect が持つディレクトリなので、初回だけ出る信頼確認は
    // こちらで承認する(ユーザーがダイアログに気付くまでタイムアウトしない)。
    await startAgentInPane(herdr, workspace, options.claudeBin, 'Claude Code', null, {
      ...options,
      acceptTrustDialog: true,
    })
    if (target.initialText !== null) await herdr.sendText(workspace.paneId, target.initialText)
  } catch (err) {
    logger.warn('Closing the skill session workspace after a failed start', {
      workspaceId: workspace.workspaceId,
      message: err instanceof Error ? err.message : String(err),
    })
    try {
      await herdr.closeWorkspace(workspace.workspaceId)
    } catch (closeErr) {
      logger.error('Failed to close the skill session workspace', {
        workspaceId: workspace.workspaceId,
        message: closeErr instanceof Error ? closeErr.message : String(closeErr),
      })
    }
    throw err
  }

  // 続きはユーザーが打つので、セッションを前に出す。ここで失敗しても
  // セッション自体は使えるので、警告だけ残して成功扱いにする。
  try {
    await herdr.focusTab(workspace.tabId)
    await activateTerminal({ terminalApp: options.terminalApp, exec: options.exec })
  } catch (err) {
    logger.warn('Could not bring the skill session to the front', {
      tabId: workspace.tabId,
      message: err instanceof Error ? err.message : String(err),
    })
  }

  return workspace
}
