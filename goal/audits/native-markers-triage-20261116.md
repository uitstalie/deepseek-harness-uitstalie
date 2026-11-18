# 原生标记候选分流（2026-11-16）

依据：`goal/audits/code-conventions-20261116-native-markers.txt`；基线为审计当日（2026-11-16）的分支顶端。按仓库引用规则不保存提交标识，需要时以当日运行 `git rev-parse HEAD` 的输出为准。

- A 需补：1
- B 不需补：103
- C 不确定：42

| 类别 | 文件 | 依据 |
| --- | --- | --- |
| B | `apps/cli/config/overlays/os-sandbox.yml` | 新增文件，无上游行可比，按新文件处理 |
| B | `apps/cli/config/overlays/soft-policy.yml` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| B | `packages/api/session-controller/src/agent.ts` | 已有 uitstalie 标记；其余为导入/类型/上游上下文 |
| B | `packages/api/session-controller/tests/agent.host.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/api/terminal-controller/src/types.ts` | 类型/契约声明，不含可执行逻辑块 |
| C | `packages/boot/plugin-manager/src/tools.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/boot/plugin-manager/tests/tools.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/bundle/base/cordis.patch.uitstalie.yml` | 新增文件，无上游行可比，按新文件处理 |
| C | `packages/bundle/base/cordis.patch.yml` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/bundle/headless/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| B | `packages/bundle/headless/tests/headless.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/bundle/web-app/cordis.patch.uitstalie.yml` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/client/ui-permission-presets/src/client/locales.ts` | locale 字典，不含业务逻辑 |
| B | `packages/client/ui-permission-presets/tests/browser-plugin.client.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/client/ui-permission-presets/tests/permission-select.client.spec.tsx` | 测试文件，不参与产品代码标记 |
| B | `packages/client/ui-workspace/src/client/locales.ts` | locale 字典，不含业务逻辑 |
| B | `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.module.css` | README/i18n/样式，不含业务逻辑 |
| B | `packages/client/ui-workspace/src/client/workspace-groups.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/core/agent-loop/src/agent.ts` | 已有 uitstalie 标记；其余为导入/类型/上游上下文 |
| C | `packages/core/agent-loop/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/core/agent-loop/src/tool-pairing.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/core/agent-loop/tests/tool-pairing-loop.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/core/agent-loop/tests/tool-pairing.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/core/agent/src/index.ts` | 已有 uitstalie 标记；其余为导入/类型/上游上下文 |
| B | `packages/core/agent/src/role.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/core/agent/src/runtime-types.ts` | 类型/契约声明，不含可执行逻辑块 |
| C | `packages/core/session/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/core/session/src/known-event-types.ts` | 生成物/派生产物 |
| C | `packages/core/session/src/surface.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/core/session/src/types.ts` | 类型/契约声明，不含可执行逻辑块 |
| B | `packages/core/system-prompt/src/index.ts` | 已有 uitstalie 标记；其余为导入/类型/上游上下文 |
| B | `packages/core/system-prompt/tests/system-prompt.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/core/tools/src/contracts.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/core/tools/src/index.ts` | 已有 uitstalie 标记；其余为导入/类型/上游上下文 |
| B | `packages/core/tools/src/role.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/core/tools/tests/role-visibility.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` | 生成物/派生产物 |
| B | `packages/extensions/tool-cordis/src/api-catalog.ts` | 生成物/派生产物 |
| B | `packages/fs/fs-local/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| B | `packages/fs/fs-sandbox/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| B | `packages/fs/fs/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| B | `packages/fs/tool-fs/src/policy.ts` | 新增文件，无上游行可比，按新文件处理 |
| C | `packages/fs/tool-fs/src/sandbox.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/interaction/permission-presets/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| B | `packages/interaction/permission-presets/src/types.ts` | 类型/契约声明，不含可执行逻辑块 |
| B | `packages/interaction/permission-presets/tests/projection.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/llm/llm-pi-ai/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| C | `packages/llm/llm-pi-ai/src/catalog.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/llm/llm-pi-ai/src/config.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/llm/llm-pi-ai/tests/conversation-updates.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/llm/llm-pi-ai/tests/native-auth.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/llm/llm-pi-ai/tests/tool-argument-streaming.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/llm/llm/src/content.ts` | 已有 uitstalie 标记；其余为导入/类型/上游上下文 |
| C | `packages/llm/llm/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/llm/llm/tests/content.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/sandbox/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| B | `packages/sandbox/sandbox-local/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| C | `packages/sandbox/sandbox-local/src/profiles.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/sandbox/sandbox-local/tests/acl-disabled.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/sandbox/sandbox-local/tests/bwrap.e2e.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/sandbox/sandbox-local/tests/linux-probe.e2e.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/sandbox/sandbox-policy/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| B | `packages/sandbox/sandbox-policy/src/home-write-tool.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/sandbox/sandbox-policy/tests/home-write-tool.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/sandbox/sandbox-windows-acl/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| C | `packages/sandbox/sandbox-windows-acl/src/acl.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/sandbox/sandbox-windows-acl/src/ffi.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/sandbox/sandbox-windows-acl/src/grant.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/sandbox/sandbox-windows-acl/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/sandbox/sandbox-windows-acl/src/path-boundary.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/sandbox/sandbox-windows-acl/src/runner.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/sandbox/sandbox-windows-acl/src/testing.ts` | 新增文件，无上游行可比，按新文件处理 |
| C | `packages/sandbox/sandbox-windows-acl/src/token.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/sandbox/sandbox-windows-acl/src/win32-abi.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/sandbox/sandbox-windows-acl/tests/acl-failure-paths.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/sandbox/sandbox-windows-acl/tests/acl.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/sandbox/sandbox-windows-acl/tests/grant-failure-paths.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/sandbox/sandbox-windows-acl/tests/index-failure-paths.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/sandbox/sandbox-windows-acl/tests/probe.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/sandbox/sandbox-windows-acl/tests/runner-disabled.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/sandbox/sandbox-windows-acl/tests/token-failure-paths.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/sandbox/sandbox/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| B | `packages/sandbox/sandbox/src/home-write.ts` | 新增文件，无上游行可比，按新文件处理 |
| C | `packages/sandbox/sandbox/src/roots.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/sandbox/sandbox/tests/home-write.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/sandbox/sandbox/tests/roots.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/schedule/tool-schedule/src/index.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/schedule/tool-schedule/tests/tool-schedule.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/session-query/session-query-sqlite/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| C | `packages/session-query/session-query-sqlite/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/session-query/session-query-sqlite/tests/sqlite.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/session-query/session-query/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| C | `packages/session-query/session-query/src/cold-read.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/session-query/session-query/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/session-query/session-query/src/observation.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/session-query/session-query/src/types.ts` | 类型/契约声明，不含可执行逻辑块 |
| B | `packages/session-query/session-query/tests/observation.spec.ts` | 测试文件，不参与产品代码标记 |
| C | `packages/session/session-format-v0-to-v1/src/dispositions.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/session/session-format-v0-to-v1/src/payload-validation.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/session/session-format-v0-to-v1/tests/validation.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/session/session-format-v1-to-v2/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| C | `packages/session/session-format-v1-to-v2/src/codec.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/session/session-format-v1-to-v2/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/session/session-format-v1-to-v2/src/migration.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/session/session-format-v1-to-v2/src/validation.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/session/session-format-v1-to-v2/tests/migration.spec.ts` | 测试文件，不参与产品代码标记 |
| C | `packages/session/session-format-v2-to-v3/src/payload.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/session/session-format-v3-to-v4/src/codec.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/session/session-format-v3-to-v4/src/validation.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/session/session-format-v3-to-v4/tests/codec.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/session/session-format-v3-to-v4/tests/developer.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/session/session-format-v3-to-v4/tests/migration.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/session/session-format-v3-to-v4/tests/open-vocabulary.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/session/session-format-v3-to-v4/tests/validation.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/session/session-persistence-jsonl/src/index.ts` | 已有 uitstalie 标记；其余为导入/类型/上游上下文 |
| C | `packages/session/session-persistence-jsonl/src/storage.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/session/session-persistence-jsonl/tests/current-event-admission.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/session/session-persistence/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| C | `packages/session/session-persistence/src/handle.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/session/session-persistence/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/session/session-persistence/src/storage-contract.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/session/session-persistence/tests/contract.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/session/session-persistence/tests/storage-contract.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/shell/bash-sandbox/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| B | `packages/shell/pwsh-sandbox/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| C | `packages/shell/tool-bash/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/shell/tool-pwsh/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| C | `packages/subagent/tool-subagent-control/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| C | `packages/subagent/tool-subagent-control/src/list-agents.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/subagent/tool-subagent-control/src/wait-agent.ts` | 新增文件，无上游行可比，按新文件处理 |
| C | `packages/subagent/tool-subagent/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/subagent/tool-subagent/tests/depth-context.spec.ts` | 新增文件，无上游行可比，按新文件处理 |
| B | `packages/subagent/tool-subagent/tests/model-selection-settings.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/test-support/client-runtime/README.i18n.yaml` | README/i18n/样式，不含业务逻辑 |
| C | `packages/workflow/tool-workflow/src/index.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `packages/workflow/tool-workflow/tests/tool-workflow.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `packages/workspace/workspace/src/entity.ts` | 已有 uitstalie 标记；其余为导入/类型/上游上下文 |
| A | `packages/workspace/workspace/src/index.ts` | 角色链路：create 的 durable role 参数与持久化 |
| B | `packages/workspace/workspace/src/spec.ts` | 已有 uitstalie 标记；其余为导入/类型/上游上下文 |
| B | `packages/workspace/workspace/src/types.ts` | 类型/契约声明，不含可执行逻辑块 |
| B | `packages/workspace/workspace/tests/workspace.spec.ts` | 测试文件，不参与产品代码标记 |
| B | `scripts/clean.spec.ts` | 测试文件，不参与产品代码标记 |
| C | `scripts/clean.ts` | 修改过的实现文件；无法仅凭文件级 diff 判定插入块归属/成本，需 hunk 级 ownership |
| B | `scripts/test-jira-node.ts` | 新增文件，无上游行可比，按新文件处理 |
