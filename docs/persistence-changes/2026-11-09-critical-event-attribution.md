---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-critical-event-attribution

English | [中文](2026-11-09-critical-event-attribution.zh.md)

## Summary

Records current Session envelope and producer additions: optional critical attribution, persona and director sources, the tool-pair-repair event, permission audit reasons, and the guarded sandbox mode.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-critical-event-attribution
baseline: false
changes:
  - root: "SessionEventEnvelope"
    previous: "2026-09-11-initial"
    after: "b183a29dbe615dd7b0dcbc31c3ed503adbc9b7c90520193a50d15757165f575e"
    decision: same-version
  - root: "event:agent-preset/selected"
    previous: "2026-09-11-initial"
    after: "7387559e11f3e57fb03be1f907e639f517ac984b46ee81a4bbdada27dbbd38e9"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "7e573f8970aa5cf2487252b1e8377a3f887d663f0581a1cd2c1c2c9413e8434e"
    decision: same-version
  - root: "event:agent/tool-pair-repair"
    previous: null
    after: "38f1b0630dbd628803b666594ae0b86c46845c10a5d88d6fecda7bb8f8fbd81d"
    decision: same-version
  - root: "event:approval/asked"
    previous: "2026-09-11-initial"
    after: "9a63fca0f6d980ca14ad8ff965821cb1bf4c0a3d63a0c300feda4a05af7f8f3f"
    decision: same-version
  - root: "event:approval/decided"
    previous: "2026-09-11-initial"
    after: "a2f5ef4413a1120d47278abb121ad1b3eb51fb7766ee960bd1f87778a9abe795"
    decision: same-version
  - root: "event:approval/policy"
    previous: "2026-09-11-initial"
    after: "9b555c20c60189327798d5177fbe7c283793c874b88a8cd635494c39584fba41"
    decision: same-version
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "196e634047cff21017852e88aa4535beb6b8267255aef17f19c30fe23abea9e5"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "5c20209ca040038b7430ccc6e53a6445ddbaa5f67d1577eda2f4d197b848905c"
    decision: same-version
  - root: "event:command/done"
    previous: "2026-09-11-initial"
    after: "6dfac2a6f4c3039dad9859d27752f932dc6d494e0af529004e07c83b8fda299e"
    decision: same-version
  - root: "event:command/run"
    previous: "2026-09-11-initial"
    after: "2c1fe7d515f502292f73c3e1411349d7d670dcb9a59e76039ecb446559f29064"
    decision: same-version
  - root: "event:compaction/end"
    previous: "2026-09-11-initial"
    after: "acddf3a70b5b806cd493b049a5637188f117940d1275c648be76cfa061024ace"
    decision: same-version
  - root: "event:compaction/prune"
    previous: "2026-09-11-initial"
    after: "de8654a8b3411e03e44fc8c6ce370b7da834a997cddaa49064b3027ed16e83d2"
    decision: same-version
  - root: "event:compaction/start"
    previous: "2026-09-11-initial"
    after: "3541a90f8678b2c1abd6b47c11a6207f028a7c9bf393982df3d9d1f19f990017"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "66d55c42a9cbaae367be40cd07e6ef022e0b0b8a7f0d28bcfbc828b01b98484d"
    decision: same-version
  - root: "event:deliverables/presented"
    previous: "2026-09-11-initial"
    after: "0299106a211ea26f7b427c7d2996120e9fe3099ef9c1710af120b92beedf426a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "564d4d33868cef0cfa6500d741de7d60e6baeca05c02987bddcee24e4814bf6b"
    decision: same-version
  - root: "event:feedback/message-delete"
    previous: "2026-09-11-initial"
    after: "cc803974c8538b06490a5791a7dd4acab26a3203a4b08176f4b6dcdbc485e9e2"
    decision: same-version
  - root: "event:feedback/message-put"
    previous: "2026-09-11-initial"
    after: "3c37b7c30031ee664b0ff4b16ec45c8466434e41e72663ee117600815b849372"
    decision: same-version
  - root: "event:feedback/record"
    previous: "2026-09-11-initial"
    after: "61579410c31669d7da2316dc25aa7f3a913cbefadf0168696b69abbd0cc5045b"
    decision: same-version
  - root: "event:goal/change"
    previous: "2026-09-11-initial"
    after: "8ebe51c966a42943c527ad3d749780583f220b465a1c1cff4081ff671192acc7"
    decision: same-version
  - root: "event:hook/invoked"
    previous: "2026-09-11-initial"
    after: "a314b9cec7e11702e5415267184e459c8c3e719b1f07c9b5d9a0c61d650a003b"
    decision: same-version
  - root: "event:hook/result"
    previous: "2026-09-11-initial"
    after: "266303abe80ebed69a76092076d6a1c92422591a37c169dff86609df35acfa45"
    decision: same-version
  - root: "event:image/offload"
    previous: "2026-09-14-image-offload"
    after: "2bea166b2f18f8b3fc9f7d614b12305600082cfe514f951e53ee19d7d127b9b0"
    decision: same-version
  - root: "event:job/registered"
    previous: "2026-09-30-job-session-lifecycle"
    after: "5b8c4e7ba64959cac1c15a40ba09c1c935eb61b8b34c7bc79d5babe7956bae7e"
    decision: same-version
  - root: "event:job/settled"
    previous: "2026-09-30-job-session-lifecycle"
    after: "b3cff8e76024be33cfd9609caafae534aa1fba70f709715af02eed0aed391ccc"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "f71ff89be0dc16a33b7d987d6c3f40783f7aae6ef929ba4ace2d2296d5f8974a"
    decision: same-version
  - root: "event:llm/retry-started"
    previous: "2026-09-11-initial"
    after: "90b76751322ce0ec6422b93bd78388200ea97c64096ec13d91ffb1996ce23a47"
    decision: same-version
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "9b0181e3b13caa77187b3d156fa67f08eb6aba452281f62e648738241a066dee"
    decision: same-version
  - root: "event:permission/preset"
    previous: "2026-09-11-initial"
    after: "2d6543bbf8c50582200baea63a399a40f46eafcbaab4b0f2f14e01fc3fd4fe61"
    decision: same-version
  - root: "event:plan/mode"
    previous: "2026-09-11-initial"
    after: "6c5bdb9c1f755d49e4c67581397d69596979f9e1a17ee8a4c12d2752aa45e1cd"
    decision: same-version
  - root: "event:request/context"
    previous: "2026-09-11-initial"
    after: "b199bff25c14d492ab2ed540d66e3bb366e0dd67018904f3e6580f2c707f5701"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "721d1a6035ed52fe3be515fc18fd13fac59b45a34cb6fe9c8cf8c7cce75570e4"
    decision: same-version
  - root: "event:sandbox/mode"
    previous: "2026-09-11-initial"
    after: "a7e4f811cc4e023a48dac413a9aa6e9b479eb4636cb90a60bd8bef475143dcd5"
    decision: same-version
  - root: "event:schedule/change"
    previous: "2026-09-18-schedule-optional-title"
    after: "acba3f903a707c725725ae81fb76f85271310bdb884bea33517b3541987f7f58"
    decision: same-version
  - root: "event:session-log-deepseek/delivery-accepted"
    previous: "2026-09-11-initial"
    after: "8e9a0527b61c8acec4204c1835e06b248767867fa9cdb6a5f86e8eeb9082d3f7"
    decision: same-version
  - root: "event:session/end-seed"
    previous: "2026-09-11-initial"
    after: "d7c6c77c67e0d006a49d9ba08421492010ea3367870b0cee1fbfb88126fa03f0"
    decision: same-version
  - root: "event:session/title"
    previous: "2026-09-11-initial"
    after: "9151e801a7f328c78e8db150617625171ea06203eb2bb69abd1f08c0946b9206"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "e8d289544abf353b1b56b00389c81e046ff97485412e02077fc00b724080a1e5"
    decision: same-version
  - root: "event:step/end"
    previous: "2026-09-11-initial"
    after: "d6e373462f760eae9154a4252b5f5e14d435efb27aa605dcaa8e5e40ff113cd7"
    decision: same-version
  - root: "event:step/start"
    previous: "2026-09-11-initial"
    after: "9d17ce89eab2149a9df6b5f1f73393400dd5f9785ff745256f7388511679eec4"
    decision: same-version
  - root: "event:subagent/catalog"
    previous: "2026-11-02-subagent-catalog-names"
    after: "28f92c7bc57234cc576bccc2b888373d823ce363119953e0eee8e837cb5fe284"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "4159f6f657e9e5aa94345d5b2cc51740e4435047ec1e24440606cee3d86a6936"
    decision: same-version
  - root: "event:subagent/model-selection-policy"
    previous: "2026-09-11-initial"
    after: "bbbae83fde6555662da40f71aacfb05dcbe4c434619fe5cdca86771c1590682b"
    decision: same-version
  - root: "event:system/message"
    previous: "2026-09-16-session-format-v4"
    after: "edf1196fe823cd80cbd1242bd67b81d7f0501362f8372d5c79d3910fb30533a5"
    decision: same-version
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "ca6bc2de99ffccadbde3af20e0c75e9837539abd8c30d6b9dd2eb46890a7c6c1"
    decision: same-version
  - root: "event:team/message/delivered"
    previous: "2026-09-11-initial"
    after: "1ee58edb70a813415a900144e089a3982a8bd6bd9903b601fd627c9cd29dba8e"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-09-16-session-format-v4"
    after: "f2ed137e772ca0451da5726ea7c538e61ad4e92f5ad55c8bb6610ac4edfe806e"
    decision: same-version
  - root: "event:team/mode"
    previous: "2026-10-19-session-team-mode"
    after: "bc58ca1721fef9bdc767f374d237435961e6ddc1f6ed38b4ce0691928a4e9b6d"
    decision: same-version
  - root: "event:team/task"
    previous: "2026-11-02-team-task-owner-names"
    after: "b47b85155fa885186ac0d405b8d0898f379ff36136d59dbc78616adeab74145a"
    decision: same-version
  - root: "event:todo/write"
    previous: "2026-09-11-initial"
    after: "01c3e40c169e6185b6593875caa541f114f45bcc66ea3d1946673bf11445a572"
    decision: same-version
  - root: "event:tool-workflow/agent-end"
    previous: "2026-09-11-initial"
    after: "e8c1c62546c725fef44a68e5f4e2534876c4a5fd8b79a8103664858714ea1338"
    decision: same-version
  - root: "event:tool-workflow/agent-start"
    previous: "2026-09-11-initial"
    after: "af180f9d5725868b3afe923dd88abe2d9ab499813bde87fa3238266095ea8fe3"
    decision: same-version
  - root: "event:tool-workflow/run-end"
    previous: "2026-09-11-initial"
    after: "5ae592731443752caaf09a8f1285bf8709685e7a1051db14bfcb572e53bd235c"
    decision: same-version
  - root: "event:tool-workflow/run-start"
    previous: "2026-09-11-initial"
    after: "6da7ca8ef17d7129e28e43e8f026f0120a6faf419e1d8d793d33975916a5bc0a"
    decision: same-version
  - root: "event:tool/call"
    previous: "2026-09-11-initial"
    after: "f85ddfaecc494aa9a012e9b5b3d6436d223deab6fbac7d21c08f9c1054d0ad7f"
    decision: same-version
  - root: "event:tool/ptc-dispatch"
    previous: "2026-10-05-ptc-operation-metadata"
    after: "0ad3dcfbb7818490b67d4efa1143af3e31a09ff81be5df365763d3045ed7c0ce"
    decision: same-version
  - root: "event:tool/ptc-dispatch-start"
    previous: "2026-09-11-initial"
    after: "a1d29df6d87e6bc597c3f907387f135fdb6b6d0fa47262e3e2319d30d7a2febc"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-09-16-session-format-v4"
    after: "54246920abac3affc944d24d4b15c6483168f4d8d94389fb4c6dc7023fb3a6d5"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "0d8d1014589a0def26049b46f7f6dc7f10f663130730aa0cd12aa5d9c89bb5a0"
    decision: same-version
  - root: "event:turn/start"
    previous: "2026-09-11-initial"
    after: "ce34eede84c60114f431c703d1b7ddebe42b2c7c9cbfcfd64be352d0677f26e2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "417b14cf91bfd83386c27eb74ce394410214de7e7d9f0a5845d2c52154a70cb6"
    decision: same-version
  - root: "event:web/deepseek-search-llm-request"
    previous: "2026-10-13-deepseek-search-thinking"
    after: "bbdc55e8b7824a91cce81bfcb26de280a64780d4ead946581acd4862feb6b184"
    decision: same-version
  - root: "event:working-directory/change"
    previous: "2026-09-13-working-directory"
    after: "b34be88dd79e7611193b0ea50921c1a21af9f83158bb6b5f21bb4afb84a7dbe6"
    decision: same-version
  - root: "event:workspace/changes"
    previous: "2026-09-14-workspace-changes-event"
    after: "9f0cde883c1c18923e5bf393d59ac8f2eee09e56a7d7de4bc115edc8a684cb18"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records retain their meaning when these optional fields and producers are absent. Current readers preserve unknown source metadata and ordinary events. An older reader that lacks a newly required event vocabulary rejects the critical event explicitly; a reader without soft policy refuses the guarded mode. No existing generation or Session header version changes.

<a id="verification"></a>
## Verification

Eight focused owner test files passed with 88 tests, covering unknown-event admission, critical refusal, persona/director sources, tool-pair repair, permission audit reasons, and soft-policy profiles. The persistence schema and catalog were regenerated before this record.

<a id="dev-note"></a>
## Dev Note

None.
