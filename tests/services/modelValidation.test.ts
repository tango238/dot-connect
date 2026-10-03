import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  assertAllowedModel,
  DEFAULT_ALLOWED_MODELS,
  parseAllowedModels,
} from '../../src/services/modelValidation'
import { BadRequestError } from '../../src/services/errors'
import { logger } from '../../src/logger'

describe('DEFAULT_ALLOWED_MODELS', () => {
  test('is the Claude Code CLI aliases plus codex (which launches the Codex CLI instead)', () => {
    expect(DEFAULT_ALLOWED_MODELS).toEqual(['opus', 'sonnet', 'haiku', 'fable', 'codex'])
  })
})

describe('parseAllowedModels', () => {
  test('returns the default list when unset', () => {
    expect(parseAllowedModels(undefined)).toEqual(DEFAULT_ALLOWED_MODELS)
  })

  test('returns the default list for an empty/whitespace-only value', () => {
    expect(parseAllowedModels('   ')).toEqual(DEFAULT_ALLOWED_MODELS)
  })

  test('splits a comma-separated override', () => {
    expect(parseAllowedModels('opus,custom-model')).toEqual(['opus', 'custom-model'])
  })

  test('trims whitespace around each entry', () => {
    expect(parseAllowedModels(' opus , sonnet ')).toEqual(['opus', 'sonnet'])
  })

  test('drops blank entries from stray/trailing commas', () => {
    expect(parseAllowedModels('opus,,sonnet,')).toEqual(['opus', 'sonnet'])
  })

  test('falls back to the default list if every entry is blank', () => {
    expect(parseAllowedModels(',,,')).toEqual(DEFAULT_ALLOWED_MODELS)
  })

  // F1: an allowlist entry sourced from DOT_CONNECT_ALLOWED_MODELS is
  // operator config, not compiled-in code, and it ends up interpolated
  // verbatim into a command string typed into a live herdr pane
  // (buildClaudeCommand in dispatchService.ts). A value containing shell
  // metacharacters would otherwise pass straight through split/trim/dedupe
  // and become "allowed" by construction, since assertAllowedModel only
  // checks exact membership in whatever list it's given.
  describe('F1: rejects allowlist entries that are not plain identifiers', () => {
    afterEach(() => {
      ;(logger.warn as unknown as { mockRestore?: () => void }).mockRestore?.()
    })

    test('drops an entry containing a shell metacharacter (;) and logs a warning', () => {
      const warnSpy = spyOn(logger, 'warn')
      expect(parseAllowedModels('opus,opus;touch /tmp/pwned')).toEqual(['opus'])
      expect(warnSpy).toHaveBeenCalled()
    })

    test('drops an entry containing a backtick command substitution', () => {
      expect(parseAllowedModels('opus,opus`id`')).toEqual(['opus'])
    })

    test('drops an entry containing a $() command substitution', () => {
      expect(parseAllowedModels('opus,opus$(id)')).toEqual(['opus'])
    })

    test('drops an entry containing internal whitespace', () => {
      expect(parseAllowedModels('opus,opus and more')).toEqual(['opus'])
    })

    test('drops an entry containing a tab or newline', () => {
      expect(parseAllowedModels('opus,opus\tx')).toEqual(['opus'])
      expect(parseAllowedModels('opus,opus\nx')).toEqual(['opus'])
    })

    test('drops an entry starting with "-" (a flag-injection shape, e.g. --dangerously-skip-permissions)', () => {
      expect(parseAllowedModels('opus,--dangerously-skip-permissions')).toEqual(['opus'])
    })

    test('drops an entry starting with "--" used as an argv separator (-- --model opus)', () => {
      expect(parseAllowedModels('opus,-- --model opus')).toEqual(['opus'])
    })

    test('drops an oversized entry (over 100 chars)', () => {
      expect(parseAllowedModels(`opus,${'a'.repeat(101)}`)).toEqual(['opus'])
    })

    test('keeps a valid entry at exactly 100 chars', () => {
      const longButValid = 'a'.repeat(100)
      expect(parseAllowedModels(`opus,${longButValid}`)).toEqual(['opus', longButValid])
    })

    test('keeps entries using the allowed extra characters (. _ : -) after the first character', () => {
      expect(parseAllowedModels('my.custom_model:v1-beta')).toEqual(['my.custom_model:v1-beta'])
    })

    test('falls back to the default list when every entry is rejected', () => {
      expect(parseAllowedModels('opus;id,`whoami`')).toEqual(DEFAULT_ALLOWED_MODELS)
    })

    test('logs a warning naming the rejected value', () => {
      const warnSpy = spyOn(logger, 'warn')
      parseAllowedModels('opus;id')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring invalid DOT_CONNECT_ALLOWED_MODELS entry'),
        { value: 'opus;id' }
      )
    })
  })
})

describe('assertAllowedModel', () => {
  test('does not throw for a model in the list', () => {
    expect(() => assertAllowedModel('opus', DEFAULT_ALLOWED_MODELS)).not.toThrow()
  })

  test('throws BadRequestError for a model not in the list', () => {
    expect(() => assertAllowedModel('gpt-4', DEFAULT_ALLOWED_MODELS)).toThrow(BadRequestError)
  })

  test('the error message names the rejected model', () => {
    expect(() => assertAllowedModel('gpt-4', DEFAULT_ALLOWED_MODELS)).toThrow(/gpt-4/)
  })
})
