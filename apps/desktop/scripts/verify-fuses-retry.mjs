/** Prove the fuse flip survives a transient exclusive lock on the target executable. */
import { flipFusesWithRetry } from './fuses-retry.mjs'

const executablePath = process.argv[2]
if (executablePath === undefined) {
  console.error('usage: node apps/desktop/scripts/verify-fuses-retry.mjs <executable> [attempts] [delayMs]')
  process.exit(2)
}
const attempts = process.argv[3] === undefined ? undefined : Number.parseInt(process.argv[3], 10)
const delayMs = process.argv[4] === undefined ? undefined : Number.parseInt(process.argv[4], 10)
const started = Date.now()
const failures = []
try {
  const result = await flipFusesWithRetry(executablePath, {
    ...attempts === undefined ? {} : { attempts },
    ...delayMs === undefined ? {} : { delayMs },
    onRetry: (attempt, error) => {
      failures.push({ attempt, atMs: Date.now() - started, message: error.message.slice(0, 160) })
    },
  })
  console.log(JSON.stringify({
    ok: true, executablePath, attemptsTaken: failures.length + 1, failures, fuseState: result, elapsedMs: Date.now() - started,
  }, undefined, 2))
} catch (error) {
  console.log(JSON.stringify({ ok: false, executablePath, failures, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started }, undefined, 2))
  process.exitCode = 1
}
