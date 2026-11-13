/** Direct apply validation tests for the bounds the tool layer also enforces. */
import { expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { applyPersonalityCandidates, ApplyError } from '../src/apply.ts'

const signal = new AbortController().signal

test('rejects an empty candidate list before any I/O', async () => {
  await expect(applyPersonalityCandidates({} as Context, { candidates: [], confirm: true }, signal))
    .rejects.toBeInstanceOf(ApplyError)
})

test('rejects a non-literal confirm before any I/O', async () => {
  await expect(applyPersonalityCandidates({} as Context, {
    candidates: [{
      kind: 'style',
      name: 'language',
      text: '用中文回答。',
      evidence: [{ sessionId: 's', seq: 1, quote: 'q' }],
    }],
    confirm: false as never,
  }, signal)).rejects.toBeInstanceOf(ApplyError)
})
