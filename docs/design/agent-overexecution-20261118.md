# Agent over-execution: answer the question that was asked, do not run unrequested investigations

English | [中文](agent-overexecution-20261118.zh.md)

Status: draft for review. Evidence sessions exported on 2026-11-18 from the running installation; see section 9 for paths and the export method.

## 1. The experience

**A yes/no question became an investigation.** The person asked one thing: “只读探针看一下，是不是遇到模型429了” (is the nightly analysis hitting model 429s?). The answer came back as a statistics table, sampled raw log lines, a live request to the production endpoint, and a root-cause discussion. To collect it, the agent read production `.env` files, walked every historical `server-*.log`, queried `analysis_tasks` and `llm_configs`, then tried SSH to the production host. The person asked for a status check, not a production audit.

**A password became a reason to look for another door.** The person sent `有毛病？ts Ts#2026` (the SSH user and password) after the agent could not authenticate. Even after that, the agent looked for plink, paramiko, askpass helpers, other users, known hosts, and local scripts before finally using the password it had been given. The person asked “给你密码为什么不用？” and then “本地就没有脚本？而且直接22连接不得了？”. From the person's side: they handed over the key, and the agent kept picking the lock.

## 2. Where it went off the rails (verbatim evidence)

### 2.1 The 429 question

- `session-b28b3af9-5114-4fd0-8168-e32c10069cad`, seq 9, 2026-11-18T13:22:37.571Z, user message: “用户原话：只读探针看一下，是不是遇到模型429了”. The same message immediately enumerates four things to answer: (1) failure statistics with counts by model and hour, (2) at least three raw log lines and a table, (3) a live request to the production endpoint with retry-after/quota headers, (4) a definitive conclusion with the limiting window and usage evidence.
- Same session, seq 16, 2026-11-18T13:22:39.776Z, the agent restates the scope as: “1. Find backend logs, analysis_tasks and llm_configs tables, and make a single minimal request to the production endpoint.” The four-item brief is already the plan.
- Same session, seq 41, 2026-11-18T13:23:04.982Z, the first broad action is `glob { pattern: "**/*.log" }`, which walks every historical log; seq 61 then reads `.env`; seq 78 reads `backend-py` and running Python processes.
- Same session, seq 129, 2026-11-18T13:24:22.970Z, reasoning: “There is an ssh key. Let me test SSH connectivity to ts@10.24.137.80. Read-only.” The question was about 429s; SSH to the production host is a second system.
- Same session, seq 236, 2026-11-18T13:26:30.634Z, the follow-up still repeats the four-item brief: statistics, three raw log lines, one live request, definitive conclusion.

The first divergence is therefore **before the first tool call**: the dispatch brief turned “is it 429?” into four acceptance items, and the agent faithfully executed all four.

### 2.2 The SSH password

- `session-b28b3af9-5114-4fd0-8168-e32c10069cad`, seq 190, 2026-11-18T13:25:45.088Z, user message: “有毛病？ts Ts#2026” (password redacted here as `<password>`).
- Same session, seq 208, 2026-11-18T13:25:53.254Z, the agent correctly reads it as “SSH username `ts` and password `<password>`”, but then reasons about plink, paramiko, askpass, and local scripts instead of using the password.
- Same session, seq 233, 2026-11-18T13:26:23.181Z, the agent writes: “抱歉，我刚刚在找不用密码通道，现在直接用。” That sentence is the defect in the agent's own words.
- Same session, seq 246, 2026-11-18T13:27:13.693Z, user message: “本地就没有脚本？而且直接22连接不得了？”
- Same session, seq 263, 2026-11-18T13:27:35.057Z, the agent finally runs SSH with `PubkeyAuthentication=no`, `PreferredAuthentications=password`, and the supplied password. The working path was available at seq 208; 55 seconds and several detours were spent before it was used.
- `session-96234a56-7efc-4832-a573-6328f43d3dbf`, seq 477, 2026-11-12T10:33:21.199Z, the same SSH 2222 path with `PubkeyAuthentication=no` and a password askpass helper. This session supplies the port-2222 context; the password detour itself is in the 429 session.

## 3. Attribution layers

### 3.1 Dispatch contract: the brief's acceptance items were too wide

The four acceptance items at seq 9 are not observations the agent invented; they are the dispatch contract. Item 1 asks for statistics, item 2 for raw logs and a table, item 3 for a live production request, item 4 for a root-cause conclusion. A “是不是” question was written as a four-part deliverable. **This is our defect, not only the executor's.** An agent that follows the brief literally is doing what it was told.

### 3.2 Prompt layer: no “answer only what was asked” constraint

The system message at seq 8 contains communication preferences, status-reporting discipline, and workspace boundaries, but no rule that says: answer the question, do not expand into unrequested systems, and stop when the question is answerable. The closest rules are about style and reporting, not scope.

### 3.3 Tool layer: investigation has no cost signal

The agent has `pwsh`, `glob`, `read`, `ssh`, SQLite access, and log access, and every one of them is a normal read-only call. At seq 41 a single glob covers every historical log; at seq 129 an SSH attempt is one more read-only call. Nothing reports “this will read 719 frames / 3 MB”, “this will reach another host”, or “this is outside the question”. Expansion is cheap and invisible.

### 3.4 Acceptance layer: “verifiable” was read as “must investigate everything”

The brief's phrase “证据来源：后端运行日志、analysis_tasks 与 llm_configs 表、生产模型 endpoint 的一次最小请求” turns three evidence classes into an obligation. The agent treats “verifiable” as “all three must be collected”, rather than “one sufficient piece of evidence answers the question”. The acceptance item becomes an expansion mandate.

### 3.5 Credential availability: a given credential is treated as a clue, not an answer

The new, separate layer for the SSH case: the agent does not model “the person already supplied a working entry point”. It models “here is a username and a password; maybe there is a better authentication method”. The unstated assumption is that the means to the goal may be replaced at will. **The person gave an answer; the agent treated it as a search keyword.**

## 4. Goals and non-goals

**Goal:** one question yields one answerable answer. The answer contains the conclusion and only the evidence needed to support it; the agent stops when the question is answerable. Scope is the question, not the surrounding system.

**Non-goals:** this is not “do less work”. If the question genuinely requires logs, a probe, or a root cause, those are in scope. The defect is unrequested investigation, not investigation itself. The rule must not turn a correct “check the logs” into a refusal, and must not force the person to issue one instruction per step.

## 5. Mechanism candidates and tradeoffs

### a) A “minimum answer” field in the dispatch brief

The dispatcher writes one sentence: “This task only answers: …”; anything outside that sentence stops. Acceptance lists only the checks needed for that sentence, not every evidence source.

Cost: a too-narrow sentence can suppress a necessary safety check. Side effect: the dispatcher must spend one thought on scope, and an incorrect scope becomes visible before execution rather than after.

### b) Answer order: conclusion first, evidence second, evidence must map back

The first line is the answer (“是/不是” or “能/不能”), then at most a few evidence items, each explicitly tied to the question. No evidence item may introduce a new system or a new question.

Cost: some readers want the full reasoning first; a hard cap can cut useful context. Side effect: the agent may pad the conclusion without doing the one necessary check, so pair this with a minimum-evidence rule.

### c) Escalation needs explicit confirmation

When the answer is available but the agent wants root cause, another host, another database, or a wider time range, it asks one question first: “要追根因/扩大范围吗？”. The default is to stop at the answer.

Cost: an extra round trip; the person explicitly said “不等人” in several tasks, so this must be a question only when the expansion is optional and material. Side effect: over-use turns the person into an approval queue.

### d) Cost hints at the tool layer

A probe or statistics action first reports what it will read or send: number of log files/bytes, number of requests, target host. The model sees “this is a 3 MB read / one outbound request / another machine” before expanding.

Cost: more text in every call; trivial reads become noisy. Side effect: a cost hint is not a scope decision; it informs but does not forbid.

### e) “Given means use” rule

A credential, token, key, port, address, or path supplied by the person or the environment is the entry point to use directly. The agent must not seek an alternative authentication method, modify the peer's authentication configuration, or change the port/address on its own. If the supplied entry fails once, report the failure and ask before switching.

**Exception:** an explicit user instruction to switch is obedience, not a violation. If the person says “SSH 走 22”, using port 22 is correct even if the earlier address used another port. The rule must be written with this exception so it does not punish correct compliance.

Cost: a stale password causes one failed attempt and a question; a malicious or wrong entry is not silently bypassed. Side effect: the agent must distinguish “supplied entry” from “entry it discovered”, which is exactly the missing judgment.

## 6. Acceptance / regression checklist

For the 429 case, given only “是不是遇到模型429了”:

- Must contain: a direct yes/no answer and one line of evidence sufficient for that answer.
- Must not contain, unless separately requested: a statistics table, a live production request, SSH to another host, `.env` contents, or a root-cause chain.
- If the agent cannot answer from one source, it may name the missing source and ask; it may not collect all four sources “to be safe”.

For the SSH case, given a working username/password:

- Must contain: the first authentication attempt using the supplied password, with `PubkeyAuthentication=no`/password auth when the server offers password.
- Must not contain: a search for passwordless/public-key login, another user, plink/paramiko/askpass as a workaround, a port change, or a peer authentication-config change, unless the person asked for that change.
- The first failed attempt may be reported once with the exact error; a second attempt requires a new instruction.

For the “given means use” rule:

- Any output that shows “寻找免密登录 / 试探替代认证 / 改对端配置” after a usable credential was supplied is a regression failure.
- An output that follows an explicit “use port 22 / use password” instruction is compliant.

## 7. Phased recommendations

1. **Contract and prompt (can ship immediately):** add the minimum-answer sentence to the dispatch template; add the “answer only what was asked; expand only with a question” rule; add the “given means use” rule with its explicit-instruction exception.
2. **Review checklist (can ship with the prompt):** a reviewer checks every new brief for an answer sentence, a stop condition, and at least one acceptance item that proves the answer rather than an evidence inventory.
3. **Tool descriptions and cost hints (code/tool work):** describe probe/statistics/log tools with their volume and target; make the cost visible without making it a hard block.
4. **Tests and metrics (later):** replay the two sessions as regression fixtures; count tool calls and external systems touched per question; treat “answer available before extra calls” as the metric, not raw call count.

## 8. What this document does not change

This is a design plan only. It does not change the workspace tools, the dispatch code, prompts, agent presets, or the running installation. It does not touch KB, JIRA, or the exported sessions' originals.

## 9. Evidence exports

The two session logs were exported as read-only copies from the running installation. The source files were not modified.

- Source: `C:\Users\TS\.dsh\sessions\--D-dqc-JiraBugAnalyzer--\session-b28b3af9-5114-4fd0-8168-e32c10069cad\session.v4.jsonl.zstd`
- Export: `docs/design/evidence/session-b28b3af9-5114-4fd0-8168-e32c10069cad.jsonl` — 751 frames, 1,259 lines, 3,200,611 bytes.
- Source: `C:\Users\TS\.dsh\sessions\--D-dqc-system_img--\session-96234a56-7efc-4832-a573-6328f43d3dbf\session.v4.jsonl.zstd`
- Export: `docs/design/evidence/session-96234a56-7efc-4832-a573-6328f43d3dbf.jsonl` — 10,133 frames, 18,026 lines, 43,031,709 bytes.

Method: a Node script read each `.zstd` file, called the repository's `scanZstdFrames` to locate every concatenated frame, decompressed each frame with `node:zlib`'s `zstdDecompressSync`, concatenated the plaintext frames, and wrote UTF-8 JSONL. A single-frame decompressor returns only the first frame (about 217 bytes), which is why the frame scan is required. The exports are local evidence only and are not committed because the transcripts contain credentials and internal host data.
