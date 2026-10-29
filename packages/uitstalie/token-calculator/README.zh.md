---
description: "DeepSeek V4 token 计算器：离线 128k 词表 byte-level BPE 分词器、受能力门控制的 count_tokens 提示词预算工具，以及给人用的 /tokens 命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-token-calculator

[English](README.md) | 中文

## Summary

`token-calculator` 离线测量 DeepSeek V4 的 token 数。它把模型的 byte-level BPE 分词器（128,000 词表、127,741 merges、1,283 added tokens）作为 gzip 资产随包携带，通过 `dafeiyu` 能力门暴露面向模型的 `count_tokens` 工具，并为人工注册 `/tokens` 命令。在把系统指令、memory 块或生成文档塞进提示词预算之前，先用它量一下。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

把这一行挂在组织者旁边；不需要配置：

```yaml
- id: token-calculator
  name: '@deepseek-ai/dsh-token-calculator'
```

agent 会看到一个工具，人也可以不经过模型直接计数：

```ts
// count_tokens({ text: 'Hello!' }) -> { tokens: 2, characters: 6, bytes: 6 }
```

```text
/tokens --bos Hello!
3 tokens (6 characters, 6 bytes, with BOS).
```

该 row 是 dafeiyu 能力（`enabledByDefault: true`，能力 id `tokens`），因此 `capabilities.tokens.enabled=false` 会把工具从所有 agent 上移除，而 `/tokens` 作为人工面仍然可用。计数是纯的、离线的：不写文件，也不调用模型。

## Understand the implementation

- `src/tokenizer.ts` 懒加载 `assets/deepseek-v4.tokenizer.json.gz`（压缩约 1.9 MiB，解析后 6.4 MiB），并在进程内缓存。该文件是 DeepSeek V4 随附的 HuggingFace `LlamaTokenizerFast` tokenizer；不依赖网络、Python 或原生绑定。
- pretokenizer 使用 tokenizer 自带的链：`Split` 一到三位数字、`Split` CJK 连续段、长的词/标点/空白正则，最后是 `ByteLevel`（不启用正则）。忽略这条链会让混合文种的计数偏差，因此它从资产读取而不是重写成一条正则。
- byte-level BPE 先按 GPT-2 字节表把 UTF-8 字节映射为符号，再应用 merge rank；added tokens（`<｜begin▁of▁sentence｜>`、对话标记、占位符）在 BPE 之前按字面匹配，每个算一个 token。
- `src/tool.ts` 是 `count_tokens` 工具：必填 `text`、可选 `addSpecialTokens`（前置 BOS），单次上限 256 KiB，避免一次调用长时间占住事件循环。
- `src/commands.ts` 是 `/tokens [--bos] <text>`，共用同一分词器与字节上限；空输入返回用法而不是计数。
- `src/index.ts` 注册能力和命令；工具由组织者按 agent 接线，命令在组合了命令注册表时注册。

## Dev Note

<details>
<summary>维护者的工作上下文——点击展开</summary>

`tests/index.spec.ts` 里的参考计数由 HuggingFace `tokenizers` 0.22.2 对同一份 `tokenizer.json` 运行得到；有意升级分词器时必须与资产一起刷新。

</details>

## Model Experience

### `count_tokens` 工具

#### 模型看到什么

一个名为 `count_tokens` 的工具，必填 `text` 字符串、可选 `addSpecialTokens` 布尔值。它回答 `N tokens (C characters, B bytes).` 描述说明计数使用 DeepSeek V4 自带分词器、默认不含 BOS、超过 256 KiB 的文本会被拒绝；超限调用返回带上限的错误，不写任何内容。

#### Token 影响

在能力启用时，工具把固定 schema 加入每次请求（远低于 200 token）。每次调用的结果是一行短文本，被测文本不会回显进上下文。

#### KV 缓存影响

schema 与描述是常量，因此在启用期间贡献稳定的前缀。结果是追加在尾部的普通工具结果；启用或停用能力才会改变前缀。

## Known Limitations and Deferred Work

- **只支持 DeepSeek V4** — 资产是这一个模型的分词器。换 provider 或分词器新版本需要自己的资产；对其他模型不是估算值。
- **不含对话模板框架** — 计数覆盖的是给定的文本本身。角色标记、工具调用脚手架、图片 token 属于部署层；需要时自己拼进去，`addSpecialTokens` 只负责 BOS。
- **同步且有限额** — 单次最多 256 KiB，运行在宿主线程上（混合文本约每 10 KiB 0.1 秒）；更大的提示词需要分段测量。
- **资产随包携带** — 压缩约 1.9 MiB，换来离线可用；更新分词器意味着替换资产并同步刷新测试里的参考计数。
- **不做成本展示** — 本包只暴露计数，不提供计价或 UI；设置页与 token 徽标仍由客户端负责。
