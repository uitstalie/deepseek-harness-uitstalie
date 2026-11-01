/** cli/commands/doctor — `jira doctor [--json]`: the health check (structure + consistency + perf). */

import { type Timestamp } from '@deepseek-ai/dsh-jira-core'
import { checkConsistency, renderConsistency } from '@deepseek-ai/dsh-jira-core'
import { checkStore, renderDoctorReport } from '@deepseek-ai/dsh-jira-core'
import { listIssues, readSnapshot } from '@deepseek-ai/dsh-jira-core'
import { listKnowledge } from '@deepseek-ai/dsh-jira-core'
import { listMachines } from '@deepseek-ai/dsh-jira-core'
import { PERF_SAMPLES, countPerfFiles, measureKbSearch, perfQuery, perfReport, renderPerf } from '@deepseek-ai/dsh-jira-core'
import { machineOf, nowUtc, type Handler } from '../runtime.ts'

export const doctorCommand: Handler = async (ctx) => {
  const reportValue = checkStore(await readSnapshot(ctx.root), nowUtc() as Timestamp)
  // Decision 85: the two numbers that decide whether an index is worth building, reported here
  // so the question always has data behind it. Both are read-only measurements (decision 38).
  const files = await countPerfFiles(ctx.store)
  const knowledge = await listKnowledge(ctx.store)
  const probe = perfQuery(knowledge.ok ? knowledge.value.entries.map(entry => entry.title) : [])
  const worst = await measureKbSearch(ctx.store, probe)
  const perf = perfReport(files, worst.ok ? worst.value : -1, probe, PERF_SAMPLES)
  const self = await machineOf(ctx.env, ctx.root)
  const records = await listMachines(ctx.store)
  const unlabelled = records.ok && !records.value.some(record => record.machineId === self)
  // C9: the checks that need two entities at once — mutual references and unknown machines.
  const allIssues = await listIssues(ctx.root)
  const consistency = knowledge.ok
    ? checkConsistency({
      issues: allIssues.issues,
      knowledge: knowledge.value.entries,
      registeredMachines: records.ok ? records.value.map(record => record.machineId) : [],
    })
    : []
  if (ctx.json) {
    ctx.say({ ...reportValue, consistency })
    return reportValue.ok ? 0 : 1
  }
  ctx.say([
    renderDoctorReport(reportValue).replace(/\n$/u, ''),
    renderPerf(perf),
    ...(unlabelled ? ['! machines-unlabelled：本机还没有 label（运行：jira machines label --name <label>）'] : []),
    // Decision 179: a manual `git push` skips the settle step, so stale derived files are
    // pushed as-is and the store's CI turns red. Say it here, where a human looks before pushing.
    ...(reportValue.summary.generatedStale > 0
      ? ['! 派生文件已过期：推送前先 `jira sync`（它会 pull → 重生成+提交 → push；手工 `git push` 不会重生成，账本 CI 会红）']
      : []),
    renderConsistency(consistency).replace(/\n$/u, ''),
  ].filter(line => line !== '').join('\n'))
  return reportValue.ok ? 0 : 1
}
