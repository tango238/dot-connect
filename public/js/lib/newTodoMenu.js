// The 新規TODO button's two ways of creating TODOs. Pure, so which option is
// offered (and why one is greyed out) stays unit-testable like the other
// modules under lib/.

import { dispatchDisabledReason } from './capabilities.js'

const SKILL_NOT_INSTALLED = 'dot-connect スキルが未インストールです。設定の「スキルをインストール」から入れてください'

/**
 * Why the skill-session option is unavailable, or null when it's usable.
 * `settings === null` (not loaded yet, or the fetch failed) is treated as
 * usable, same as capabilities: the server re-checks and says why.
 * @returns {string | null}
 */
export function skillSessionDisabledReason({ capabilities, settings }) {
  const herdrReason = dispatchDisabledReason(capabilities)
  if (herdrReason) return herdrReason
  if (settings?.skill?.state === 'not_installed') return SKILL_NOT_INSTALLED
  return null
}

/**
 * @returns {Array<{action: 'form' | 'skill-session', label: string, hint: string, disabled: boolean, title?: string}>}
 */
export function newTodoMenuItems({ capabilities, settings }) {
  const skillReason = skillSessionDisabledReason({ capabilities, settings })
  return [
    {
      action: 'form',
      label: '1件を入力して登録',
      hint: 'タイトル・説明などをフォームで入力',
      disabled: false,
    },
    {
      action: 'skill-session',
      label: 'プロンプトから複数登録',
      hint: 'herdr に Claude Code を開き、/dot-connect で依頼文を TODO に分解',
      disabled: skillReason !== null,
      ...(skillReason !== null ? { title: skillReason } : {}),
    },
  ]
}
