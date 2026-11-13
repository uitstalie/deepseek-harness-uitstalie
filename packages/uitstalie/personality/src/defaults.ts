/**
 * First-activation defaults for the two global configuration files.
 *
 * `OUTPUT_STYLE.yaml` starts with the design's neutral defaults;
 * `WRITING_RULES.yaml` starts empty. `PERSONALITY.md` is deliberately not
 * seeded: its entries are user data, and the A–E tables are analysis targets.
 * @module @deepseek-ai/dsh-personality/defaults
 */

import type { Context } from '@deepseek-ai/cordis'

/** File name of the output-style configuration. */
export const OUTPUT_STYLE_FILE_NAME = 'OUTPUT_STYLE.yaml'

/** Store-relative path of the output-style configuration. */
export const OUTPUT_STYLE_STORE_PATH = `personality/${OUTPUT_STYLE_FILE_NAME}`

/** File name of the writing rules. */
export const WRITING_RULES_FILE_NAME = 'WRITING_RULES.yaml'

/** Store-relative path of the writing rules. */
export const WRITING_RULES_STORE_PATH = `personality/${WRITING_RULES_FILE_NAME}`

/** Neutral output-style defaults seeded on first activation. */
export const DEFAULT_OUTPUT_STYLE = Object.freeze({
  version: 1,
  tone: 'direct',
  length: 'terse',
  leadWithConclusion: true,
  lists: 'comparisons',
  dispatchVoice: 'terse',
} as const)

/** Canonical text of the seeded output-style configuration. */
export const DEFAULT_OUTPUT_STYLE_TEXT = `version: 1
tone: direct
length: terse
leadWithConclusion: true
lists: comparisons
dispatchVoice: terse
`

/** Canonical text of an empty writing-rules file. */
export const EMPTY_WRITING_RULES_TEXT = `version: 1
rules: []
`

/** Files created by a first-activation seed, in creation order. */
export interface SeedResult {
  /** Absolute or store-relative paths created by this call. */
  readonly created: readonly string[]
}

/**
 * Create the two configuration files when they are absent.
 *
 * An existing file is never overwritten. `PERSONALITY.md` is not created here:
 * a missing profile reads as empty and the first `personality_apply` creates it.
 */
export async function seedGlobalPersonalityFiles(ctx: Context, signal?: AbortSignal): Promise<SeedResult> {
  const created: string[] = []
  for (const [path, text] of [
    [OUTPUT_STYLE_STORE_PATH, DEFAULT_OUTPUT_STYLE_TEXT],
    [WRITING_RULES_STORE_PATH, EMPTY_WRITING_RULES_TEXT],
  ] as const) {
    const current = await ctx.dshStore.readFile(undefined, path, {
      scope: 'global',
      ...signal === undefined ? {} : { signal },
    })
    if (current.text !== undefined) continue
    await ctx.dshStore.writeFile(undefined, path, text, {
      scope: 'global',
      ...signal === undefined ? {} : { signal },
    })
    created.push(path)
  }
  return { created }
}
