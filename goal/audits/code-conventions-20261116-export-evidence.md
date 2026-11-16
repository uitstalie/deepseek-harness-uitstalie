# 入口导出、JSDoc 与 unknown-cast 明细

## 1. Loader 入口导出（418 项）

依据：`docs/defensive-patterns/package-surface.md#a-plugin-package-exports-what-the-loader-loads`；`packages/AGENTS.md:5`。命令：`pnpm run verify-plugin-entry-exports`，退出 1。以下为按入口归并的全部 418 个名字，行号对应入口声明。

### packages/context/agent-instructions/src/index.ts（11）
L49 `agentInstructionsMessage`; L50 `applyInstructionVersionUpdates`; L51 `baselineInstructionState`; L52 `reconcileInstructionContext`; L53 `retainedInstructionVersionUpdates`; L63 `instructionContentSha1`, `trimmedInstructionDigest`; L64 `findProjectRoot`, `loadBaselineInstructionSet`; L65 `resolveConfig`, `workspaceBaselineIdentity`。

### packages/core/agent/src/index.ts（1）
L23 `agentRoleOf`。

### packages/core/tools/src/index.ts（3）
L419 `roleAllows`, `toolMinRole`, `withMinRole`。

### packages/interaction/tool-policy/src/index.ts（13）
L48 `BUILTIN_PROFILES`, `DEFAULT_PROFILE`, `LEGACY_PERMISSION_MODE_ENV`, `mapLegacyPermissionMode`; L50 `canonicalizeTarget`, `compareKey`, `defaultCaseSensitive`, `expandHome`, `isWithin`; L51 `findDeniedPath`; L52 `renderToolPolicyPrompt`; L53 `applyVisibilityForAgent`, `restrictableDeny`。

### packages/jira/jira-agent/src/index.ts（171）
L253 `applySessionPermission`; L254 `PERMISSION_DESCRIPTION`; L255 `PERMISSION_PARAMETERS`; L256 `PERMISSION_TOOL_NAME`; L257 `permissionOptions`; L258 `resolvePermissionTarget`; L259 `runPermissionTool`; L260 `SOFT_PERMISSION_PRESET`; L261 `SOFT_TOOL_PROFILE`; L262 `WORKSPACE_SESSION_PERMISSION`; L264 `DISPATCH_DOMAIN_NAME`, `dispatchDomainSpec`; L265 `createStoreAwareness`, `JIRA_AWARENESS_ORDER`, `JIRA_AWARENESS_SECTION_NAME`; L269 `agentPresetOf`; L270 `callerCwd`; L271 `callerParentSessionId`; L272 `callerSessionId`; L273 `describeCaller`; L274 `isExecutorSession`; L275 `isSubagent`; L276 `sessionAgentPreset`; L283 `createJiraCommand`; L284 `runJiraCommand`; L287 `JIRA_CAPABILITY_DESCRIPTION`; L288 `JIRA_CAPABILITY_ID`; L289 `JIRA_CAPABILITY_LABEL`; L290 `JIRA_CONTRACT_VERSION`; L291 `JIRA_EXECUTOR_ORDER`; L292 `JIRA_EXECUTOR_SECTION_NAME`; L293 `JIRA_SETTINGS_ORDER`; L294 `JIRA_SETTINGS_SECTION`; L295 `createJiraContribution`; L296 `settleCompletedTurn`; L299 `defaultEnv`, `readOnlySession`; L300 `actorFor`, `asString`, `asStringList`, `failure`, `nowUtc`, `okValue`, `skipped`; L302 `createSessionRecorder`; L303 `readPushFailure`; L304 `recordPushOutcome`; L305 `stateDirOf`; L306 `toolEvidenceOf`; L311 `SKILL_CATALOGUE`; L314 `packageRootFrom`; L315 `readSkillBody`; L316 `registerSkills`; L317 `skillPath`; L320 `ISSUE_DESCRIPTION`; L321 `ISSUE_OUTPUT_SCHEMA`; L322 `ISSUE_PARAMETERS`; L323 `READ_ACTIONS`; L324 `READ_TIMEOUT_MS`; L325 `TOOL_NAME`; L326 `WRITE_ACTIONS`; L327 `WRITE_TIMEOUT_MS`; L328 `runIssueTool`; L330 `KB_DESCRIPTION`, `KB_OUTPUT_SCHEMA`, `KB_PARAMETERS`, `KB_TOOL_NAME`, `runKbTool`; L331 `LIST_DESCRIPTION`, `LIST_OUTPUT_SCHEMA`, `LIST_PARAMETERS`, `LIST_TOOL_NAME`, `runListTool`; L332 `jiraTools`, `jiraWorkerTools`; L336 `pollGithub`; L338 `installWriteGuard`, `JIRA_COMMAND_NAME`, `registerJiraCommand`, `registerJiraSkills`; L340 `REVIEW_STATUS`; L341 `WAITING_FOR`; L342 `WORK_ACTIONS`; L343 `WORK_DESCRIPTION`; L344 `WORK_PARAMETERS`; L345 `WORK_TOOL_NAME`; L347 `blockedBody`; L348 `blockedMarker`; L349 `runWorkTool`; L350 `workAccess`; L353 `CLAIM_APPROVED_MARKER`; L354 `CLAIMABLE_STATUS`; L355 `CLAIM_DESCRIPTION`; L356 `CLAIM_PARAMETERS`; L357 `CLAIM_TOOL_NAME`; L358 `DEFAULT_MAX_WORKERS`; L359 `DAEMON_SESSION_ID`; L360 `DISPATCH_DESCRIPTION`; L361 `DISPATCH_MARKER`; L362 `DISPATCH_PARAMETERS`; L363 `DISPATCH_TOOL_NAME`; L364 `PROPOSAL_MARKER`; L365 `SCAN_DESCRIPTION`; L366 `SCAN_PARAMETERS`; L367 `SCAN_TOOL_NAME`; L368 `SOURCE_DESCRIPTION`; L369 `SOURCE_PARAMETERS`; L370 `SOURCE_TOOL_NAME`; L371 `STATUS_TOOL_NAME`; L372 `SUPERAGENT_CAPABILITY_DESCRIPTION`; L373 `SUPERAGENT_CAPABILITY_ID`; L374 `SUPERAGENT_CAPABILITY_LABEL`; L375 `SUPERAGENT_OUTPUT_SCHEMA`; L376 `SUPERAGENT_SECTION`; L377 `SUPERAGENT_SECTION_NAME`; L378 `SUPERAGENT_SECTION_ORDER`; L379 `SUPERAGENT_WORKSPACE_TITLE`; L380 `sessionActionFailure`; L381 `LEDGER_DESCRIPTION`; L382 `LEDGER_PARAMETERS`; L383 `LEDGER_TOOL_NAME`; L384 `DEFAULT_COMPACT_THRESHOLD_PERCENT`; L385 `DELIVER_DESCRIPTION`; L386 `DELIVER_PARAMETERS`; L387 `DELIVER_TOOL_NAME`; L388 `MEMORY_CURATION_INSTRUCTION`; L389 `activityOf`; L390 `cacheHitOf`; L391 `compactWorkspaceSession`; L392 `contextUsageOf`; L393 `longRunningSummary`; L394 `recentActivityOf`; L395 `MODELS_DESCRIPTION`; L396 `MODELS_PARAMETERS`; L397 `MODELS_TOOL_NAME`; L398 `CONTROL_DESCRIPTION`; L399 `CONTROL_PARAMETERS`; L400 `CONTROL_TOOL_NAME`; L409 `claimability`; L410 `createSuperagentContribution`; L411 `daemonIdentityOf`; L412 `deliverTaskReport`; L413 `runDeliverTool`; L414 `superAgentFsRoots`; L415 `dispatchInstruction`; L416 `dispatchRecordOf`; L417 `enforceSuperAgentPermission`; L418 `ensureSuperWorkspace`; L419 `handleTaskTurnEnd`; L420 `isBlocked`; L421 `isSuperAgentSession`; L422 `openProposal`; L423 `pinWorkspaceFirst`; L424 `runClaimTool`; L425 `runDaemonPass`; L426 `runDispatchTool`; L427 `resolveReportedTask`; L428 `runLedgerTool`; L429 `runModelsTool`; L430 `runScanTool`; L431 `runSourceTool`; L432 `runStatusTool`; L433 `runSuperagentPass`; L434 `runSessionTool`; L435 `runWorkspaceTool`; L436 `runControlTool`; L437 `sameCheckout`; L438 `sessionControllerOf`; L439 `superagentHomeProblem`; L440 `workspaceRegistryOf`; L441 `workspaceRosterLines`。

### packages/jira/jira-service/src/index.ts（5）
L77 `SUPERAGENT_APPROVAL_MARKER`, `SUPERAGENT_CLAIMABLE_STATUS`, `SUPERAGENT_PROPOSAL_MARKER`, `superagentStatusOf`, `superagentTriggersOf`。

### packages/jira/ui-jira/src/index.ts（3）
L10 `JIRA_SETTINGS_FIELDS`, `JIRA_SETTINGS_ORDER`, `JIRA_SETTINGS_SECTION`。

### packages/sandbox/sandbox-policy/src/index.ts（2）
L40 `HOME_WRITE_TOOL_NAME`, `homeWriteTool`。

### packages/session/session-persistence-jsonl/src/index.ts（1）
L180 `skippedStoredEvents`。

### packages/uitstalie/agent-instructions-plus/src/index.ts（8）
L51 `DEFAULT_RULES_MAX_BYTES`, `DEFAULT_RULES_MAX_SOURCE_BYTES`, `resolveRulesConfig`; L53 `RULES_DIRECTORY`, `rulesScanChanged`, `scanWorkspaceRules`; L55 `createAgentContextSources`; L57 `createRulesSource`。

### packages/uitstalie/common-view/src/index.ts（2）
L11 `COMMON_VIEW_DEFAULTS`, `resolveCommonViewConfig`。

### packages/uitstalie/dafeiyu/src/index.ts（1）
L59 `ConfigSchema`。

### packages/uitstalie/home-backup/src/index.ts（5）
L25 `DEFAULT_INTERVAL_MS`; L28 `DEFAULT_INITIAL_DELAY_MS`; L31 `DEFAULT_RETAIN`; L34 `DEFAULT_HOME_PATHS`; L70 `defaultDestination`。

### packages/uitstalie/llm-plus/src/index.ts（2）
L48 `PlusAdapter`; L57 `SETTINGS_NS`。

### packages/uitstalie/memory/src/index.ts（99）
L38 `MEMORY_CAPABILITY_ID`; L41 `MEMORY_SETTINGS_SECTION`; L44 `MEMORY_SETTINGS_ORDER`; L47 `MEMORY_CONTRACT_VERSION`; L50 `MEMORY_CAPABILITY_LABEL`; L53 `MEMORY_CAPABILITY_DESCRIPTION`; L56 `resolveConfig`; L59 `appendMemoryEntry`; L60 `appendTurnSummary`; L61 `assertMemoryEntryKind`; L62 `createMemoryDocument`; L63 `DEFAULT_MEMORY_MAX_BYTES`; L64 `DEFAULT_MEMORY_MAX_ENTRIES`; L65 `DEFAULT_MEMORY_WINDOW`; L66 `editMemorySummary`; L67 `forgetMemoryEntries`; L68 `MEMORY_ARCHIVE_BEGIN`; L69 `MEMORY_ARCHIVE_END`; L70 `MEMORY_ARCHIVE_STORE_PATH`; L71 `MEMORY_EVICTION_RECORD_LIMIT`; L72 `MEMORY_EVICTION_TEXT_MAX_CHARS`; L73 `MEMORY_BLOCK_BEGIN`; L74 `MEMORY_BLOCK_END`; L75 `MEMORY_BRIEF_MAX_CHARS`; L76 `MEMORY_BRIEF_MAX_ENTRIES`; L77 `MEMORY_DOCUMENT_VERSION`; L78 `MEMORY_ENTRY_KINDS`; L79 `MEMORY_HISTORY_LIMIT`; L80 `MEMORY_HISTORY_STORE_PATH`; L81 `MEMORY_KIND_REGISTRY`; L82 `MEMORY_STORE_PATH`; L84 `memoryKindDefinition`; L85 `memoryArchiveRecord`; L86 `archiveEvictionRecord`; L87 `appendEvictionRecords`; L88 `removeMemoryEntry`; L89 `pruneEmptyMemorySessions`; L90 `resolveMemoryEntriesInStore`; L91 `migrateMemoryTiers`; L92 `parseMemoryDocument`; L93 `pruneMemorySession`; L94 `pruneSessionEntries`; L95 `readMemoryDocument`; L96 `readMemorySummaryHistory`; L97 `renderMemoryDocument`; L98 `revertMemorySummary`; L99 `setMemorySummaryPaused`; L100 `summarizeMemoryEntries`; L101 `summaryPaused`; L138 `DEFAULT_MEMORY_FILES_TTL_DAYS`; L139 `DEFAULT_MEMORY_OPEN_TTL_DAYS`; L140 `DEFAULT_MEMORY_SUPERSESSION_MIN_SHARED_TAGS`; L141 `cleanupMemoryDocument`; L142 `resolveMemoryEntries`; L153 `MEMORY_ARCHIVE_TITLE`; L154 `appendMemoryArchive`; L155 `readMemoryArchive`; L158 `collectMemoryEntryTimes`; L161 `isMemoryCheckpointSource`; L162 `replaceSurfaceRange`; L168 `MEMORY_PROMPT_ORDER`, `MEMORY_PROMPT_SECTION`, `MEMORY_PROMPT_SECTION_NAME`, `MEMORY_PROMPT_TEXT`; L170 `appendMemoryNotice`; L171 `isMemorySnapshotSource`; L172 `MEMORY_SNAPSHOT_HINT`; L173 `MEMORY_SNAPSHOT_MAX_BYTES`; L174 `MEMORY_SNAPSHOT_SECTION_NAME`; L175 `MEMORY_SNAPSHOT_TITLE`; L176 `MEMORY_STATE_SECTION_NAME`; L177 `MEMORY_STATE_SECTION_ORDER`; L178 `applySnapshotTemplate`; L179 `appendMemoryUpdate`; L180 `refreshMemorySnapshot`; L181 `renderMemorySnapshot`; L182 `syncMemorySnapshot`; L190 `MEMORY_SUMMARY_ENTRY_MAX_CHARS`; L191 `MEMORY_SUMMARY_FAILURE_NOTICE`; L192 `MEMORY_SUMMARY_INPUT_MAX_BYTES`; L193 `MEMORY_SUMMARY_MAX_ATTEMPTS`; L194 `memorySummaryFailureNotice`; L195 `classifySummaryFailure`; L196 `MEMORY_SUMMARY_JOB_KIND`; L197 `MEMORY_SUMMARY_JOB_LABEL`; L198 `MEMORY_SUMMARY_TEXT_MAX_BYTES`; L199 `MemorySummaryRunner`; L200 `parseBriefEntries`; L201 `parseSummaryEntries`; L204 `MEMORY_READ_MAX_BYTES`; L205 `MEMORY_READ_NARROW_HINT`; L206 `MEMORY_READ_TEXT_MAX_BYTES`; L207 `MEMORY_READ_WINDOW_MAX_EVENTS`; L209 `memoryTools`; L212 `MEMORY_COMMAND_NAME`; L213 `MEMORY_COMMAND_USAGE`; L214 `memoryCommand`; L215 `registerMemoryCommands`; L217 `planTierMigrations`。

### packages/uitstalie/models-dev/src/index.ts（2）
L40 `DEFAULT_SOURCE_URL`; L42 `MAX_CATALOG_BYTES`。

### packages/uitstalie/persona-card/src/index.ts（38）
L10 `DEFAULT_PERSONA_MAX_BYTES`, `PERSONA_SCHEMA`; L22 `parsePersonaCard`, `renderPersonaText`; L23 `importCharacterCard`; L25 `loadPersonaCards`, `parsePersonaFile`, `PERSONA_CARD_SECTION_NAME`, `PERSONA_CARD_SECTION_ORDER`, `PERSONA_CARDS_DIRECTORY`; L29 `DIRECTOR_COMMAND_NAME`; L30 `DIRECTOR_COMMAND_USAGE`; L31 `directorCommand`; L32 `PERSONA_COMMAND_NAME`; L33 `PERSONA_COMMAND_USAGE`; L34 `personaCommand`; L35 `registerDirectorCommand`; L36 `registerPersonaCommands`; L41 `DIRECTOR_NOTE_CLEARED`; L42 `DIRECTOR_NOTE_MAX_BYTES`; L43 `DIRECTOR_NOTE_SECTION_NAME`; L44 `DIRECTOR_NOTE_TITLE`; L45 `directorNoteMessage`; L46 `isDirectorNoteSource`; L47 `normalizeDirectorNote`; L48 `renderDirectorNote`; L49 `syncDirectorNote`; L54 `PERSONA_STATE_HISTORY_LIMIT`; L55 `PERSONA_STATE_MAX_BYTES`; L56 `PERSONA_STATE_SECTION_NAME`; L57 `PERSONA_STATE_TITLE`; L58 `PersonaStateStore`; L59 `isPersonaStateSource`; L60 `personaStateMessage`; L61 `personaStateTool`; L62 `renderPersonaStateText`; L63 `syncPersonaStateMessage`; L64 `validatePersonaStateValue`。

### packages/uitstalie/personality/src/index.ts（4）
L58 `PERSONALITY_CAPABILITY_ID`; L61 `PERSONALITY_CONTRACT_VERSION`; L64 `PERSONALITY_CAPABILITY_LABEL`; L67 `PERSONALITY_CAPABILITY_DESCRIPTION`。

### packages/uitstalie/store-atom/src/index.ts（22）
L36 `DEFAULT_STORE_PATH_LIMITS`; L37 `isPathInside`; L38 `normalizeStorePath`; L39 `resolveStoreTarget`; L40 `STORE_DIR_NAME`; L45 `isMemoryPath`; L46 `isRulesPath`; L47 `isSkillsPath`; L48 `RULES_NAMESPACE_PATTERN`; L49 `SKILLS_NAMESPACE_PATTERN`; L50 `validateNamespaceContent`; L52 `RULES_DIRECTORY`, `rulesScanChanged`, `scanWorkspaceRules`; L55 `createStoreFile`; L56 `createStoreFolder`; L57 `ensureStoreRoot`; L58 `queryStoreTarget`; L59 `removeStoreTarget`; L69 `resolveSessionStorePolicy`, `resolveStorePolicy`; L71 `createDshStore`。

### packages/uitstalie/system-environment/src/index.ts（1）
L111 `createSystemEnvironment`。

### packages/uitstalie/token-calculator/src/index.ts（13）
L22 `TOKEN_CAPABILITY_ID`; L25 `TOKEN_CAPABILITY_LABEL`; L28 `TOKEN_CAPABILITY_DESCRIPTION`; L30 `registerTokensCommand`, `TOKENS_COMMAND_NAME`, `TOKENS_COMMAND_USAGE`, `tokensCommand`; L31 `countTokensTool`, `TOKEN_TEXT_MAX_BYTES`, `TOKEN_TOOL_NAME`; L32 `countTokens`, `encodeTokens`, `loadTokenizer`。

### packages/uitstalie/tool-dsh-store/src/index.ts（7）
L27 `STORE_CAPABILITY_ID`; L29 `STORE_CAPABILITY_LABEL`; L31 `STORE_CAPABILITY_DESCRIPTION`; L34 `defineStoreTool`; L36 `storeRelativePath`, `storeRootOfWorkspace`, `workspaceRootOf`。

### packages/uitstalie/ui-dafeiyu/src/index.ts（2）
L11 `CAPABILITIES_SETTINGS_ORDER`, `CAPABILITIES_SETTINGS_SECTION`。

### packages/uitstalie/ui-memory/src/index.ts（2）
L10 `MEMORY_SETTINGS_ORDER`, `MEMORY_SETTINGS_SECTION`。

## 2. 导出 JSDoc（105 项）

依据：`AGENTS.md#type-safety-and-documentation` L177。命令：`pnpm run verify-export-jsdoc`，退出 1。每条保留 gate 原文的定位和缺项。

- `packages/api/session-controller/src/agent.ts:265` `ApiSessionAgentController.composeAgent`：缺 `@param role`。
- `packages/core/tools/src/role.ts:22` `roleAllows`：缺 `@param role`、`@param minimum`、`@returns boolean`。
- `packages/core/tools/src/role.ts:27` `withMinRole`：缺 `@param tool`、`@param minimum`、`@returns T & { readonly minRole: AgentRole }`。
- `packages/core/tools/src/role.ts:35` `toolMinRole`：缺 `@param tool`、`@returns AgentRole | undefined`。
- `packages/uitstalie/memory/src/memory-file.ts:2734` `appendEvictionRecords`：缺 `@param document`、`@param records`、`@returns MemoryDocument`。
- `packages/uitstalie/memory/src/summary.ts:88` `memorySummaryFailureNotice`：缺 `@param failure`、`@returns string`。
- `packages/uitstalie/personality/src/agent-tools.ts:24` `personalityAnalyzeTool`：缺 `@param ctx`、`@returns ToolDefinition`。
- `packages/uitstalie/personality/src/agent-tools.ts:104` `personalityApplyTool`：缺 `@param ctx`、`@param refresh`、`@returns ToolDefinition`。
- `packages/uitstalie/personality/src/analyze.ts:126` `analyzePersonality`：缺 `@param ctx`、`@param caller`、`@param input`、`@param signal`、`@returns Promise<AnalyzeResult>`。
- `packages/uitstalie/personality/src/analyze.ts:164` `renderAnalyzeResult`：缺 `@param result`、`@returns string`。
- `packages/uitstalie/personality/src/apply.ts:61` `applyPersonalityCandidates`：缺 `@param ctx`、`@param input`、`@param signal`、`@returns Promise<ApplyResult>`。
- `packages/uitstalie/personality/src/apply.ts:96` `renderApplyResult`：缺 `@param result`、`@returns string`。
- `packages/uitstalie/personality/src/defaults.ts:70` `seedGlobalPersonalityFiles`：缺 `@param ctx`、`@param signal`、`@returns Promise<SeedResult>`。
- `packages/uitstalie/personality/src/global-store.ts:122` `globalPersonalityPath`：缺 `@returns string`。
- `packages/uitstalie/personality/src/global-store.ts:127` `personalityEntryId`：缺 `@param kind`、`@param name`、`@returns string`。
- `packages/uitstalie/personality/src/global-store.ts:132` `parsePersonalityEntryId`：缺 `@param id`、`@returns { readonly kind: PersonalityEntryKind; readonly name: string }`。
- `packages/uitstalie/personality/src/global-store.ts:153` `createPersonalityDocument`：缺 `@param entries`、`@param now`、`@returns PersonalityDocument`。
- `packages/uitstalie/personality/src/global-store.ts:165` `renderPersonalityDocument`：缺 `@param document`、`@returns string`。
- `packages/uitstalie/personality/src/global-store.ts:176` `parsePersonalityDocument`：缺 `@param text`、`@returns PersonalityDocument`。
- `packages/uitstalie/personality/src/global-store.ts:235` `readGlobalPersonality`：缺 `@param ctx`、`@param signal`、`@returns Promise<PersonalityRead>`。
- `packages/uitstalie/personality/src/global-store.ts:255` `writeGlobalPersonality`：缺 `@param ctx`、`@param document`、`@param expectedVersion`、`@param signal`、`@returns Promise<{ readonly path: string; readonly version?: string }>`。
- `packages/uitstalie/personality/src/global-store.ts:279` `upsertGlobalPersonalityEntry`：缺 `@param ctx`、`@param input`、`@param signal`、`@returns Promise<PersonalityWriteResult>`。
- `packages/uitstalie/personality/src/global-store.ts:324` `migrateLegacyPersonality`：缺 `@param ctx`、`@param signal`、`@returns Promise<LegacyMigration>`。
- `packages/uitstalie/personality/src/output-style.ts:87` `outputStylePath`：缺 `@param slot`、`@returns string`。
- `packages/uitstalie/personality/src/output-style.ts:95` `parseOutputStyle`：缺 `@param text`、`@returns OutputStyleConfig`。
- `packages/uitstalie/personality/src/output-style.ts:122` `renderOutputStyle`：缺 `@param config`、`@returns string`。
- `packages/uitstalie/personality/src/output-style.ts:134` `readOutputStyle`：缺 `@param ctx`、`@param signal`、`@param slot`、`@returns Promise<OutputStyleRead>`。
- `packages/uitstalie/personality/src/output-style.ts:157` `renderOutputStyleSection`：缺 `@param config`、`@param options`、`@returns string`。
- `packages/uitstalie/personality/src/profile-prompt.ts:30` `renderPersonalitySection`：缺 `@param entries`、`@returns string`。
- `packages/uitstalie/personality/src/writing-rules.ts:109` `writingRulesPath`：缺 `@returns string`。
- `packages/uitstalie/personality/src/writing-rules.ts:114` `parseWritingRules`：缺 `@param text`、`@returns WritingRulesDocument`。
- `packages/uitstalie/personality/src/writing-rules.ts:152` `renderWritingRules`：缺 `@param document`、`@returns string`。
- `packages/uitstalie/personality/src/writing-rules.ts:166` `readWritingRules`：缺 `@param ctx`、`@param signal`、`@returns Promise<WritingRulesRead>`。
- `packages/uitstalie/personality/src/writing-rules.ts:180` `writeWritingRules`：缺 `@param ctx`、`@param document`、`@param expectedVersion`、`@param signal`、`@returns Promise<{ readonly path: string; readonly version?: string }>`。
- `packages/uitstalie/personality/src/writing-rules.ts:198` `mutateWritingRules`：缺 `@param document`、`@param input`、`@returns WritingRulesMutation`。
- `packages/uitstalie/personality/src/writing-rules.ts:246` `previewWritingRules`：缺 `@param document`、`@returns string`。
- `packages/uitstalie/personality/src/writing-tool.ts:58` `writingRulesTool`：缺 `@param ctx`、`@param refresh`、`@returns ToolDefinition`。
- `packages/uitstalie/personality/src/writing-tool.ts:175` `renderWritingRulesResult`：缺 `@param result`、`@returns string`。
- `packages/workspace/workspace/src/index.ts:254` `WorkspaceRegistry.create`：缺 `@param role`。
- `packages/workspace/workspace/src/spec.ts:28` `workspaceRoleOf`：缺 `@param value`、`@returns WorkspaceRole`。
- `packages/workspace/workspace/src/spec.ts:30` `workspaceRecord`：无 JSDoc。

## 3. 新增 unknown-cast（31 处）

依据：`AGENTS.md#conventions` L148。命令：`pnpm run verify-no-unknown-casts`，退出 1。

1. `packages/api/session-controller/tests/agent.host.spec.ts:265`
2. `packages/boot/plugin-manager/tests/tools.spec.ts:315`
3. `packages/core/tools/tests/role-visibility.spec.ts:64`
4. `packages/interaction/permission-presets/tests/permission-presets.spec.ts:201`
5. `packages/interaction/permission-presets/tests/permission-presets.spec.ts:207`
6. `packages/interaction/permission-presets/tests/permission-presets.spec.ts:223`
7. `packages/jira/jira-agent/src/compaction-seam.test.ts:80`
8. `packages/jira/jira-agent/src/compaction-seam.test.ts:113`
9. `packages/jira/jira-agent/src/superagent.test.ts:1125`
10. `packages/jira/jira-agent/src/superagent.test.ts:1141`
11. `packages/jira/jira-agent/src/superagent.test.ts:2452`
12. `packages/jira/jira-agent/src/superagent.test.ts:3050`
13. `packages/jira/jira-agent/src/superagent.ts:1522`
14. `packages/jira/jira-agent/src/superagent.ts:1623`
15. `packages/jira/tests/superagent-real-loop.spec.ts:238`
16. `packages/jira/tests/superagent-real-loop.spec.ts:283`
17. `packages/jira/tests/superagent-real-loop.spec.ts:291`
18. `packages/jira/ui-jira/src/client/index.ts:151`
19. `packages/jira/ui-jira/src/client/index.ts:157`
20. `packages/jira/ui-jira/src/client/index.ts:174`
21. `packages/jira/ui-jira/src/client/index.ts:186`
22. `packages/llm/llm-pi-ai/src/config.ts:288`
23. `packages/session/session-persistence/tests/contract.ts:523`
24. `packages/session/session-persistence/tests/storage-contract.spec.ts:125`
25. `packages/session/session-persistence/tests/storage-contract.spec.ts:134`
26. `packages/superagent/superagent-core/src/dispatch-store.test.ts:86`
27. `packages/uitstalie/memory/tests/summary.spec.ts:753`
28. `packages/uitstalie/memory/tests/window-growth.spec.ts:86`
29. `packages/uitstalie/personality/tests/provider.spec.ts:270`
30. `packages/uitstalie/tool-dsh-store/tests/remote-role.spec.ts:14`
31. `packages/workflow/tool-workflow/tests/tool-workflow.spec.ts:729`
