// @vitest-environment node
/**
 * Branch client style discipline for `packages/uitstalie/*`.
 *
 * The shipped `ui-theme` suites own hairline widths, the radius scale,
 * `corner-shape` pairing, and menu material for the product tree, and they read
 * this branch's files too. Two rules they do not own are covered here, because
 * the branch makes them absolute for its own client code: a colour may only
 * arrive through a `--dsw-*` token (never as a literal, and never as a literal
 * fallback inside a token), and no weight above the caption step is allowed.
 * The same pass pins the branch to the token radius scale and to the code font
 * family, so a new view cannot quietly reintroduce a measured pixel value.
 * @module @deepseek-ai/dsh-client-common-view/tests/branch-client-tokens
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Root of the branch's own packages, relative to the repository root. */
const BRANCH_ROOT = 'packages/uitstalie'

/** One scanned source file and its text. */
interface SourceFile {
  /** Repository-relative path, used in failure messages. */
  readonly path: string
  /** Full text of the file. */
  readonly text: string
}

/**
 * Every stylesheet and component under each branch package's client program.
 * @returns the scanned files, sorted by path.
 */
function clientSources(): SourceFile[] {
  const files: SourceFile[] = []
  for (const entry of readdirSync(BRANCH_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const clientRoot = join(BRANCH_ROOT, entry.name, 'src', 'client')
    let names: string[]
    try {
      names = readdirSync(clientRoot, { recursive: true, encoding: 'utf8' })
    } catch {
      continue // A package without a client program contributes nothing.
    }
    for (const name of names) {
      if (!/\.(css|tsx|ts)$/u.test(name)) continue
      const path = join(clientRoot, name)
      files.push({ path, text: readFileSync(path, 'utf8') })
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

/** Lines whose leading text is a comment, where literals are documentation. */
function codeLines(text: string): string[] {
  return text
    .split('\n')
    .filter(line => !/^\s*(\/\*|\*|\/\/)/u.test(line))
}

/**
 * Colour literals that bypass the token families.
 * @param text - file contents.
 * @returns each offending line.
 */
function colorLiterals(text: string): string[] {
  return codeLines(text).filter(line => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/u.test(line))
}

/**
 * Literals used as a fallback inside a token read.
 * @param text - file contents.
 * @returns each offending line.
 */
function tokenFallbackLiterals(text: string): string[] {
  return codeLines(text).filter(line => /var\(--dsw-[^,)]*,\s*[^)]*(?:#|rgba?\(|hsla?\()/u.test(line))
}

/**
 * Weights above the caption step the branch allows.
 * @param text - file contents.
 * @returns each offending line.
 */
function heavyWeights(text: string): string[] {
  return codeLines(text).filter(line => /font-weight:\s*(?:600|700|800|900|bold)\b|font:\s*[^;]*\b(?:600|700|800|900|bold)\b/u.test(line))
}

/**
 * Uses of the generic monospace family instead of the code font token.
 * @param text - file contents.
 * @returns each offending line.
 */
function monospaceLiterals(text: string): string[] {
  return codeLines(text).filter(line => /\bmonospace\b/u.test(line))
}

/**
 * Radius declarations outside the token scale, plus full-round values whose
 * rule does not pair `corner-shape: round` with them.
 * @param text - stylesheet contents.
 * @returns each offending statement.
 */
function radiusOffences(text: string): string[] {
  const offences: string[] = []
  for (const block of text.split('}')) {
    for (const [, value = ''] of block.matchAll(/border-radius:\s*([^;]+);/gu)) {
      const trimmed = value.trim()
      if (trimmed.startsWith('var(--dsw-radius-')) continue
      const fullRound = trimmed === '999px' || trimmed === '50%'
      if (fullRound && /corner-shape:\s*round/u.test(block)) continue
      offences.push(`${trimmed} (${fullRound ? 'full-round without corner-shape: round' : 'not a --dsw-radius-* token'})`)
    }
  }
  return offences
}

/** Every rule this spec enforces, keyed by the name a failure reports. */
const RULES = {
  'colour literals': colorLiterals,
  'literals inside a token fallback': tokenFallbackLiterals,
  'weights above 500': heavyWeights,
  'monospace literals': monospaceLiterals,
  'off-scale radii': radiusOffences,
} satisfies Record<string, (text: string) => string[]>

describe('branch client style discipline', () => {
  const sources = clientSources()

  it('scans the branch packages that have a client program', () => {
    expect(sources.length).toBeGreaterThan(20)
    expect(sources.some(file => file.path.includes('ui-models-dev'))).toBe(true)
  })

  for (const [name, rule] of Object.entries(RULES)) {
    it(`reports no ${name}`, () => {
      const failures = sources.flatMap(file => rule(file.text).map(hit => `${file.path}: ${hit.trim()}`))
      expect(failures).toEqual([])
    })
  }

  // Each rule must reject an invalid case, so a future edit cannot pass by
  // leaving the scanner unable to see the violation it claims to own.
  it('rejects one invalid case per rule', () => {
    expect(colorLiterals('.x { color: #d04437; }')).toHaveLength(1)
    expect(colorLiterals('.x { color: var(--dsw-alias-label-primary); }')).toHaveLength(0)
    expect(tokenFallbackLiterals('.x { color: var(--dsw-alias-label-primary, #fff); }')).toHaveLength(1)
    expect(heavyWeights('.x { font-weight: 600; }')).toHaveLength(1)
    expect(heavyWeights('.x { font-weight: 500; }')).toHaveLength(0)
    expect(monospaceLiterals('.x { font-family: monospace; }')).toHaveLength(1)
    expect(radiusOffences('.x { border-radius: 12px; }')).toHaveLength(1)
    expect(radiusOffences('.x { border-radius: 999px; }')).toHaveLength(1)
    expect(radiusOffences('.x { border-radius: 999px; corner-shape: round; }')).toHaveLength(0)
    expect(radiusOffences('.x { border-radius: var(--dsw-radius-md); }')).toHaveLength(0)
  })
})
