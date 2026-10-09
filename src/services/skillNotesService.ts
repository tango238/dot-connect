// dot-connect スキル(skills/dot-connect/SKILL.md)が TODO を提案するときに
// 読み、登録後に書き足す記録ファイルの置き場所。ユーザーが Finder から直接
// 編集できるよう、DB ではなく素の Markdown にしている。
//
// 場所は既定で ~/.local/dot-connect/notes(DOT_CONNECT_NOTES_DIR で変更可)。
// スキルは GET /api/settings の notesDir でこの場所を知る。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecFn } from '../herdr/exec'
import { BadRequestError } from './errors'

export const NOTES_TEMPLATES: Readonly<Record<string, string>> = {
  'workspaces.md': `# 作業ディレクトリの使い分け

dot-connect スキルが TODO の作業ディレクトリを決めるときに読みます。
「作業の特徴・キーワード → 絶対パス」の形で書いてください。上にあるものほど優先されます。
提案を直すと、スキルがここにルールを書き足します。

<!-- 例:
- dot-connect の機能追加・不具合修正 → /Users/you/work/dot-connect
- ブログ記事の下書き → /Users/you/Documents/blog
-->
`,
  'models.md': `# LLMモデルの選び方

dot-connect スキルが TODO のモデルを決めるときに読みます。
「作業の種類 → モデル(理由)」の形で書いてください。使える値は dot-connect の
モデル一覧(opus / sonnet / haiku / fable / codex など)です。
提案を直すと、スキルがここにルールを書き足します。

<!-- 例:
- 設計判断を含む大きな変更 → opus(判断の質を優先)
- 定型的なUI追加・テスト追加 → sonnet
- 文言修正・小さな設定変更 → haiku
-->
`,
  'history.md': `# 登録履歴

dot-connect スキルが登録した TODO の記録です(1件1行、末尾に追記)。
次回以降、似た作業のモデル・作業ディレクトリを決める参考にします。

`,
}

/** Creates the directory and any missing template file. Never overwrites. */
export function ensureNotesDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(NOTES_TEMPLATES)) {
    const path = join(dir, name)
    if (!existsSync(path)) writeFileSync(path, content)
  }
}

export async function openNotesDirInFinder(dir: string, platform: string, exec: ExecFn): Promise<void> {
  if (platform !== 'darwin') {
    throw new BadRequestError('Finder で開く機能は macOS でのみ利用できます')
  }
  ensureNotesDir(dir)
  const result = await exec(['open', dir], { timeoutMs: 5000 })
  if (result.exitCode !== 0) {
    throw new Error(`open failed (exit ${result.exitCode}): ${result.stderr}`)
  }
}
