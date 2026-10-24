/**
 * Tests for cli/args — the strict flag parser.
 *
 * Strictness is the feature: a CLI that silently ignores `--porject DH` turns a typo into a
 * wrong store, so an unknown flag must name itself and list what is accepted.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { booleanFlag, listFlag, parseArgs, splitTokens, stringFlag, type FlagSpec } from './args.ts'

const spec: Readonly<Record<string, FlagSpec>> = Object.freeze({
  root: { type: 'string', description: 'root' },
  json: { type: 'boolean', description: 'json' },
  count: { type: 'number', description: 'count' },
})

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

describe('args: values', () => {
  it('accepts both --flag value and --flag=value', () => {
    assert.equal(stringFlag(unwrap(parseArgs(['--root', '/a'], spec)).flags, 'root'), '/a')
    assert.equal(stringFlag(unwrap(parseArgs(['--root=/a'], spec)).flags, 'root'), '/a')
  })

  it('treats a boolean as flag, --flag=true, or --flag=false', () => {
    assert.equal(booleanFlag(unwrap(parseArgs(['--json'], spec)).flags, 'json'), true)
    assert.equal(booleanFlag(unwrap(parseArgs(['--json=false'], spec)).flags, 'json'), false)
    assert.equal(booleanFlag(unwrap(parseArgs([], spec)).flags, 'json'), false)
  })

  it('parses numbers, and refuses a non-number', () => {
    assert.equal(unwrap(parseArgs(['--count', '3'], spec)).flags.count, 3)
    const bad = parseArgs(['--count', 'many'], spec)
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.error.message, /需要一个数字/)
  })

  it('splits a comma list, dropping blanks', () => {
    const args = unwrap(parseArgs(['--root', 'a,b , ,c'], spec))
    assert.deepEqual(listFlag(args.flags, 'root'), ['a', 'b', 'c'])
  })
})

describe('args: splitting what a person typed', () => {
  it('keeps a quoted value in one piece', () => {
    assert.deepEqual(unwrap(splitTokens('new --project DH --summary "first from the command"')),
      ['new', '--project', 'DH', '--summary', 'first from the command'])
    assert.deepEqual(unwrap(splitTokens("--note 'single quoted'")), ['--note', 'single quoted'])
  })

  it('collapses stray whitespace and handles an empty line', () => {
    assert.deepEqual(unwrap(splitTokens('   list    --all  ')), ['list', '--all'])
    assert.deepEqual(unwrap(splitTokens('')), [])
  })

  it('refuses an unclosed quote instead of swallowing the rest of the line (decision 169)', () => {
    const broken = splitTokens('new --summary "never closed')
    assert.equal(broken.ok, false)
    if (!broken.ok) assert.match(broken.error.message, /引号未闭合/u)
  })
})
describe('args: mistakes are named', () => {
  it('names an unknown flag and lists the known ones', () => {
    const result = parseArgs(['--porject', 'DH'], spec)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error.message, /未知的 flag --porject/)
      assert.deepEqual(result.error.context?.known, ['count', 'json', 'root'])
    }
  })

  it('refuses a value-taking flag with no value', () => {
    for (const argv of [['--root'], ['--root', '--json']]) {
      const result = parseArgs(argv, spec)
      assert.equal(result.ok, false, `expected a refusal for ${argv.join(' ')}`)
      if (!result.ok) assert.match(result.error.message, /--root 需要一个值/)
    }
  })

  it('counts positionals', () => {
    const args = unwrap(parseArgs(['DH-12'], spec, 1))
    assert.deepEqual(args.positionals, ['DH-12'])
    const tooMany = parseArgs(['DH-12', 'extra'], spec, 1)
    assert.equal(tooMany.ok, false)
    if (!tooMany.ok) assert.match(tooMany.error.message, /最多接受 1 个位置参数/)
  })

  it('keeps positionals in order around flags', () => {
    const args = unwrap(parseArgs(['DH-12', '--json'], spec, 1))
    assert.deepEqual(args.positionals, ['DH-12'])
    assert.equal(booleanFlag(args.flags, 'json'), true)
  })
})

describe('args: the boundaries that used to pass silently (decision 169)', () => {
  it('refuses an empty inline value instead of reading it as zero', () => {
    const empty = parseArgs(['--count='], spec)
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.match(empty.error.message, /--count 需要一个值/u)
  })

  it('refuses a flag given twice instead of taking the last one', () => {
    const twice = parseArgs(['--root', 'a', '--root', 'b'], spec)
    assert.equal(twice.ok, false)
    if (!twice.ok) assert.match(twice.error.message, /--root 给了不止一次/u)
  })

  it('names a single-dash token as an unknown flag, not as a positional', () => {
    const short = parseArgs(['-h'], spec)
    assert.equal(short.ok, false)
    if (!short.ok) assert.match(short.error.message, /未知的 flag -h/u)
  })
})
