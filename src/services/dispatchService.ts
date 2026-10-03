import type { Database } from 'bun:sqlite'
import * as dispatchEventRepo from '../db/dispatchEventRepo'
import * as promptHistoryRepo from '../db/promptHistoryRepo'
import * as workspacePathHistoryRepo from '../db/workspacePathHistoryRepo'
import * as todoRepo from '../db/todoRepo'
import type { CreatedWorkspace, HerdrAgentStatus, HerdrClient } from '../herdr/herdrClient'
import { logger } from '../logger'
import type { Todo } from '../types'
import { BadRequestError, ConflictError, NotFoundError } from './errors'
import { herdrWorkspaceLabel } from './herdrWorkspaceLabel'
import { assertAllowedModel, CODEX_MODEL, DEFAULT_ALLOWED_MODELS } from './modelValidation'

const DEFAULT_AGENT_READY_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 500
// agent_status === 'idle' means herdr has detected the claude process, not
// that its TUI can accept input yet (it may still be showing a splash
// screen). Without this extra wait, text sent immediately after idle is
// detected gets swallowed by the still-initializing TUI.
const DEFAULT_SETTLE_MS = 1500
// TUIs need text and the Enter keystroke sent as two distinct steps (see
// typeTaskPrompt below). A fixed delay isn't enough for a long,
// multi-paragraph prompt — Claude Code's TUI can still be mid-paste when a
// too-early Enter arrives, and the Enter gets swallowed entirely. (This is
// exactly how a real double-send happened: the dropped Enter left the text
// sitting in the input box, and a naive retry that retyped the text
// concatenated a second copy into one message.) The delay now scales with
// prompt length: max(base, length * perChar), capped at max.
const DEFAULT_KEYSTROKE_DELAY_BASE_MS = 300
const DEFAULT_KEYSTROKE_DELAY_PER_CHAR_MS = 3
const DEFAULT_KEYSTROKE_DELAY_MAX_MS = 3000
const DEFAULT_DELIVERY_CONFIRM_TIMEOUT_MS = 10_000
// How many times the prompt text may be typed into the input box before the
// dispatch is abandoned (the first attempt plus two retypes). Each attempt is
// verified against the pane before Enter is allowed anywhere near it — see
// typeAndVerifyTaskPrompt.
const MAX_PROMPT_TYPING_ATTEMPTS = 3
// Clears the whole input line. Verified against the real herdr CLI: 'C-u'
// and 'ctrl-u' are both rejected as invalid_key, 'Ctrl+u' is accepted.
const CLEAR_INPUT_KEY = 'Ctrl+u'

export interface DispatchOptions {
  readonly claudeBin: string
  /** Launched instead of claudeBin when the resolved model is "codex".
   * Defaults to 'codex'. */
  readonly codexBin?: string
  readonly agentReadyTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  /** Custom task text to send instead of the todo's title. Recorded to
   * prompt_history once the dispatch fully succeeds (never on rollback). */
  readonly promptBody?: string
  /** Overrides the todo's stored workspacePath for this dispatch, and
   * persists the override onto the todo (so it becomes the default for the
   * next dispatch too). Omit to use the todo's already-stored path. */
  readonly workspacePath?: string
  /** Overrides the todo's stored model for this dispatch, and persists the
   * override onto the todo (same convention as workspacePath above). Omit
   * to use the todo's already-stored model (null means claude's default —
   * no --model flag). Validated against allowedModels before use. */
  readonly model?: string
  /** Claude Code model aliases this dispatch may launch with — see
   * modelValidation.ts. Defaults to DEFAULT_ALLOWED_MODELS; callers should
   * normally pass the server's configured (and possibly
   * DOT_CONNECT_ALLOWED_MODELS-extended) list instead of relying on that
   * default. */
  readonly allowedModels?: readonly string[]
  /** Extra wait after agent_status becomes 'idle', before typing anything. */
  readonly settleMs?: number
  /** Floor for the wait between typing the prompt text and sending the
   * Enter keystroke (see computeKeystrokeDelayMs). */
  readonly keystrokeDelayBaseMs?: number
  /** Additional per-character wait added to the floor, for long prompts. */
  readonly keystrokeDelayPerCharMs?: number
  /** Upper bound on the computed keystroke delay, however long the prompt. */
  readonly keystrokeDelayMaxMs?: number
  /** How long to poll for delivery confirmation (see isDeliveryConfirmed)
   * after sending, before giving up on confirming delivery. */
  readonly deliveryConfirmTimeoutMs?: number
}

/** A dispatched Todo, plus whether the task prompt was confirmed delivered
 * to the claude TUI. `false` does not mean the dispatch failed — claude is
 * running and the workspace is usable — only that we could not confirm it
 * picked up the prompt after one retry. Callers (the API layer) should
 * surface this to the user as a "please check the session" warning. */
export interface DispatchResult extends Todo {
  readonly promptDelivered: boolean
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g
// Generous but finite: a custom prompt can reference {{title}}/
// {{description}} many times, so the *expanded* result — not just the
// template — needs its own cap independent of title/description's own
// (much smaller) length limits, or a pathological template could still
// amplify into a huge `sendText` argument.
const MAX_TASK_PROMPT_LENGTH = 8000

// Single-pass substitution: String.replace scans the ORIGINAL template once
// and inserts each match's replacement verbatim into the output — it never
// re-scans a replacement's own text for further matches. That matters for
// symmetry: {{description}} appearing literally inside the title (or
// {{title}} inside the description) must not get a second, unintended
// substitution. A lookup + replacer function (not a replacement string) also
// means a literal "$1"/"$&" etc. in the title/description can't be
// misinterpreted as a String.replace pattern. Unknown {{keys}} are left as-is
// — checked via hasOwnProperty rather than `lookup[key] ?? match`, since the
// latter also resolves Object.prototype-inherited keys like {{constructor}}/
// {{toString}}/{{__proto__}} to native function/object source text.
function substitutePlaceholders(template: string, todo: Todo): string {
  const lookup: Record<string, string> = { title: todo.title, description: todo.description }
  return template.replace(PLACEHOLDER_PATTERN, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(lookup, key) ? lookup[key]! : match
  )
}

function buildTaskPrompt(todo: Todo, promptBody?: string): string {
  // A custom prompt gets {{title}}/{{description}} substitution; a
  // title-only dispatch has nothing to substitute into.
  const rawBody = promptBody !== undefined ? substitutePlaceholders(promptBody, todo) : todo.title
  // sendText types this as one literal string (see typeTaskPrompt), so any
  // newline resulting from the above (in the raw title, in a multi-line
  // snippet, or introduced by substitution) is flattened to a single space.
  const prompt = rawBody.replace(/\s*\n\s*/g, ' ')
  if (prompt.length > MAX_TASK_PROMPT_LENGTH) {
    throw new BadRequestError('プロンプトが長すぎます')
  }
  return prompt
}

function ensureDispatchable(todo: Todo | null, todoId: number): Todo {
  if (todo === null) {
    throw new NotFoundError(`Todo ${todoId} not found`)
  }
  if (todo.sessionState === 'working') {
    throw new ConflictError(`Todo ${todoId} is already dispatched and running`)
  }
  return todo
}

// A dispatch-time workspacePath override takes priority over whatever is
// already stored on the todo, so a todo can be created without one and get
// its workspace assigned only when actually dispatched. Neither present is
// still the same hard failure as before.
function resolveWorkspacePath(todo: Todo, override: string | undefined): string {
  const path = override ?? todo.workspacePath
  if (path === null || path === undefined) {
    throw new BadRequestError('workspacePath を設定してください')
  }
  return path
}

// herdr's own `agent wait`/`wait agent-status` CLI fails immediately with
// agent_not_found right after starting claude (herdr hasn't detected/attached
// the agent yet), so it can't be used to wait for readiness here. Instead,
// poll `herdr.snapshot()` directly until the pane's agentStatus is 'idle'.
async function waitForAgentIdle(
  herdr: HerdrClient,
  paneId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
  agentName: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await herdr.snapshot()
    const pane = snapshot.panes.find((p) => p.paneId === paneId)
    if (pane?.agentStatus === 'idle') {
      return
    }
    if (Date.now() >= deadline) {
      throw new ConflictError(`${agentName} の起動を確認できませんでした`)
    }
    await sleep(pollIntervalMs)
  }
}

// 'working' means claude started processing the prompt — the clearest
// signal it was received. 'blocked' (a permission dialog) and 'done' (a
// short task that finished inside the poll window) can *only* be reached
// after the pane received the prompt too, so both also count as delivered
// (F48: treating them as "not confirmed" made deliverTaskPrompt retype the
// prompt into an open permission dialog, or dispatch the same task twice).
function isDeliveryConfirmed(status: HerdrAgentStatus | undefined): boolean {
  return status === 'working' || status === 'blocked' || status === 'done'
}

// Polls snapshot() for a status that answers "did claude receive the
// prompt?" — returning as soon as that's confirmed (see
// isDeliveryConfirmed) or the timeout elapses, whichever comes first.
// Unlike waitForAgentIdle, timing out here is not a hard failure (claude is
// running either way) — the caller decides whether the final status makes
// it safe to retry (see deliverTaskPrompt).
async function pollAgentStatus(
  herdr: HerdrClient,
  paneId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<HerdrAgentStatus | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await herdr.snapshot()
    const status = snapshot.panes.find((p) => p.paneId === paneId)?.agentStatus
    if (isDeliveryConfirmed(status) || Date.now() >= deadline) {
      return status
    }
    await sleep(pollIntervalMs)
  }
}

// The clear is a single keystroke, so it gets the floor that
// computeKeystrokeDelayMs applies to any keystroke — without the
// per-character scaling, which is about how long a long PASTE takes to
// render and has nothing to do with Ctrl+u. Reusing the existing knob keeps
// the zeroed-out test options fast with no new tunable to thread through.
function computeClearSettleMs(options: DispatchOptions): number {
  return options.keystrokeDelayBaseMs ?? DEFAULT_KEYSTROKE_DELAY_BASE_MS
}

function computeKeystrokeDelayMs(promptLength: number, options: DispatchOptions): number {
  const base = options.keystrokeDelayBaseMs ?? DEFAULT_KEYSTROKE_DELAY_BASE_MS
  const perChar = options.keystrokeDelayPerCharMs ?? DEFAULT_KEYSTROKE_DELAY_PER_CHAR_MS
  const max = options.keystrokeDelayMaxMs ?? DEFAULT_KEYSTROKE_DELAY_MAX_MS
  return Math.min(max, Math.max(base, promptLength * perChar))
}

// TUIs (like Claude Code's) need literal text and the Enter keystroke sent
// as two separate steps: a single "text+Enter in one shot" command (as
// `herdr pane run` sends) can arrive before the TUI has fully rendered its
// input handling for the newly-typed text, swallowing the submission. They
// are separated further still here — the two steps are separate *functions*,
// with the verification below wedged between them — because Enter must not be
// sent at all until the text is known to have landed whole.
async function typeTaskPrompt(
  herdr: HerdrClient,
  paneId: string,
  taskPrompt: string,
  keystrokeDelayMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  await herdr.sendText(paneId, taskPrompt)
  await sleep(keystrokeDelayMs)
}

// Whitespace-normalized so line-wrapping in the terminal's rendered output
// doesn't break a plain substring comparison.
function normalizeForComparison(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// `herdr pane read --source visible` only returns what's currently on screen,
// NOT scrollback, so neither matcher can require the WHOLE prompt to be
// visible; both compare a short window instead. Exported as pure functions so
// the heuristics can be tested directly against realistic terminal-wrapped
// snippets, independent of HerdrClient/dispatchTodo.
//
// Which END to compare is where the two differ, and the head is now known to
// be the WRONG choice for a prompt still sitting in the input box: the TUI
// keeps the cursor in view, so once the text renders past the pane height its
// head is off screen entirely (measured — see findObservedPromptWindow below).
// matchesInputBoxPrefix keeps the head anyway because its one caller,
// isPromptStillInInputBox, guards the pre-existing post-Enter resend path,
// which this change deliberately left alone: there, a false "the box is clear"
// means the Enter resend is skipped and the user gets promptDelivered: false
// plus a warning — annoying, but not a wrong or doubled submission. Switching
// it to the tail matcher (same situation, cursor at the end) is the follow-up.
// Note the head matcher is doubly weak for Japanese, for the whitespace reason
// spelled out under stripForTailComparison, and that this change makes the
// weakness MORE likely to bite: the box is now guaranteed to hold the whole
// prompt, which is exactly the case that renders past the pane height.
export const INPUT_BOX_MATCH_LENGTH = 40

export function matchesInputBoxPrefix(paneText: string, taskPrompt: string): boolean {
  const prefix = normalizeForComparison(taskPrompt).slice(0, INPUT_BOX_MATCH_LENGTH)
  return prefix.length > 0 && normalizeForComparison(paneText).includes(prefix)
}

// Before Enter is even sent, herdr types the prompt text into the pane one
// keystroke batch at a time; if that typing itself gets cut short (e.g. the
// TUI wasn't ready to receive input yet), what's missing is the TAIL of the
// prompt, not the start. And right after typing finishes, the terminal
// cursor sits at the END of the input box, so the tail is the part of a long
// prompt still guaranteed to be on screen. Exported as a pure function for
// the same testability reasons as matchesInputBoxPrefix.
//
// Deliberately mirrors matchesInputBoxPrefix's contract: the whole
// up-to-INPUT_BOX_MATCH_LENGTH-character block must appear verbatim
// somewhere in the pane, not merely a coincidental trailing character or
// two. A weaker match here is the expensive direction to get wrong — it
// would make us conclude a truncated prompt is still safely sitting in the
// input box and skip resending it.
//
// It does NOT share normalizeForComparison, though. Collapsing a whitespace
// run to a single space only survives a wrap because terminals break English
// AT a space, so the inserted newline lands where the prompt already had one.
// Japanese has no space to break at, so a wrap inside the match window
// injects whitespace the prompt never contained and the block stops
// appearing verbatim — and since 40 CJK characters occupy 80 display cells,
// any pane narrower than ~80 cells has the window spanning a wrap every
// time. Measured against a 1339-character Japanese prompt, collapsing
// accepted a COMPLETE, correctly typed prompt 0 times out of 40 at 76, 100
// and 120 cells; stripping accepts 40/40. Stripping the box-drawing glyphs
// (U+2500-U+257F) too is what handles the │ borders Claude Code draws down
// the sides of its input box, which land mid-window on every wrapped line.
function stripForTailComparison(text: string): string {
  return text.replace(/[\s\u2500-\u257F]+/g, '')
}

// Known limitation, deliberately not closed here: this asks whether the tail
// appears ANYWHERE in the visible pane, not whether it is in the input box.
// The original incident's own pane had swallowed prompt characters rendered
// mixed into Claude Code's startup banner, so a race that echoes the tail
// outside the box while the box holds only a fragment would pass this check.
// That is no worse than the behaviour before this function existed (there was
// no check at all), and constraining the match to the last N characters of the
// pane is guesswork about N that would reject healthy prompts — the same shape
// as the CJK defect stripForTailComparison exists to fix. Closing it needs
// measurement on real panes; until then the failure log below carries a pane
// excerpt so production can tell us whether it ever happens.
export function expectedInputBoxTail(taskPrompt: string): string {
  return stripForTailComparison(taskPrompt).slice(-INPUT_BOX_MATCH_LENGTH)
}

export function matchesInputBoxTail(paneText: string, taskPrompt: string): boolean {
  const tail = expectedInputBoxTail(taskPrompt)
  return tail.length > 0 && stripForTailComparison(paneText).includes(tail)
}

// Every dispatch now passes through `pane read`, and a mismatch fails the
// dispatch outright — so any drift in what herdr returns (ANSI sequences
// surviving, a `--source visible` semantics change, Claude Code redrawing its
// input box with glyphs outside U+2500-U+257F) stops being cosmetic and
// becomes a total dispatch outage. Lengths and attempt counts alone can't tell
// those apart from a genuine truncation, so the warning carries a bounded
// sample of the text that failed to match. The ends are where truncation and
// stray chrome show up; the stripped length says at a glance how much arrived.
const PANE_EXCERPT_LENGTH = 120

export function describePaneRead(paneText: string | null): Record<string, unknown> {
  if (paneText === null) {
    return { paneRead: 'failed' }
  }
  const stripped = stripForTailComparison(paneText)
  if (stripped.length <= PANE_EXCERPT_LENGTH * 2) {
    return { paneStrippedLength: stripped.length, pane: stripped }
  }
  return {
    paneStrippedLength: stripped.length,
    paneHead: stripped.slice(0, PANE_EXCERPT_LENGTH),
    paneTail: stripped.slice(-PANE_EXCERPT_LENGTH),
  }
}

// The other half of the pre-submit check: after Ctrl+u, is the input box
// actually empty? matchesInputBoxTail cannot answer that — it is a substring
// test, so a box still holding a fragment when the prompt is retyped on top
// reads as "fragment + prompt", whose tail is present, and Enter would submit
// the concatenation. That exact accident (two copies glued into one message)
// has happened in this codebase before, so the clear is verified rather than
// assumed.
//
// The probe is anchored to what the pane was actually SHOWING before the
// clear, never to a fixed end of the prompt. `pane read --source visible`
// returns only the rows currently on screen, and the TUI keeps the CURSOR —
// the END of the text — in view, so as soon as the prompt renders to more
// rows than are visible, its head is not on screen at all and a head-anchored
// probe reports "cleared" whichever way Ctrl+u went. Measured with a
// non-repetitive Japanese prompt rendering to 21 rows at 76 cells, against a
// box that still held the whole prompt: a head-anchored probe was correct at
// a 24-row pane and fooled at 20, 19, 18, 15 and (at 100 cells) 10 rows —
// i.e. wrong for every pane smaller than the rendered text, which is the
// normal case for the prompt class this protects. Anchoring to an observed
// window is correct at all of those sizes.
//
// The windows are taken from the PANE, not the prompt, and scanned from its
// end backwards. Two reasons. The cursor end is where our text is, so the
// first hit normally comes within a few steps. And windows cut from the
// prompt only line up with a leftover fragment by luck: tiling a 781-char
// prompt from its tail puts the lowest boundary at offset 21, so a 60-char
// fragment — which plainly contains a 40-character run of the prompt —
// contains no tiled window and reads as "nothing to anchor to". Cutting from
// the pane makes detection independent of that alignment, and bounds the scan
// by the size of a screenful rather than by the prompt.
//
// Returns null when the pane was showing less than one window's worth of the
// prompt — there is then nothing to anchor to.
function findObservedPromptWindow(paneText: string, taskPrompt: string): string | null {
  const pane = stripForTailComparison(paneText)
  const prompt = stripForTailComparison(taskPrompt)
  for (let end = pane.length; end >= INPUT_BOX_MATCH_LENGTH; end -= 1) {
    const window = pane.slice(end - INPUT_BOX_MATCH_LENGTH, end)
    if (prompt.includes(window)) {
      return window
    }
  }
  return null
}

// After Enter, herdr's TUI clears the input line once a message is actually
// submitted. If (a prefix of) our prompt text is still visible in the pane,
// Enter did NOT take effect and the text is still sitting there unsent —
// this is the one case where resending is safe, and even then only Enter
// may be resent (see deliverTaskPrompt). A real incident: a long prompt's
// Enter was swallowed mid-paste, the naive retry retyped the same text into
// the still-open input box, and both copies were submitted concatenated
// into one message.
async function isPromptStillInInputBox(
  herdr: HerdrClient,
  paneId: string,
  taskPrompt: string
): Promise<boolean> {
  const visible = await herdr.readPane(paneId)
  return matchesInputBoxPrefix(visible, taskPrompt)
}

// The typing itself — before Enter is ever pressed — is what a
// still-initializing TUI swallows: `herdr agent send` returns success
// having handed the keystrokes over, and agent_status stays 'idle' whether
// the pane took all of them or only the first few hundred. So the pane is
// read back and the TAIL of what was typed (see matchesInputBoxTail) has to
// be there before Enter is allowed to submit anything. If it isn't, the
// partial text is cleared and the whole prompt retyped from scratch; the
// clear is what keeps a retype from concatenating onto the fragment already
// sitting in the box.
//
// Giving up throws rather than pressing Enter anyway: submitting a knowingly
// truncated prompt dispatches the agent on a task nobody wrote, which is far
// worse than a failed dispatch the caller rolls back.
// A read failure says nothing about whether the text landed, so it counts as
// one unverified attempt (null) and falls into the retry rather than killing
// an otherwise healthy dispatch. Only genuinely running out of attempts
// throws — see typeAndVerifyTaskPrompt.
async function readPaneForVerification(
  herdr: HerdrClient,
  paneId: string,
  todoId: number,
  attempt: number
): Promise<string | null> {
  try {
    return await herdr.readPane(paneId)
  } catch (err) {
    logger.warn('Could not read the pane back to verify the prompt; treating it as unverified', {
      todoId,
      paneId,
      attempt,
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// Ctrl+u is a spelling herdr accepts, which is not the same as one that
// empties Claude Code's input buffer — and retyping on top of a fragment is
// how a prompt gets submitted twice, concatenated. So the clear is read back:
// whatever window of the prompt the pane was showing before it has to be gone
// after it, or the dispatch aborts instead of typing into that box again.
//
// A read that fails here does NOT count as a successful clear — that is the
// one direction where being permissive costs a double-send. Not being able to
// anchor at all is different: the pane was showing less than one window of
// the prompt, so there was never evidence of a leftover to begin with, and
// abandoning the dispatch over it would defeat the retry this exists to
// enable. (That is the same residual gap as a sub-window leftover; the
// realistic truncation leaves far more behind — the incident left ~350
// characters.)
async function assertInputBoxCleared(
  herdr: HerdrClient,
  paneId: string,
  visibleBeforeClear: string | null,
  taskPrompt: string,
  todoId: number,
  attempt: number,
  clearSettleMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const anchor =
    visibleBeforeClear === null ? null : findObservedPromptWindow(visibleBeforeClear, taskPrompt)
  if (anchor === null) {
    logger.warn('Nothing of the prompt was visible to anchor the clear check to; retyping anyway', {
      todoId,
      paneId,
      attempt,
    })
    return
  }

  // The TUI needs a moment to process the clear and repaint before the pane
  // is worth reading — the same reason typeTaskPrompt waits after typing.
  // Reading too early would still see the anchor and abort a healthy
  // dispatch, which is precisely the slowness this whole change exists to
  // tolerate.
  await sleep(clearSettleMs)

  const afterClear = await readPaneForVerification(herdr, paneId, todoId, attempt)
  if (afterClear === null) {
    logger.warn('Could not read the pane back after clearing it; refusing to retype', {
      todoId,
      paneId,
      attempt,
    })
    throw new ConflictError('プロンプトを入力欄に送れませんでした')
  }
  if (stripForTailComparison(afterClear).includes(anchor)) {
    logger.warn('The input box still holds the prompt after clearing it; refusing to retype', {
      todoId,
      paneId,
      attempt,
      clearKey: CLEAR_INPUT_KEY,
    })
    throw new ConflictError('プロンプトを入力欄に送れませんでした')
  }
}

async function typeAndVerifyTaskPrompt(
  herdr: HerdrClient,
  paneId: string,
  taskPrompt: string,
  todoId: number,
  keystrokeDelayMs: number,
  clearSettleMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PROMPT_TYPING_ATTEMPTS; attempt += 1) {
    await typeTaskPrompt(herdr, paneId, taskPrompt, keystrokeDelayMs, sleep)
    const isFinalAttempt = attempt === MAX_PROMPT_TYPING_ATTEMPTS
    const visible = await readPaneForVerification(herdr, paneId, todoId, attempt)
    if (visible !== null && matchesInputBoxTail(visible, taskPrompt)) {
      return
    }
    logger.warn(
      isFinalAttempt
        ? 'Prompt text did not fully reach the input box on the final attempt; clearing it and giving up'
        : 'Prompt text did not fully reach the input box; clearing it before retrying',
      {
        todoId,
        paneId,
        attempt,
        maxAttempts: MAX_PROMPT_TYPING_ATTEMPTS,
        promptLength: taskPrompt.length,
        expectedTail: expectedInputBoxTail(taskPrompt),
        ...describePaneRead(visible),
      }
    )
    // Cleared even on the final attempt: the dispatch is about to be rolled
    // back, and a fragment left in the input box of a pane the user may still
    // interact with is one stray Enter away from being submitted.
    await herdr.sendKeys(paneId, CLEAR_INPUT_KEY)
    if (!isFinalAttempt) {
      await assertInputBoxCleared(
        herdr,
        paneId,
        visible,
        taskPrompt,
        todoId,
        attempt,
        clearSettleMs,
        sleep
      )
    }
  }
  throw new ConflictError('プロンプトを入力欄に送れませんでした')
}

async function confirmOrWarn(
  herdr: HerdrClient,
  paneId: string,
  todoId: number,
  confirmTimeoutMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
  warnMessage: string
): Promise<boolean> {
  const status = await pollAgentStatus(herdr, paneId, confirmTimeoutMs, pollIntervalMs, sleep)
  const confirmed = isDeliveryConfirmed(status)
  if (!confirmed) {
    logger.warn(warnMessage, { todoId, paneId, status })
  }
  return confirmed
}

// Types the prompt, verifies it actually landed in the input box (see
// typeAndVerifyTaskPrompt — this throws if it never does), submits it, then
// waits for confirmation it was received (see isDeliveryConfirmed). If that
// never happens, checks the pane's actual
// input box (isPromptStillInInputBox) rather than guessing from
// agent_status alone:
//  - text still there -> Enter was dropped; resend ONLY Enter (never the
//    text again — retyping into a box that already has the text is exactly
//    how a prompt gets sent twice, concatenated into one message).
//  - text gone -> Enter worked and claude just hasn't flipped status yet;
//    wait once more without sending anything.
// Either way, if it's still not confirmed after that, gives up WITHOUT
// throwing: claude is running and the workspace is usable, so the caller
// records the dispatch as successful but flags promptDelivered: false.
async function deliverTaskPrompt(
  herdr: HerdrClient,
  paneId: string,
  taskPrompt: string,
  todoId: number,
  options: DispatchOptions
): Promise<boolean> {
  const keystrokeDelayMs = computeKeystrokeDelayMs(taskPrompt.length, options)
  const confirmTimeoutMs = options.deliveryConfirmTimeoutMs ?? DEFAULT_DELIVERY_CONFIRM_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const sleep = options.sleep ?? defaultSleep
  const confirm = (warnMessage: string) =>
    confirmOrWarn(herdr, paneId, todoId, confirmTimeoutMs, pollIntervalMs, sleep, warnMessage)

  logger.info('Sending task prompt to pane', { todoId, paneId, keystrokeDelayMs })
  await typeAndVerifyTaskPrompt(
    herdr,
    paneId,
    taskPrompt,
    todoId,
    keystrokeDelayMs,
    computeClearSettleMs(options),
    sleep
  )
  await herdr.sendKeys(paneId, 'Enter')
  if (await confirm('Prompt delivery unconfirmed after sending; checking the input box')) {
    return true
  }

  if (!(await isPromptStillInInputBox(herdr, paneId, taskPrompt))) {
    return confirm('Input box is clear but delivery still unconfirmed; leaving dispatch in place')
  }

  logger.warn('Enter did not submit the prompt; resending Enter only (never retyping text)', {
    todoId,
    paneId,
  })
  await herdr.sendKeys(paneId, 'Enter')
  return confirm('Delivery still unconfirmed after resending Enter; leaving dispatch in place')
}

async function startClaudeAndSendTask(
  herdr: HerdrClient,
  workspace: CreatedWorkspace,
  taskPrompt: string,
  todoId: number,
  model: string | null,
  options: DispatchOptions
): Promise<boolean> {
  const command = buildAgentCommand(options, model)
  logger.info('Starting agent in pane', {
    todoId,
    workspaceId: workspace.workspaceId,
    paneId: workspace.paneId,
    command,
  })
  await herdr.runInPane(workspace.paneId, command)

  logger.info('Waiting for the agent to become idle', { todoId, paneId: workspace.paneId })
  await waitForAgentIdle(
    herdr,
    workspace.paneId,
    options.agentReadyTimeoutMs ?? DEFAULT_AGENT_READY_TIMEOUT_MS,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    options.sleep ?? defaultSleep,
    model === CODEX_MODEL ? 'Codex' : 'Claude Code'
  )

  // idle is necessary but not sufficient: the TUI may still be initializing
  // and unable to accept input the instant herdr detects the agent.
  await (options.sleep ?? defaultSleep)(options.settleMs ?? DEFAULT_SETTLE_MS)

  return deliverTaskPrompt(herdr, workspace.paneId, taskPrompt, todoId, options)
}

// Best-effort: closes the herdr workspace we just created and clears the
// todo's dispatch info so a failed dispatch doesn't leave the DB pointing at
// an orphaned (or now-closed) workspace.
async function rollbackDispatch(
  db: Database,
  herdr: HerdrClient,
  todoId: number,
  workspaceId: string,
  cause: unknown
): Promise<void> {
  logger.warn('Rolling back dispatch after failure', {
    todoId,
    workspaceId,
    message: cause instanceof Error ? cause.message : String(cause),
  })
  try {
    await herdr.closeWorkspace(workspaceId)
  } catch (closeErr) {
    logger.error('Failed to roll back herdr workspace after a failed dispatch', {
      todoId,
      workspaceId,
      message: closeErr instanceof Error ? closeErr.message : String(closeErr),
    })
  }
  todoRepo.clearDispatch(db, todoId)
}

async function createLoggedWorkspace(
  herdr: HerdrClient,
  todo: Todo,
  cwd: string
): Promise<CreatedWorkspace> {
  const todoId = todo.id
  const label = herdrWorkspaceLabel(todo)
  logger.info('Creating herdr workspace for dispatch', { todoId, label, cwd })
  const workspace = await herdr.createWorkspace({ cwd, label })
  logger.info('Created herdr workspace', {
    todoId,
    workspaceId: workspace.workspaceId,
    tabId: workspace.tabId,
    paneId: workspace.paneId,
  })
  return workspace
}

// Resolved (and, if the caller passed an override, persisted) before any
// herdr call. Persisting happens even though a later step (prompt length,
// workspace creation, claude startup) might still fail: the user-supplied
// path is deliberately NOT rolled back on failure — it becomes the default
// for the next dispatch attempt regardless of how this one goes.
function resolveAndPersistWorkspacePath(db: Database, todo: Todo, todoId: number, override?: string): string {
  const workspacePath = resolveWorkspacePath(todo, override)
  if (override !== undefined) {
    todoRepo.update(db, todoId, { workspacePath: override })
  }
  return workspacePath
}

// Same override-and-persist shape as resolveAndPersistWorkspacePath, but
// unlike a workspace path, no model at all (null) is a valid, common case —
// it just means "launch claude with its own default model", so there is no
// resolveModel equivalent that throws on "neither present". The allowlist
// check runs on the EFFECTIVE value (override, or whatever was already
// stored on the todo) rather than only on a fresh override: a todo's stored
// model could otherwise predate a since-narrowed DOT_CONNECT_ALLOWED_MODELS
// and reach buildAgentCommand unvalidated.
function resolveAndPersistModel(
  db: Database,
  todo: Todo,
  todoId: number,
  override: string | undefined,
  allowedModels: readonly string[]
): string | null {
  const model = override ?? todo.model
  if (model !== null) {
    assertAllowedModel(model, allowedModels)
  }
  if (override !== undefined) {
    todoRepo.update(db, todoId, { model: override })
  }
  return model
}

// Model values only ever reach here after assertAllowedModel has checked
// them against the configured allowlist (see resolveAndPersistModel) — and
// every entry in that allowlist is itself shape-checked as a plain
// identifier by modelValidation.ts's ALLOWED_MODEL_ENTRY_PATTERN (F1: an
// allowlist entry sourced from DOT_CONNECT_ALLOWED_MODELS is operator config,
// not compiled-in, so it needs that check too — an exact-match allowlist
// hit alone doesn't rule out metacharacters if the list itself could contain
// them). That combination is what makes it safe to interpolate a model value
// directly into a command line that herdr types into a live terminal pane
// (runInPane; see HerdrClient's own doc comment on why that command text is
// NOT shell-argv-safe the way exec()'s array arguments are).
// CODEX_MODEL is the one exception to "model becomes --model": it swaps the
// binary itself, launching Codex with its own configured default model.
function buildAgentCommand(options: DispatchOptions, model: string | null): string {
  if (model === CODEX_MODEL) {
    return options.codexBin ?? CODEX_MODEL
  }
  return model === null ? options.claudeBin : `${options.claudeBin} --model ${model}`
}

export async function dispatchTodo(
  db: Database,
  herdr: HerdrClient,
  todoId: number,
  options: DispatchOptions
): Promise<DispatchResult> {
  const todo = ensureDispatchable(todoRepo.getById(db, todoId), todoId)
  const workspacePath = resolveAndPersistWorkspacePath(db, todo, todoId, options.workspacePath)
  const model = resolveAndPersistModel(
    db,
    todo,
    todoId,
    options.model,
    options.allowedModels ?? DEFAULT_ALLOWED_MODELS
  )

  // Built (and length-validated) before any herdr call: an oversized
  // placeholder expansion must fail loudly with no workspace ever created,
  // not after one's already been spun up.
  const taskPrompt = buildTaskPrompt(todo, options.promptBody)

  const workspace = await createLoggedWorkspace(herdr, todo, workspacePath)

  // Record the new session immediately: if a later step fails we can both
  // detect (session_state) and roll back (herdrWorkspaceId) the workspace we
  // just created, instead of silently orphaning it.
  todoRepo.markDispatched(db, todoId, {
    herdrWorkspaceId: workspace.workspaceId,
    herdrTabId: workspace.tabId,
    herdrPaneId: workspace.paneId,
  })

  // A thrown error here (workspace creation already succeeded, but claude
  // failed to start, or never reached idle) still rolls back: the
  // workspace/pane is unusable. Delivery merely being unconfirmed after a
  // retry is NOT thrown — see deliverTaskPrompt — because claude itself is
  // running fine and rolling back would just discard a usable session.
  let promptDelivered: boolean
  try {
    promptDelivered = await startClaudeAndSendTask(herdr, workspace, taskPrompt, todoId, model, options)
  } catch (err) {
    await rollbackDispatch(db, herdr, todoId, workspace.workspaceId, err)
    throw err
  }

  dispatchEventRepo.recordDispatch(db, todoId)
  if (options.promptBody !== undefined) {
    promptHistoryRepo.recordUse(db, options.promptBody)
  }
  // Recorded here, on the success path only, for the same reason the prompt
  // is: this is a path herdr actually ran in, not merely one that was typed
  // into a form. workspacePath is already resolved (override applied) and
  // guaranteed non-empty by resolveWorkspacePath above.
  workspacePathHistoryRepo.recordUse(db, workspacePath)

  const dispatched = todoRepo.getById(db, todoId)
  if (!dispatched) {
    throw new Error(`Failed to load todo ${todoId} after dispatch`)
  }
  return { ...dispatched, promptDelivered }
}
