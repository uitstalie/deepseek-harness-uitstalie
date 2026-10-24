/**
 * cli/commands — the registry: one handler per command (decision 187).
 *
 * `main.ts` keeps the spec table (flags and positional limits) and the dispatch; this file is
 * where a command name meets its body. `help` is deliberately absent — it is answered by the
 * preflight (it prints the usage), which is why the consistency guard exempts it.
 */

import { assigneeCommand } from './assignee.ts'
import { boardCommand } from './board.ts'
import { batchCommand } from './batch.ts'
import { closeCommand } from './close.ts'
import { commentCommand } from './comment.ts'
import { doctorCommand } from './doctor.ts'
import { generateCommand } from './generate.ts'
import { getCommand } from './get.ts'
import { hooksCommand } from './hooks.ts'
import { initCommand } from './init.ts'
import { kbCommand } from './kb.ts'
import { linkCommand } from './link.ts'
import { lintCommand } from './lint.ts'
import { listCommand } from './list.ts'
import { machinesCommand } from './machines.ts'
import { newCommand } from './new.ts'
import { projectCommand } from './project.ts'
import { switchCommand } from './switch.ts'
import { syncCommand } from './sync.ts'
import { tagCreateCommand } from './tag-create.ts'
import { tagsCommand } from './tags.ts'
import { updateCommand } from './update.ts'
import { verifyCommitMsgCommand } from './verify-commit-msg.ts'
import { type Handler } from '../runtime.ts'

export const HANDLERS: Readonly<Record<string, Handler>> = Object.freeze({
  assignee: assigneeCommand,
  board: boardCommand,
  batch: batchCommand,
  close: closeCommand,
  comment: commentCommand,
  doctor: doctorCommand,
  generate: generateCommand,
  get: getCommand,
  hooks: hooksCommand,
  init: initCommand,
  kb: kbCommand,
  link: linkCommand,
  lint: lintCommand,
  list: listCommand,
  machines: machinesCommand,
  new: newCommand,
  project: projectCommand,
  switch: switchCommand,
  sync: syncCommand,
  'tag-create': tagCreateCommand,
  tags: tagsCommand,
  update: updateCommand,
  'verify-commit-msg': verifyCommitMsgCommand,
})
