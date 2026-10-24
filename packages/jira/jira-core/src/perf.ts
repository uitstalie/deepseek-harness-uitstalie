/**
 * core/perf — the two numbers decision 85 wants a human to see.
 *
 * "When should we stop scanning and build an index?" is answered by data, not by taste, so the
 * design fixes two observable triggers — **KB search p95 above 200 ms** or **more than 5000 store
 * files** — and requires `jira doctor` to report both. Until an index exists, these numbers are the
 * only honest answer to "is the scan still fine?".
 *
 * The measurement is deliberately crude and stated as such: a handful of runs of one query over the
 * library, reporting the **slowest** of them as the p95 (with so few samples the p95 *is* the
 * maximum). It is a thermometer, not a benchmark — and it is read-only (decision 38).
 */

import { join } from 'node:path'

import { searchKnowledgeIn } from './kbstore.ts'
import { type JiraError } from './errors.ts'
import { listDirEntries } from './io.ts'
import { type Result, ok } from './result.ts'
import { type Store } from './store.ts'

/** Decision 85's thresholds, kept here so the report and the design cannot drift. */
export const SEARCH_P95_BUDGET_MS = 200
export const STORE_FILE_BUDGET = 5_000
export const PERF_SAMPLES = 5

export type PerfFileCounts = Readonly<{
  /** Files the knowledge scan reads (the library itself). */
  knowledge: number
  /** Everything under the store except `.git` and the derived-data directories. */
  store: number
}>

export type PerfReport = Readonly<{
  files: PerfFileCounts
  /** Slowest of {@link PERF_SAMPLES} searches, in milliseconds. */
  searchWorstMs: number
  samples: number
  /** The query used, so the number can be reproduced. */
  query: string
  overBudget: Readonly<{ search: boolean; files: boolean }>
  verdict: 'scan is fine' | 'evaluate an index'
}>

const PRUNED = new Set(['.git', '.jira', 'var', 'node_modules'])

const countFiles = async (root: string, filter: (path: string) => boolean): Promise<number> => {
  const walk = async (dir: string, prefix: string): Promise<number> => {
    const listed = await listDirEntries(dir)
    if (!listed.ok) return 0
    let total = 0
    for (const entry of listed.value) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory) {
        if (!PRUNED.has(entry.name)) total += await walk(join(dir, entry.name), path)
        continue
      }
      if (entry.isFile && filter(path)) total += 1
    }
    return total
  }
  return walk(root, '')
}

export const countPerfFiles = async (store: Store): Promise<PerfFileCounts> =>
  Object.freeze({
    knowledge: await countFiles(join(store.files.root, 'knowledge'), () => true),
    store: await countFiles(store.files.root, () => true),
  })

/**
 * Time the scan. A store with no entries is not a slow store, so it reports 0 ms rather than a
 * meaningless measurement of an empty loop.
 */
export const measureKbSearch = async (
  store: Store,
  query: string,
  samples: number = PERF_SAMPLES,
): Promise<Result<number, JiraError>> => {
  let worst = 0
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now()
    const result = await searchKnowledgeIn(store, query, 50)
    const elapsed = performance.now() - started
    if (!result.ok) return result
    if (result.value.matched === 0 && result.value.hits.length === 0 && index === 0) {
      // Nothing to search: skip the remaining samples rather than reporting noise as a measurement.
      break
    }
    worst = Math.max(worst, elapsed)
  }
  return ok(Math.round(worst))
}

/** The probe query: the title of the busiest entry when there is one, else a term nothing matches. */
export const perfQuery = (words: readonly string[]): string => words.find(word => word.trim() !== '') ?? 'the'

export const perfReport = (files: PerfFileCounts, searchWorstMs: number, query: string, samples: number): PerfReport => {
  const overBudget = Object.freeze({
    search: searchWorstMs > SEARCH_P95_BUDGET_MS,
    files: files.store > STORE_FILE_BUDGET,
  })
  return Object.freeze({
    files,
    searchWorstMs,
    samples,
    query,
    overBudget,
    verdict: overBudget.search || overBudget.files ? 'evaluate an index' : 'scan is fine',
  })
}

export const renderPerf = (report: PerfReport): string =>
  `搜索 p95 ~ ${String(report.searchWorstMs)} ms（对 "${report.query}" 取 ${String(report.samples)} 次里最慢的一次，预算 ${String(SEARCH_P95_BUDGET_MS)} ms）`
  + `；文件 ${String(report.files.store)} 个（其中知识 ${String(report.files.knowledge)} 个，预算 ${String(STORE_FILE_BUDGET)}）`
  + ` → ${report.verdict}`
