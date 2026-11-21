# Cookbook: repairing a Session request

English | [中文](repairing-a-session-request.zh.md)

Use this recovery procedure when a Session fails every turn with `DeepSeek Messages transport failed` and retries cannot help. Two recorded states break request construction: an image whose attachment object is gone from `$DSH_HOME/attachments`, and a recorded surface past the provider transport's payload ceiling. Both survive in the Session log, so the log itself is the repair target.

## 1. Find the sessions root

The sessions root is `$DSH_HOME/sessions`; the desktop application uses `~/.dsh/sessions`. Each Session directory holds one `session.v4.jsonl.zstd` log. Stop the turn that is failing, but leave the application running: the tool refuses a log written within the last two minutes, so an in-flight turn is never rewritten.

## 2. Run the dry run

```sh
pnpm run session:repair -- "<sessions-root>"
```

The dry run prints one line per Session that needs repair: the recorded surface before and after, the number of missing attachment blocks, the number of pruned tool results, the Session title, and the log path. Add a single Session directory instead of the whole root to inspect one Session.

## 3. Apply and restart

```sh
pnpm run session:repair -- "<sessions-root>" --apply
```

Every rewritten log first gets a `session.v4.jsonl.zstd.bak-<epoch-ms>` copy beside it, then the replacement is written atomically. The tool re-reads the result and refuses to keep a log whose event count changed. Restart the application afterwards so the running Host re-reads the Session logs from disk.

## 4. Verify

Open a repaired Session and send a message. Missing images appear as `[image unavailable: attachment <id> is missing from the attachment store]`, and pruned tool results appear as `[tool result pruned by session repair: <n> characters removed]`. The event count stays unchanged, so the Session keeps its identity, title, archive state, and workspace placement.

## 5. Tune the repair

`--attachments <root>` points at a different attachment store, `--keep-recent <count>` sets how many trailing tool results stay verbatim (default 40), and `--threshold <chars>` sets the surface above which a Session is repaired (default 700,000 characters, below the observed transport ceiling). A Session whose remaining text still exceeds the ceiling cannot be continued in place; start a new Session and summarize the old one instead. The tool cannot restore bytes that are gone: it only makes the recorded history sendable again.

## 6. Know what it is

This is an operator script, not a `dsh` subcommand: the launcher reads `dsh <name>` as `dsh --profile <name>`, so a new verb would change the meaning of existing profile names. It also repairs deleted or damaged user data, which belongs in an explicit recovery step rather than in the product's ordinary command surface.
