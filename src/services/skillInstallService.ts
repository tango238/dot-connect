// 設定画面の「スキルをインストール」: 同梱の skills/dot-connect/SKILL.md を
// Claude Code のユーザースキル置き場(<claude config dir>/skills/dot-connect/)
// へ書き出す。テキストとして import しているので、デスクトップ版の compile 済み
// サイドカーにも埋め込まれる。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import skillSource from '../../skills/dot-connect/SKILL.md' with { type: 'text' }

export const SKILL_NAME = 'dot-connect'

export type SkillInstallState = 'not_installed' | 'installed' | 'outdated'

export interface SkillStatus {
  readonly path: string
  readonly state: SkillInstallState
}

function skillFilePath(skillsDir: string): string {
  return join(skillsDir, SKILL_NAME, 'SKILL.md')
}

// 'outdated' は「同梱版と中身が違う」——古い版のほか、ユーザーが手で書き換えた
// 場合も含む。どちらもインストールで同梱版に置き換わる(画面側でそう明示する)。
export function skillStatus(skillsDir: string, source: string = skillSource): SkillStatus {
  const path = skillFilePath(skillsDir)
  if (!existsSync(path)) return { path, state: 'not_installed' }
  return { path, state: readFileSync(path, 'utf8') === source ? 'installed' : 'outdated' }
}

export function installSkill(skillsDir: string, source: string = skillSource): SkillStatus {
  const path = skillFilePath(skillsDir)
  mkdirSync(join(skillsDir, SKILL_NAME), { recursive: true })
  writeFileSync(path, source)
  return skillStatus(skillsDir, source)
}
