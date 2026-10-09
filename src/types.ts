export type TodoStatus = 'open' | 'done'
export type TodoPriority = 'none' | 'low' | 'high'
export type SessionState = 'working' | 'blocked' | 'done' | 'idle' | null
export type MilestoneStatus = 'active' | 'done'
export type PullRequestState = 'open' | 'closed' | 'merged'

export interface Label {
  readonly id: number
  readonly name: string
  readonly color: string
  readonly createdAt: string
  readonly updatedAt: string | null
}

// A registered, reusable working directory offered as input assistance when
// setting a TODO's workspacePath. Deliberately NOT referenced by FK from
// todos: workspacePath is (and remains) a plain string copy, so deleting a
// registered workspace never affects any TODO that already used its path.
export interface Workspace {
  readonly id: number
  readonly name: string
  readonly path: string
  readonly createdAt: string
  readonly updatedAt: string | null
}

export interface Milestone {
  readonly id: number
  readonly title: string
  readonly description: string
  readonly color: string
  readonly startDate: string
  readonly targetDate: string
  readonly status: MilestoneStatus
  readonly doneAt: string | null
  // A milestone carries at most one label (NULL if unset): multiple labels
  // would make label-grouped list views show the same card in more than one
  // group, which doesn't make sense for a flat grouping UI.
  readonly labelId: number | null
  readonly labelName: string | null
  readonly labelColor: string | null
  readonly createdAt: string
}

export interface MilestoneWithProgress extends Milestone {
  readonly linkedCount: number
  readonly doneCount: number
}

// A GitHub Pull Request linked to a TODO. `url` is always the canonical
// form (https://github.com/{owner}/{repo}/pull/{number}) that
// pullRequestUrl.ts normalizes to, so the same PR pasted as a /files or
// #discussion_r… link can't be registered twice on one TODO.
//
// title/state/isDraft are a snapshot fetched from `gh` at registration time
// (refreshed only on explicit request). They are all nullable because
// registering the URL deliberately succeeds even when the fetch does not —
// gh may be missing, unauthenticated, or lack access to a private repo. In
// that case fetchError carries the reason and fetchedAt stays null.
export interface TodoPullRequest {
  readonly id: number
  readonly todoId: number
  readonly url: string
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly title: string | null
  readonly state: PullRequestState | null
  readonly isDraft: boolean | null
  readonly fetchedAt: string | null
  readonly fetchError: string | null
  readonly createdAt: string
}

// storedName はディスク上の実ファイル名(UUID ベース)、originalName は人が
// 付けた元の名前で画面に出す方。path は `<uploadDir>/<storedName>` を読み出し
// 時に組み立てた絶対パスで、DBには保存されていない — 保存先フォルダを設定で
// 変えれば同じ行から別の path が出る。
export interface TodoAttachment {
  readonly id: number
  readonly todoId: number
  readonly storedName: string
  readonly originalName: string
  readonly sizeBytes: number
  readonly createdAt: string
  readonly path: string
}

// TODOに人が書き足す作業ログの1件。追記専用で編集はできない(消すことはでき
// る): 「いつ何をしたか」の記録なので、後から書き換えられると記録としての
// 意味が薄れる。body は改行込みでそのまま保存し、表示側で pre-wrap にする。
export interface TodoComment {
  readonly id: number
  readonly todoId: number
  readonly body: string
  readonly createdAt: string
}

export interface WorkspacePathHistory {
  readonly id: number
  readonly path: string
  readonly usedAt: string
}

export interface Todo {
  readonly id: number
  readonly title: string
  readonly description: string
  readonly milestoneId: number | null
  readonly milestoneTitle: string | null
  readonly milestoneColor: string | null
  readonly status: TodoStatus
  readonly priority: TodoPriority
  // Date-only string (YYYY-MM-DD), no timezone handling. null means no due
  // date is set.
  readonly dueDate: string | null
  readonly workspacePath: string | null
  // Claude Code model alias (opus/sonnet/haiku/fable, or a config-extended
  // value — see modelValidation.ts) to launch with on dispatch. null means
  // "use claude's own default", i.e. no --model flag is passed.
  readonly model: string | null
  readonly herdrWorkspaceId: string | null
  readonly herdrTabId: string | null
  readonly herdrPaneId: string | null
  readonly sessionState: SessionState
  readonly dispatchedAt: string | null
  readonly completedAt: string | null
  // Snapshot of milestoneId taken at completion time, so weekly aggregation
  // and history stay accurate even if the milestone is later deleted or the
  // todo is reassigned/unlinked. Cleared on reopen.
  readonly completedMilestoneId: number | null
  readonly createdAt: string
  // Last time this todo actually moved: an edit, completion/reopen, a PR link
  // or attachment being added or removed, a herdr dispatch, or its herdr
  // session state changing. null until the first such event, so readers use
  // `updatedAt ?? createdAt` as the last-activity time (see lastActivityAt in
  // public/js/lib/todoOrder.js). Deliberately NOT bumped by the periodic PR
  // metadata refresh — that rewrites the PR row without the todo itself
  // moving.
  readonly updatedAt: string | null
  // Grill 中だけ入る、dot-connect が持つ一時ディレクトリ(<db dir>/grill/
  // todo-<id>)。Grill していなければ null。grillService.ts 参照。
  readonly grillDir: string | null
  // Always present (empty when none are linked). Carried on the todo itself
  // rather than fetched separately because the detail dialog holds only a
  // todo id and re-reads everything it shows from the polled todo list —
  // see public/js/todoDetailDialog.js.
  readonly pullRequests: readonly TodoPullRequest[]
  // Same "always present, carried on the todo" contract as pullRequests, and
  // for the same reason (the detail dialog re-reads from the polled list).
  readonly attachments: readonly TodoAttachment[]
  // Same contract again: always present, oldest first, carried on the todo so
  // the detail dialog's 作業ログ panel re-renders from the polled list.
  readonly comments: readonly TodoComment[]
}

export interface WeeklyReport {
  readonly id: number
  readonly weekStart: string
  readonly weekEnd: string
  readonly completedCount: number
  readonly milestoneLinkedCount: number
  readonly unplannedCount: number
  readonly dispatchCount: number
  readonly llmAnalysis: LlmAnalysis | null
  readonly llmError: string | null
  readonly generatedAt: string
}

export interface LlmAnalysis {
  readonly summary: string
  readonly warnings: string[]
  readonly suggestions: string[]
}

export interface PromptSnippet {
  readonly id: number
  readonly title: string
  readonly body: string
  readonly createdAt: string
  readonly updatedAt: string | null
}

export interface PromptHistory {
  readonly id: number
  readonly body: string
  readonly usedAt: string
}
