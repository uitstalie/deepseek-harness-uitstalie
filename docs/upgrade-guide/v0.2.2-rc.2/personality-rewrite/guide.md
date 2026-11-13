---
kind: upgrade-guide
description: "The personality capability is rewritten: the workspace overlay, auto-learning, proposals, history, command, settings UI and config keys are removed; the profile uses a new global format and two tools."
---

# Rewrite the personality capability around global files

English | [中文](guide.zh.md)

## Change

`dsh-personality` now reads only three files under `<DSH_HOME>/personality/`: `PERSONALITY.md`, `OUTPUT_STYLE.yaml`, and `WRITING_RULES.yaml`. The profile format, tools, and exported package surface changed. Removed:

- tools `personality_learn` and `personality_propose`; `/personality` and all its subcommands; the proposal Remote;
- the workspace overlay (`.dsh/memory/PERSONALITY.md` is never read or written), turn-end automatic learning, the file watcher, and the history/revert runtime;
- `PERSONALITY.history.jsonl` creation and reuse; the old file is left untouched;
- package exports `./remote`, `./types`, `./typert`, and `./locale/*.json`; the `ui-personality` settings page and package;
- the `Config` schema and its `workspaceOverlay`, `maxBytes`, `autoLearn`, and `historyLimit` keys. The Loader does not reject unknown keys, so old rows still load and the values are ignored.

New model surface: read-only `personality_analyze` on every agent, and root-only `personality_apply` with the required literal `confirm: true`. Three prompt sections replace the old one: profile at 100, output style at 690, writing rules at 695.

## Migration

1. Remove the `ui-personality` row from profile patches and drop the deleted config keys from the `personality` row; no replacement keys exist.
2. Start the harness once. The first activation moves a pre-rewrite `PERSONALITY.md` to `legacy/PERSONALITY.<YYYYMMDDTHHMMSSZ>.md` and seeds `OUTPUT_STYLE.yaml` and an empty `WRITING_RULES.yaml`. A failed move leaves the old file in place, creates no new profile, and blocks writes; fix the filesystem and restart.
3. Do not edit `legacy/` or expect it to be parsed. `PERSONALITY.history.jsonl` and `PERSONALITY.proposals.jsonl` stay as historical evidence; this release does not migrate or delete them.
4. Author `PERSONALITY.md` in the new format, or let `personality_apply` create it:

   ```markdown
   ---
   version: 1
   updatedAt: 2026-11-13T00:00:00.000Z
   entries:
     - id: understanding.role-prefix
       kind: understanding
       text: The prefix names the executor; the rest is the task.
   ---
   ```

   Ids are `<kind>.<lower-kebab-name>`; `identity` entries are manual-only. Each entry is at most 400 characters and the document at most 32 KiB.
5. Edit `OUTPUT_STYLE.yaml` and `WRITING_RULES.yaml` on disk. This release registers no rules tool, so `write_like_human` is unavailable.
6. Replace removed calls: `personality_learn` and `personality_propose` become `personality_analyze` followed by an explicit `personality_apply`; proposal review and `/personality` have no replacement; identity changes are manual file edits.

7. Confirm the migration: the capability status lists `personality`; the assembled prompt contains `personality`, `personality:output-style`, and `personality:writing-rules` at orders 100, 690, and 695; `personality_analyze` leaves `PERSONALITY.md` unchanged and only `personality_apply` with `confirm: true` writes; a workspace `.dsh/memory/PERSONALITY.md` logs one warning and is not read or written; the settings page shows no personality section, and the old `legacy/` file still exists.
