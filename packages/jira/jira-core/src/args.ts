/**
 * core/args — a tiny, strict flag parser.
 *
 * Strict on purpose: an unknown flag is an error that names itself, because a CLI that
 * silently ignores `--porject DH` is worse than one that refuses it. Values may be given as
 * `--flag value` or `--flag=value`; booleans take no value.
 */

import { type JiraError, invalidInput } from './errors.ts'
import { type Result, err, ok } from './result.ts'

export type FlagSpec = Readonly<{ type: 'string' | 'boolean' | 'number'; description: string }>

export type ParsedArgs = Readonly<{
  positionals: readonly string[]
  flags: Readonly<Record<string, string | boolean | number>>
}>

export const parseArgs = (
  argv: readonly string[],
  spec: Readonly<Record<string, FlagSpec>>,
  /** Positional arguments that are optional; extra positionals are an error. */
  maxPositionals = 1,
): Result<ParsedArgs, JiraError> => {
  const positionals: string[] = []
  const flags: Record<string, string | boolean | number> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''
    if (!token.startsWith('--')) {
      // A single-dash token is a flag the user expects to work (`-h`, `-v`): treating it as a positional
      // produced "最多接受 N 个位置参数" for `jira list -h`, which is a misleading answer to a flag.
      if (token.startsWith('-') && token !== '-') {
        return err(invalidInput(`未知的 flag ${token}`, { flag: token, known: Object.freeze(Object.keys(spec).sort()) }))
      }
      positionals.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const name = (equals === -1 ? token.slice(2) : token.slice(2, equals)).trim()
    const definition = spec[name]
    if (definition === undefined) {
      return err(invalidInput(`未知的 flag --${name}`, {
        flag: `--${name}`,
        known: Object.freeze(Object.keys(spec).sort()),
      }))
    }
    if (definition.type === 'boolean') {
      const inline = equals === -1 ? undefined : token.slice(equals + 1)
      if (inline !== undefined && inline !== 'true' && inline !== 'false') {
        return err(invalidInput(`--${name} 只接受 true 或 false`, { flag: `--${name}` }))
      }
      flags[name] = inline === undefined ? true : inline === 'true'
      continue
    }
    const inline = equals === -1 ? undefined : token.slice(equals + 1)
    // Decision 169: `--limit=` is an empty value, not "0" — `Number('')` is 0, so an empty flag used to
    // slip through as a plausible number (and `--expected-revision=` as revision 0, which then failed
    // CAS with a message about the wrong thing).
    if (inline !== undefined && inline.trim() === '') {
      return err(invalidInput(`--${name} 需要一个值`, { flag: `--${name}` }))
    }
    const value = inline ?? argv[index + 1]
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      return err(invalidInput(`--${name} 需要一个值`, { flag: `--${name}` }))
    }
    // Last-wins would hide a typo like `--set self --set none`; say it instead.
    if (flags[name] !== undefined) {
      return err(invalidInput(`--${name} 给了不止一次`, { flag: `--${name}` }))
    }
    if (inline === undefined) index += 1
    if (definition.type === 'number') {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return err(invalidInput(`--${name} 需要一个数字`, { flag: `--${name}` }))
      flags[name] = parsed
      continue
    }
    flags[name] = value
  }

  if (positionals.length > maxPositionals) {
    return err(invalidInput(`最多接受 ${maxPositionals} 个位置参数，实际给了 ${positionals.length} 个`, {
      positionals: Object.freeze([...positionals]),
    }))
  }
  return ok(Object.freeze({ positionals: Object.freeze(positionals), flags: Object.freeze(flags) }))
}

export const stringFlag = (flags: ParsedArgs['flags'], name: string): string | undefined => {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

export const booleanFlag = (flags: ParsedArgs['flags'], name: string): boolean => flags[name] === true

/** Split a comma-separated list flag, tolerating spaces and an empty value. */
export const listFlag = (flags: ParsedArgs['flags'], name: string): readonly string[] | undefined => {
  const value = stringFlag(flags, name)
  if (value === undefined) return undefined
  return Object.freeze(value.split(',').map(entry => entry.trim()).filter(entry => entry !== ''))
}

/**
 * Collect only the flags that were given, as one spreadable object (decision 187).
 *
 * The pattern this replaces — `...(stringFlag(flags, 'x') === undefined ? {} : { x: … })` — was
 * repeated two dozen times across the command handlers, and every repetition was a place a name
 * could drift. `to` renames the key (flags are kebab-case, core fields are camelCase).
 */
export const optFlags = <T extends Record<string, unknown>>(
  flags: ParsedArgs['flags'],
  spec: Readonly<Record<string, 'string' | 'list' | Readonly<{ kind: 'string' | 'list'; to: keyof T & string }>>>,
): Partial<T> => {
  const out: Record<string, unknown> = {}
  for (const [name, rule] of Object.entries(spec)) {
    const kind = typeof rule === 'string' ? rule : rule.kind
    const target = typeof rule === 'string' ? name : rule.to
    const value = kind === 'list' ? listFlag(flags, name) : stringFlag(flags, name)
    if (value !== undefined) out[target] = value
  }
  return out as Partial<T>
}

/**
 * Split a command line the way a person types it: whitespace separates tokens, and
 * `"…"` / `'…'` keep a multi-word value in one piece.
 *
 * A slash command receives the exact text the user typed (no shell), so this is where
 * `/jira new --summary "two words"` stops being four arguments.
 */
export const splitTokens = (input: string): Result<readonly string[], JiraError> => {
  const tokens: string[] = []
  let buffer = ''
  let quote: '"' | "'" | undefined
  for (const char of input.trim()) {
    if (quote === undefined && (char === '"' || char === "'")) {
      quote = char
      continue
    }
    if (quote !== undefined && char === quote) {
      quote = undefined
      continue
    }
    if (quote === undefined && /\s/u.test(char)) {
      if (buffer !== '') {
        tokens.push(buffer)
        buffer = ''
      }
      continue
    }
    buffer += char
  }
  if (buffer !== '') tokens.push(buffer)
  // An unclosed quote used to swallow the rest of the line silently; the person typing it sees a
  // command that looks fine and half the arguments missing (decision 169).
  if (quote !== undefined) return err(invalidInput(`引号未闭合（${quote}）`, { input }))
  return ok(Object.freeze(tokens))
}
