/**
 * Import-boundary checks for the jira package group, ported from the external
 * plugin's `scripts/check-boundaries.mjs` (decisions 64, 108, 180).
 *
 * The external script scanned one package's `src/`: `core` imported only `node:*`
 * and relative paths, the adapters formed a one-way layer, `console` was limited
 * to terminal-facing entry points, and only io/git/lock/hooks touched the
 * filesystem or spawned processes. This file applies the same rules to the
 * migrated group's sources and pins the matcher with its own fixture table.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/** One lexical token: an identifier, a string literal, or punctuation. */
interface Token {
  kind: 'ident' | 'punct' | 'string'
  value: string
  line: number
}

/** An import specifier found in a token stream. */
interface Specifier {
  specifier: string
  line: number
}

/**
 * Split TypeScript source into tokens, blanking comments and string contents.
 * @param text - source file contents.
 * @returns tokens with the one-based line on which each starts.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  let line = 1
  while (index < text.length) {
    const char = text[index] ?? ''
    const next = text[index + 1]
    if (char === '\n') {
      line += 1
      index += 1
      continue
    }
    if (/\s/u.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') line += 1
        index += 1
      }
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const started = line
      let value = ''
      index += 1
      while (index < text.length && text[index] !== char) {
        if (text[index] === '\\') {
          value += text[index + 1] ?? ''
          index += 2
          continue
        }
        if (text[index] === '\n') line += 1
        value += text[index]
        index += 1
      }
      index += 1
      tokens.push({ kind: 'string', value, line: started })
      continue
    }
    if (/[A-Za-z_$]/u.test(char)) {
      const started = line
      let value = ''
      while (index < text.length && /[A-Za-z0-9_$]/u.test(text[index] ?? '')) {
        value += text[index]
        index += 1
      }
      tokens.push({ kind: 'ident', value, line: started })
      continue
    }
    tokens.push({ kind: 'punct', value: char, line })
    index += 1
  }
  return tokens
}

/**
 * Collect every specifier imported by a file, however the statement is spelled.
 * @param tokens - token stream for one file.
 * @returns import specifiers with their starting line.
 */
function specifiersIn(tokens: readonly Token[]): Specifier[] {
  const found: Specifier[] = []
  const stringAfter = (at: number): Token | undefined => (tokens[at]?.kind === 'string' ? tokens[at] : undefined)
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'ident') continue
    if (token.value === 'from') {
      const specifier = stringAfter(index + 1)
      if (specifier !== undefined) found.push({ specifier: specifier.value, line: token.line })
      continue
    }
    if (token.value === 'import' || token.value === 'require') {
      const bare = stringAfter(index + 1)
      if (bare !== undefined) {
        found.push({ specifier: bare.value, line: token.line })
        continue
      }
      if (tokens[index + 1]?.value === '(') {
        const inside = stringAfter(index + 2)
        if (inside !== undefined && tokens[index + 3]?.value === ')') {
          found.push({ specifier: inside.value, line: token.line })
        }
      }
    }
  }
  return found
}

/**
 * Find direct writes to the console, including `console['log']`.
 * @param tokens - token stream for one file.
 * @returns one-based lines that write to console.
 */
function consoleWritesIn(tokens: readonly Token[]): number[] {
  const lines: number[] = []
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'ident' || token.value !== 'console') continue
    const next = tokens[index + 1]?.value
    if (next === '.' || next === '[') lines.push(token.line)
  }
  return lines
}

/**
 * Resolve a relative specifier against a repo-relative file path.
 * @param file - repo-relative path of the importing file.
 * @param specifier - relative import specifier.
 * @returns normalized repo-relative target path.
 */
function resolveRelative(file: string, specifier: string): string {
  const parts = file.split('/').slice(0, -1)
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Name the package a repo-relative path belongs to.
 * @param file - repo-relative path.
 * @returns the jira package directory name, or `undefined` outside the group.
 */
function packageOf(file: string): string | undefined {
  const match = /^packages\/jira\/([^/]+)\//u.exec(file)
  return match?.[1]
}

/**
 * Name the jira package a bare import specifier addresses.
 * @param specifier - import specifier such as `@deepseek-ai/dsh-jira-core/io.ts`.
 * @returns the jira package directory name, or `undefined` for another package.
 */
function packageOfSpecifier(specifier: string): string | undefined {
  const match = /^@deepseek-ai\/dsh-(jira-core|jira-cli|jira-agent|jira-service)(?:\/|$)/u.exec(specifier)
  return match?.[1]
}

/** Packages each adapter must not import (the external guard's one-way layer). */
const LAYER_RULES: Readonly<Record<string, ReadonlySet<string>>> = {
  'jira-agent': new Set(['jira-cli']),
  'jira-cli': new Set(['jira-agent']),
}

/**
 * Files allowed to touch the filesystem or spawn a process (decision 180).
 * `jira-core/src/testing/` holds test support and stays exempt as the external
 * `testing/` directory was.
 */
const IO_ALLOWED: ReadonlySet<string> = new Set([
  'packages/jira/jira-core/src/io.ts',
  'packages/jira/jira-core/src/git.ts',
  'packages/jira/jira-core/src/lock.ts',
  'packages/jira/jira-core/src/hooks.ts',
])

const TESTING_HELPER_PREFIX = 'packages/jira/jira-core/src/testing/'

/**
 * Decide whether a specifier addresses the filesystem or a subprocess module.
 * @param specifier - import specifier.
 * @returns whether the specifier needs IO-whitelist membership.
 */
function isIoSpecifier(specifier: string): boolean {
  const bare = specifier.replace(/^node:/u, '')
  return bare === 'fs' || bare.startsWith('fs/') || bare === 'child_process'
}

/**
 * Check one file against every boundary rule.
 * @param file - repo-relative path of the file.
 * @param text - file contents.
 * @returns one message per violation, with file and line.
 */
function checkFile(file: string, text: string): string[] {
  const tokens = tokenize(text)
  const problems: string[] = []
  const pkg = packageOf(file)
  for (const { specifier, line } of specifiersIn(tokens)) {
    const relativeImport = specifier.startsWith('./') || specifier.startsWith('../')
    if (pkg === 'jira-core' && !relativeImport && !specifier.startsWith('node:')) {
      problems.push(`${file}:${String(line)} imports "${specifier}" — jira-core imports only node:* and relative paths (decision 108)`)
    }
    if (relativeImport) {
      const landed = resolveRelative(file, specifier)
      if (pkg === 'jira-core' && !landed.startsWith('packages/jira/jira-core/')) {
        problems.push(`${file}:${String(line)} imports "${specifier}" — jira-core must not depend on another package (decision 64)`)
      } else {
        const target = packageOf(landed)
        if (pkg !== undefined && target !== undefined && LAYER_RULES[pkg]?.has(target) === true) {
          problems.push(`${file}:${String(line)} imports "${specifier}" — ${pkg} must not depend on ${target}`)
        }
      }
    } else {
      const target = packageOfSpecifier(specifier)
      if (pkg !== undefined && target !== undefined && LAYER_RULES[pkg]?.has(target) === true) {
        problems.push(`${file}:${String(line)} imports "${specifier}" — ${pkg} must not depend on ${target}`)
      }
    }
    if (pkg === 'jira-core' && isIoSpecifier(specifier)
      && !IO_ALLOWED.has(file)
      && !file.startsWith(TESTING_HELPER_PREFIX)) {
      problems.push(`${file}:${String(line)} imports "${specifier}" — file IO and subprocesses live behind io/git/lock/hooks (decision 180)`)
    }
  }
  for (const line of consoleWritesIn(tokens)) {
    problems.push(`${file}:${String(line)} writes to console directly — take an injected io instead`)
  }
  return problems
}

/**
 * The matcher shapes this check must keep catching. Each case is a repo-relative
 * file, its text, and whether a violation is expected; a rewrite that starts
 * missing one fails the self-check below.
 */
const SELF_TEST: readonly (readonly [string, string, boolean])[] = [
  ['packages/jira/jira-core/src/store.ts', "import { x } from '@deepseek-ai/dsh-tools'\n", true],
  ['packages/jira/jira-core/src/store.ts', "import {\n  x,\n  y,\n} from '@deepseek-ai/dsh-tools'\n", true],
  ['packages/jira/jira-core/src/store.ts', "export { x } from '../../jira-cli/src/main.ts'\n", true],
  ['packages/jira/jira-core/src/store.ts', "await import('@deepseek-ai/dsh-tools')\n", true],
  ['packages/jira/jira-core/src/store.ts', "const m = require('left-pad')\n", true],
  ['packages/jira/jira-core/src/store.ts', "console['log']('x')\n", true],
  ['packages/jira/jira-core/src/store.ts', "import { x } from './b.ts'\nimport 'node:path'\n", false],
  ['packages/jira/jira-core/src/store.ts', "// import { x } from '@deepseek-ai/dsh-tools'\n", false],
  ['packages/jira/jira-core/src/store.ts', 'throw new Error(`cannot import from "${from}"`)\n', false],
  ['packages/jira/jira-core/src/store.ts', "const url = 'https://example.invalid/x'\n", false],
  ['packages/jira/jira-core/src/store.ts', "/* import {\n  x,\n} from '@deepseek-ai/dsh-tools' */\n", false],
  ['packages/jira/jira-agent/src/index.ts', "import { x } from '../../jira-cli/src/main.ts'\n", true],
  ['packages/jira/jira-agent/src/index.ts', "import { x } from '@deepseek-ai/dsh-jira-cli'\n", true],
  ['packages/jira/jira-cli/src/main.ts', "import { x } from '../../jira-agent/src/index.ts'\n", true],
  ['packages/jira/jira-cli/src/main.ts', "import { x } from '../../jira-core/src/store.ts'\n", false],
  ['packages/jira/jira-agent/src/index.ts', "import { x } from '../../jira-core/src/store.ts'\n", false],
  ['packages/jira/jira-agent/src/index.ts', "import { x } from '../../jira-service/src/index.ts'\n", false],
  ['packages/jira/jira-core/src/project.ts', "import { access } from 'node:fs/promises'\n", true],
  ['packages/jira/jira-core/src/store.ts', "import { readFile } from 'node:fs'\n", true],
  ['packages/jira/jira-core/src/testing/removeTree.ts', "import { rm } from 'node:fs/promises'\n", false],
  ['packages/jira/jira-core/src/io.ts', "import { readFile } from 'node:fs/promises'\n", false],
  ['packages/jira/jira-core/src/lock.ts', "import { mkdir } from 'node:fs/promises'\n", false],
  ['packages/jira/jira-core/src/hooks.ts', "import { chmod } from 'node:fs/promises'\n", false],
  ['packages/jira/jira-cli/src/index.ts', "import { readFile } from 'node:fs/promises'\n", false],
]

const repoRoot = resolve(import.meta.dirname, '../../../..')
const groupRoot = resolve(import.meta.dirname, '../..')
const JIRA_PACKAGES = ['jira-core', 'jira-cli', 'jira-agent', 'jira-service', 'ui-jira'] as const

/**
 * List the group's source files.
 * @returns repo-relative paths of non-test TypeScript sources under each package's `src/`.
 */
function groupSources(): string[] {
  const walk = (directory: string): string[] => {
    const found: string[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) found.push(...walk(path))
      else if (entry.isFile() && /\.tsx?$/u.test(entry.name) && !entry.name.endsWith('.test.ts')) found.push(path)
    }
    return found
  }
  return JIRA_PACKAGES.flatMap(pkg => walk(resolve(groupRoot, pkg, 'src')))
    .map(path => relative(repoRoot, path).split(sep).join('/'))
    .sort()
}

describe('jira import boundaries', () => {
  it('classifies the external guard self-test table', () => {
    for (const [file, text, expectViolation] of SELF_TEST) {
      const problems = checkFile(file, text)
      expect(problems.length > 0, `${file}: ${JSON.stringify(text)} -> ${JSON.stringify(problems)}`).toBe(expectViolation)
    }
  })

  it('flags a violation injected into real source and accepts the file as-is', () => {
    const file = 'packages/jira/jira-core/src/io.ts'
    const text = readFileSync(resolve(repoRoot, file), 'utf8')
    expect(checkFile(file, text)).toEqual([])
    const injected = `${text}\nimport { tools } from '@deepseek-ai/dsh-tools'\n`
    expect(checkFile(file, injected).length).toBeGreaterThan(0)
  })

  it('keeps every package source within its declared boundaries', () => {
    const files = groupSources()
    expect(files).toContain('packages/jira/jira-core/src/io.ts')
    expect(files.length).toBeGreaterThan(100)
    for (const pkg of JIRA_PACKAGES) {
      expect(files.some(file => file.startsWith(`packages/jira/${pkg}/src/`)), pkg).toBe(true)
    }
    const violations = files.flatMap(file => checkFile(file, readFileSync(resolve(repoRoot, file), 'utf8')))
    expect(violations).toEqual([])
  })
})
