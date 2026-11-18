---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-remove-critical-event-marker

[English](2026-11-18-remove-critical-event-marker.md) | 中文

## 概述

从 Session 事件信封中移除已废弃的 `critical?: true` 标记，并记录本分支新增的可选 source。提交 `fix(conventions): restore event semantics and owned lifecycles` 已从信封删除该标记；当前没有任何生产代码读取或写入它，只有 v1→v2 codec/validation、v2→v3 payload 与 v3→v4 validation 仍在历史记录中接受该字段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-remove-critical-event-marker
baseline: false
changes:
  - root: "SessionEventEnvelope"
    previous: "2026-11-09-critical-event-attribution"
    after: "5776e5553ff2dfe3f5bc202dbb1e7c9f93e35a531aebb7764c23b2b6153b2ccc"
    decision: same-version
  - root: "event:agent-preset/selected"
    previous: "2026-11-09-critical-event-attribution"
    after: "a10c17474eaf2ddab7095a099e0fe3d046fc18e56c3e344fc8894c05ff9ef97b"
    decision: same-version
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-12-superagent-notice-source"
    after: "45a1f1590dad3fa232d0c8fee549f7d20d7a9ade80ec538f7080906c2cf2a63e"
    decision: same-version
  - root: "event:agent/tool-pair-repair"
    previous: "2026-11-09-critical-event-attribution"
    after: "7ab7de380dbbfd80b119c13e12f543b21bad8902bec175b64045120486463a11"
    decision: same-version
  - root: "event:approval/asked"
    previous: "2026-11-09-critical-event-attribution"
    after: "3bfeb47b58606f4661904bc723da612782214c463d01e6d61cd6d6193d7374e1"
    decision: same-version
  - root: "event:approval/decided"
    previous: "2026-11-09-critical-event-attribution"
    after: "bb1ab3d08f49a9f3b265f844cd78d5c49813062a7b34b54904b426f85d0ff6e3"
    decision: same-version
  - root: "event:approval/policy"
    previous: "2026-11-09-critical-event-attribution"
    after: "73349dced99b57f91fd4211c18cc59ba23bba84005eb208f41e77cf0c7062c5b"
    decision: same-version
  - root: "event:assistant/attempt"
    previous: "2026-11-09-critical-event-attribution"
    after: "15d5dfdd822aa35e115afd74a8982825a493880457774e6850bc1520b50875e4"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-11-09-critical-event-attribution"
    after: "1033093edd0db80ff410e00830b523405e00bb0c7684948e531ff65095799625"
    decision: same-version
  - root: "event:command/done"
    previous: "2026-11-09-critical-event-attribution"
    after: "15196447222782e773eb943c92b18316ce96b9af0f0cfddb6e57ba8274ecc5ff"
    decision: same-version
  - root: "event:command/run"
    previous: "2026-11-09-critical-event-attribution"
    after: "37184378c6439257d105c4e2022d80fc9c3a3f7c7f6ac661b00bc9f18d871006"
    decision: same-version
  - root: "event:compaction/end"
    previous: "2026-11-09-critical-event-attribution"
    after: "b0127044ab31a702bddfd785d345f5abd7a70876746e895ce443afa3e60ddf2d"
    decision: same-version
  - root: "event:compaction/prune"
    previous: "2026-11-09-critical-event-attribution"
    after: "7f7fd5a6b0064f597534b29ff62ef26e786dffccf5e14f654a7d4fcea2c35f04"
    decision: same-version
  - root: "event:compaction/start"
    previous: "2026-11-09-critical-event-attribution"
    after: "db874d463b0fdec77e9da1c4568f37cb70bd6596781eb93800db44fb8a116965"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-11-09-critical-event-attribution"
    after: "e2f9a41e0989f54ed8cee80f8db2bcf9d60a5c810dc9d45b83fa050b9dce7602"
    decision: same-version
  - root: "event:deliverables/presented"
    previous: "2026-11-09-critical-event-attribution"
    after: "13d3d180f977bf78081d487ffa0ecb75857349bcab29a5a3fb48189fca2a6176"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-12-superagent-notice-source"
    after: "c8c8bcd1c8c1c5a1d32b860d600d1d98b07d623e5d8ed19ff9d8d9ff6da3b5f7"
    decision: same-version
  - root: "event:feedback/message-delete"
    previous: "2026-11-09-critical-event-attribution"
    after: "3ee93b06f3a125850337602bcdf155d2538c43a5c944ec55b1b3c365152d6796"
    decision: same-version
  - root: "event:feedback/message-put"
    previous: "2026-11-09-critical-event-attribution"
    after: "b5086d249e8502e9ead1d39156bb8d559bde7951cac0f14ce150345b4e42a2bf"
    decision: same-version
  - root: "event:feedback/record"
    previous: "2026-11-09-critical-event-attribution"
    after: "b54940ff095c17e874c5be03815f4c2145a256cf3a1d34dae4ab2f7769dfffe8"
    decision: same-version
  - root: "event:goal/change"
    previous: "2026-11-09-critical-event-attribution"
    after: "763c8a20af487263a0080548274f7437ef4a86e0ba8769127d1ced10a72c664d"
    decision: same-version
  - root: "event:hook/invoked"
    previous: "2026-11-09-critical-event-attribution"
    after: "8a6e1ec9e8db346b0e02f027db73c07a94f067a26d40c1aef1abd09c47ce7ba0"
    decision: same-version
  - root: "event:hook/result"
    previous: "2026-11-09-critical-event-attribution"
    after: "e75916628f3f10c2d50658bd143052a46285fbf1a9a700ba54947614603d26b4"
    decision: same-version
  - root: "event:image/offload"
    previous: "2026-11-09-critical-event-attribution"
    after: "b222069eea2d768065161c1147b1f2c78c1b54328c84b3586ae5c8f91b8ed35e"
    decision: same-version
  - root: "event:job/registered"
    previous: "2026-11-09-critical-event-attribution"
    after: "f5520c1d261ca86ea03735799c311a0a9ede8babb588cf0a65422576d2ee0ad1"
    decision: same-version
  - root: "event:job/settled"
    previous: "2026-11-09-critical-event-attribution"
    after: "edd37b1e4974af648633014435572089b1e8fb71910468a0767a7e28fdd22abf"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-11-09-critical-event-attribution"
    after: "525254db03b1d1e6b74cf55aced52817568331ac1f96c0818728910b6692e336"
    decision: same-version
  - root: "event:llm/retry-started"
    previous: "2026-11-09-critical-event-attribution"
    after: "48e5c9861f16ac07e78cb7b5ae9dabdf7bb85c58baed5a51b4ad275050ea58e3"
    decision: same-version
  - root: "event:model/selection"
    previous: "2026-11-09-critical-event-attribution"
    after: "35203ba7ad5ef6f97d556b85df20ae98f04f09c65748cecdf8eefdb8b6405ffc"
    decision: same-version
  - root: "event:permission/preset"
    previous: "2026-11-09-critical-event-attribution"
    after: "c2226c57463f6d1d3f5e0ba7ca0cfcc73c50f74d3a569e739365c4c84f904bf7"
    decision: same-version
  - root: "event:plan/mode"
    previous: "2026-11-09-critical-event-attribution"
    after: "a7cf43ce7c2a4c038feed1885cd7a00d5c6ee2d90a7e0d56b46f78a3e1ca327f"
    decision: same-version
  - root: "event:request/context"
    previous: "2026-11-09-critical-event-attribution"
    after: "37cbc9cf06d494cfe5c67f078af1605eacb8e4c2c853e9e26455b73de0ee7ccf"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-11-09-critical-event-attribution"
    after: "4208123b50df5006b181481ab45fcf1cde807b88d3fd4d340090bc2e202fac41"
    decision: same-version
  - root: "event:sandbox/mode"
    previous: "2026-11-09-critical-event-attribution"
    after: "bd6efcf593852e821aaf7b53f208610640fbfb652faf2a40a3b01e96816eda38"
    decision: same-version
  - root: "event:schedule/change"
    previous: "2026-11-09-critical-event-attribution"
    after: "a0a2e5c42e1c929445ecd1cd70f49be6b66441894ec72c08e8ae332821d4a3cb"
    decision: same-version
  - root: "event:session-log-deepseek/delivery-accepted"
    previous: "2026-11-09-critical-event-attribution"
    after: "d63b8b8ffad9c02fd80c43a17df4f240c1fe8118ecca9de34f9d5871838ab5b9"
    decision: same-version
  - root: "event:session/end-seed"
    previous: "2026-11-09-critical-event-attribution"
    after: "5e6db6e24948d4a853c71cb9fabd252ad051ce93d4672c1266cf837c1c17b84e"
    decision: same-version
  - root: "event:session/title"
    previous: "2026-11-09-critical-event-attribution"
    after: "1b912703e2d64f91c99c675b8f805b01076c8325b905c1218ad81ef0b24909d5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-12-superagent-notice-source"
    after: "0934ed3e6c02f0005b26718cf88ee2c915909fa911e9d4256fd295bfa7620c42"
    decision: same-version
  - root: "event:step/end"
    previous: "2026-11-09-critical-event-attribution"
    after: "e0a787e6ec76c7c94fecbc501b489164ab0293db05bc947914077ad01e674f05"
    decision: same-version
  - root: "event:step/start"
    previous: "2026-11-09-critical-event-attribution"
    after: "4513e088d43e6c68425be30451b9f961cc264fe7318ca62681c41d4d78615986"
    decision: same-version
  - root: "event:subagent/catalog"
    previous: "2026-11-09-critical-event-attribution"
    after: "d49164d37eab0f0f70fa787c65d887abbea869c010ccb103d717fab3519c3a41"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-11-09-critical-event-attribution"
    after: "b79ada42962cad0190a9d465805260567621fa3a4abd757eb31e6016b52d5ab5"
    decision: same-version
  - root: "event:subagent/model-selection-policy"
    previous: "2026-11-09-critical-event-attribution"
    after: "a6567ccb2e530606b775371eb4fa31468d72084339968e8b0440a516a23b39dc"
    decision: same-version
  - root: "event:system/message"
    previous: "2026-11-09-critical-event-attribution"
    after: "69081694be231d56fd9580ba14645fd5e35373202605d5c5c841a9435b5fa3b1"
    decision: same-version
  - root: "event:team/member"
    previous: "2026-11-09-critical-event-attribution"
    after: "4fb59762612c3e3ac3a3bd4f84c9c148d3c3893bd422ba2b201cc039fabd49bc"
    decision: same-version
  - root: "event:team/message/delivered"
    previous: "2026-11-09-critical-event-attribution"
    after: "48f9c19417a1abbedfa59f4667bba36b93ac2db407adf5e84cb3ba0de30942cb"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-11-09-critical-event-attribution"
    after: "21fb6a90d5068f6a0003b7ab316ed2f56342477146a65c00db0f13c4d8df667d"
    decision: same-version
  - root: "event:team/mode"
    previous: "2026-11-09-critical-event-attribution"
    after: "920d87e22b7409bcc7224f8b1dc7f5101c33574c75627c65baab12b85cc96e75"
    decision: same-version
  - root: "event:team/task"
    previous: "2026-11-09-critical-event-attribution"
    after: "bca0f9cb63d8620b6954bb045b07bb07cb557513a7f0e2e177f5e87f704e7ba7"
    decision: same-version
  - root: "event:todo/write"
    previous: "2026-11-09-critical-event-attribution"
    after: "b978cff734e62143eb56c9125423ec275405eda969802d42aaf73ecb987d3b26"
    decision: same-version
  - root: "event:tool-workflow/agent-end"
    previous: "2026-11-09-critical-event-attribution"
    after: "babf9ee4d1af62bf6c3a8103737f7a5e4e78ce179be835ce05a38803e15884b7"
    decision: same-version
  - root: "event:tool-workflow/agent-start"
    previous: "2026-11-09-critical-event-attribution"
    after: "5f26a6c20b37632f8f57729d171c671def4683d994ac6257a8dffcd855101627"
    decision: same-version
  - root: "event:tool-workflow/run-end"
    previous: "2026-11-09-critical-event-attribution"
    after: "42e0916e0dda5f6d1e7bb05d8514717147c036a79c9f36085683469516c1fd3f"
    decision: same-version
  - root: "event:tool-workflow/run-start"
    previous: "2026-11-09-critical-event-attribution"
    after: "c1f9e0405de6d18cabb9ee70782a027f9bbdc57e5abec9dcccdd56119e2e9058"
    decision: same-version
  - root: "event:tool/call"
    previous: "2026-11-09-critical-event-attribution"
    after: "3b1be838223869fe0a08210db85bf773796ed3f2373ac16555dff227cade0c48"
    decision: same-version
  - root: "event:tool/ptc-dispatch"
    previous: "2026-11-09-critical-event-attribution"
    after: "d66e11dddf5dfa3c71547e2cbd7b0608824cd8d6243fc16f532017ff28e8fba5"
    decision: same-version
  - root: "event:tool/ptc-dispatch-start"
    previous: "2026-11-09-critical-event-attribution"
    after: "ec38b5949af8eacaf00df002f4acbe344f934f8a061e9cdc65a52a48e5f6dd93"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-11-09-critical-event-attribution"
    after: "7c9f44e90a0058f4cc532ae20dad0c10afa6eba22e70a6c79fc79490bad64397"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-11-09-critical-event-attribution"
    after: "0f8512903d94f57a4748fa1a2092e64342856796684e6b8343db685b192745ce"
    decision: same-version
  - root: "event:turn/start"
    previous: "2026-11-09-critical-event-attribution"
    after: "aa0957eca50aeb28bcd2e6930b95809926edacb550c8c340ba526ba6b861b3d8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-12-superagent-notice-source"
    after: "a9730e31fb8a8c0ed127ae655b4bb2d63b1d118fc15be13d996c13ad87e7f442"
    decision: same-version
  - root: "event:web/deepseek-search-llm-request"
    previous: "2026-11-09-critical-event-attribution"
    after: "0c556c9b9f2a96238a6b9bbb99e748206cbff2ed6203041c9571f04ae5802f52"
    decision: same-version
  - root: "event:working-directory/change"
    previous: "2026-11-09-critical-event-attribution"
    after: "124aa62078ca3311353b39cc3bf6c75da281338be6bbf672f8b361d828cddca3"
    decision: same-version
  - root: "event:workspace/changes"
    previous: "2026-11-09-critical-event-attribution"
    after: "e308ccf867a5398e316e0af8cb6ce238a8d33a63b9b384c8250a686786285f72"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

携带 `critical` 的旧会话仍可读取：旧格式层接受该字段，当前读取方忽略这个未知信封属性；由于没有生产读取方依赖它，不会丢失含义。新记录不再写入该字段，认识它的旧读取方把缺失视为普通情况。同一条记录还确认了可选的 `memory`、`timeline-priority` 消息 source、可选的 permission/preset source，以及收窄后的 sandbox mode source：它们都是可选归属信息，读取时保留未知 source kind 及其 JSON 元数据，缺少这些字段的消息保持原有形态。

<a id="verification"></a>
## 验证

带本条终止记录运行 `pnpm run verify-persistence-changes` 退出 0。v1→v2、v2→v3、v3→v4 各格式套件覆盖读取仍含旧字段的日志，`pnpm run doc-sync` 报告 43 passed、0 failed、0 skipped。

<a id="dev-note"></a>
## 开发备注

无。
