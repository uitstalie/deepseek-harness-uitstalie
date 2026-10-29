---
description: "DeepSeek V4 token calculator: an offline 128k-vocabulary byte-level BPE tokenizer, the gated count_tokens tool for budgeting prompts, and the /tokens command for humans."
kind: "package-reference"
---

# @deepseek-ai/dsh-token-calculator

English | [中文](README.zh.md)

## Summary

`token-calculator` measures DeepSeek V4 tokens offline. It bundles the model's byte-level BPE tokenizer (128,000 vocabulary entries, 127,741 merges, 1,283 added tokens) as a gzipped asset, exposes the model-facing `count_tokens` tool through the `dafeiyu` capability gate, and registers `/tokens` for humans. Use it before spending a prompt budget on system instructions, memory blocks, or generated documents.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Mount the row next to the organizer; it needs no configuration:

```yaml
- id: token-calculator
  name: '@deepseek-ai/dsh-token-calculator'
```

An agent then sees one tool, and a human can count without the model:

```ts
// count_tokens({ text: 'Hello!' }) -> { tokens: 2, characters: 6, bytes: 6 }
```

```text
/tokens --bos Hello!
3 tokens (6 characters, 6 bytes, with BOS).
```

The row is a dafeiyu capability (`enabledByDefault: true`, capability id `tokens`), so `capabilities.tokens.enabled=false` removes the tool from every agent while `/tokens` stays available as a human surface. Counting is pure and offline: nothing is written and no model call is made.

## Understand the implementation

- `src/tokenizer.ts` loads `assets/deepseek-v4.tokenizer.json.gz` lazily (about 1.9 MiB compressed, 6.4 MiB parsed) and caches it for the process. The file is the HuggingFace `LlamaTokenizerFast` tokenizer shipped with DeepSeek V4; no network, Python, or native binding is involved.
- The pretokenizer is the tokenizer's own chain: `Split` on runs of one to three digits, `Split` on CJK runs, the long word/punctuation/whitespace regex, then `ByteLevel` (no regex). Ignoring that chain changes counts on mixed scripts, which is why it is read from the asset rather than reimplemented as one regex.
- Byte-level BPE maps UTF-8 bytes through the GPT-2 byte table, then applies the merged-pair ranks; added tokens (`<｜begin▁of▁sentence｜>`, chat markers, placeholders) are matched literally before BPE and count as one token each.
- `src/tool.ts` is the `count_tokens` tool: required `text`, optional `addSpecialTokens` (prepends BOS), and a 256 KiB per-call cap so one call cannot block the event loop for long.
- `src/commands.ts` is `/tokens [--bos] <text>`; it shares the same tokenizer and byte cap, and reports usage instead of counting an empty input.
- `src/index.ts` registers the capability and the command; the tool is wired by the organizer per agent, while the command is registered whenever a command registry is composed.

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The reference counts in `tests/index.spec.ts` were produced with the HuggingFace `tokenizers` 0.22.2 implementation over the same `tokenizer.json`; a deliberate tokenizer update must refresh them together with the asset.

</details>

## Model Experience

### The `count_tokens` tool

#### What the model sees

One tool named `count_tokens` with a required `text` string and an optional `addSpecialTokens` boolean. It answers `N tokens (C characters, B bytes).` The description says the count uses DeepSeek V4's bundled tokenizer, that BOS is excluded by default, and that texts above 256 KiB are refused. A call that exceeds the cap fails with a message that names the cap; nothing is written.

#### Token effect

The tool adds its fixed schema to every request where the capability is enabled (well under 200 tokens). Each call's result is one short line, and the measured text is not echoed back into the context.

#### KV Cache effect

The schema and description are constants, so the tool contributes a stable prefix while it stays enabled. Results are ordinary tool results appended at the tail; enabling or disabling the capability is what changes the prefix.

## Known Limitations and Deferred Work

- **DeepSeek V4 only** — the asset is that model's tokenizer. Another provider or a future tokenizer revision needs its own asset; counts are not an estimate for other models.
- **No chat-template framing** — the count covers the text as given. Role markers, tool-call scaffolding, and image tokens are deployment concerns; add the relevant text yourself, or pass `addSpecialTokens` only for BOS.
- **Synchronous and capped** — one call measures at most 256 KiB and runs on the host thread (roughly a tenth of a second per 10 KiB of mixed text); larger prompts must be measured in pieces.
- **The asset is bundled** — the package carries about 1.9 MiB compressed so counting works offline; updating the tokenizer means replacing the asset and the reference counts in the tests.
- **No prompt-cost display** — this package exposes counting, not a pricing or UI surface; the settings pages and token badges remain the client's business.
