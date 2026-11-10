import { DispatchReportStore, type DispatchReportRecord } from './index.ts'

/** The observable result of one startup recovery pass. */
export interface ReportRecoverySummary {
  readonly attempted: number
  readonly delivered: number
  readonly failed: number
  readonly skipped: readonly { readonly id: string; readonly reason: string }[]
}

/** Inputs needed to recover a saved report without consulting the task result. */
export interface ReportRecoveryOptions {
  /** Current recovery instant, also used for lease expiry. */
  readonly at: string
  /** Check that the recipient is still the intended, available Session. */
  readonly canDeliver: (report: DispatchReportRecord) => boolean | Promise<boolean>
  /** Deliver the exact saved report; false means it remains visible as failed. */
  readonly deliver: (report: DispatchReportRecord) => boolean | Promise<boolean>
  /** Observable failure/error channel. */
  readonly log: (level: 'info' | 'warn', message: string) => void
  /** Stop the current recovery pass before admitting another delivery. */
  readonly signal?: AbortSignal
  /** Mark the stored claim as superseded by this recovery pass before claiming. */
  readonly supersede?: (record: DispatchReportRecord, at: string) => Promise<DispatchReportRecord | undefined>
}

/**
 * Re-deliver recoverable reports once after startup. Delivered and failed records are never
 * automatically reopened. A pending record without a saved report cannot be delivered yet.
 * @param store - durable journal to read and settle.
 * @param options - recipient checks, delivery, logging, timing, and cancellation.
 * @returns delivery counts and the reasons reports were skipped.
 */
export async function recoverDispatchReports(store: DispatchReportStore, options: ReportRecoveryOptions): Promise<ReportRecoverySummary> {
  let attempted = 0
  let delivered = 0
  let failed = 0
  const skipped: { id: string; reason: string }[] = []
  for (const record of await store.list()) {
    if (options.signal?.aborted) break
    if (record.status === 'delivered' || record.status === 'failed' || record.status === 'acknowledged') {
      skipped.push({ id: record.id, reason: record.status })
      continue
    }
    if (record.reportText === undefined) {
      skipped.push({ id: record.id, reason: 'the report has not been saved yet' })
      continue
    }
    if (options.signal?.aborted) break
    if (!(await options.canDeliver(record))) {
      const message = 'the original recipient is not available or no longer accepts this report'
      options.log('warn', `superagent: report ${record.id} cannot be recovered: ${message}`)
      await store.settle(record.id, 'failed', options.at, message)
      failed += 1
      continue
    }
    if (options.signal?.aborted) break
    if (record.status === 'delivering' && options.supersede !== undefined) await options.supersede(record, options.at)
    const claimed = await store.claim(record.id, options.at)
    if (claimed === undefined) {
      const reason = 'a delivery claim is still active; retry after its lease expires'
      options.log('warn', `superagent: report ${record.id} recovery deferred: ${reason}`)
      skipped.push({ id: record.id, reason })
      continue
    }
    attempted += 1
    options.log('info', `superagent: recovering report ${record.id} (attempt ${String(claimed.record.attempts)})`)
    let accepted = false
    try { accepted = await options.deliver(claimed.record) } catch (error) {
      options.log('warn', `superagent: recovering report ${record.id} failed: ${String(error)}`)
    }
    if (accepted) {
      await store.settle(record.id, 'delivered', options.at)
      delivered += 1
    } else {
      await store.settle(record.id, 'failed', options.at, 'the recovery delivery was not accepted')
      failed += 1
    }
  }
  return { attempted, delivered, failed, skipped }
}
