/**
 * Tests for cli/commands — the registry must agree with the spec table (decision 187).
 *
 * The failure mode this guards: a command in the table without a handler used to be a `switch`
 * `default` arm nobody noticed until runtime ("未处理的命令"); a handler file without a table
 * entry is dead code. Both are caught here, at test time, by comparing the two lists.
 */

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { describe, it } from 'node:test'

import { COMMAND_NAMES } from './main.ts'
import { HANDLERS } from './commands/index.ts'

/** The preflight answers `help` itself (it prints the usage), so it has no handler file. */
const HANDLED_IN_PREFLIGHT: readonly string[] = ['help']
const SHARED_FILES: readonly string[] = ['index.ts']

describe('cli/commands: the table and the registry agree (decision 187)', () => {
  it('every command in the table has a handler', () => {
    const missing = COMMAND_NAMES
      .filter(name => !HANDLED_IN_PREFLIGHT.includes(name))
      .filter(name => HANDLERS[name] === undefined)
    assert.deepEqual(missing, [], 'a table entry without a handler is a runtime "未处理的命令"')
  })

  it('every handler file is one command, named after it', () => {
    const files = readdirSync('src/commands')
      .filter(name => name.endsWith('.ts'))
      .filter(name => !name.endsWith('.test.ts') && !SHARED_FILES.includes(name))
      .map(name => name.replace(/\.ts$/u, ''))
    const unknown = files.filter(name => !COMMAND_NAMES.includes(name))
    assert.deepEqual(unknown, [], 'a handler file with no table entry is dead code')
    assert.deepEqual(files.sort(), Object.keys(HANDLERS).sort(), 'one file per handler, one handler per file')
  })
})
