#!/usr/bin/env node
/**
 * cli/index — the bin wrapper. The only place that touches `process`.
 * Everything it does is pass the real world into `runCli` (decision 102 ①) — including the
 * working directory, which the handlers read from the request instead of `process` (decision 187).
 */

import { runCli } from './main.ts'

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  io: {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
  },
})
