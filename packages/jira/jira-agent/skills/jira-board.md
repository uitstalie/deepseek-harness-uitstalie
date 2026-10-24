# Seeing the state of play

`jira_issue` reads and writes **one** issue at a time; the board is a view over all of them
and is served by the `/jira` command and the `jira` CLI.

* `/jira board` — issues grouped by status, in the order the store's `config.md` declares.
* `/jira list [--status S] [--project P] [--tag T] [--all]` — the same data as lines.
* `jira board --json` (CLI) — the same, for a script or another agent.

Closed issues are hidden unless you ask for them: a board that shows finished work cannot
show what is left.

## Reading a board

* A column that keeps growing is a bottleneck, not progress.
* An issue with no assignee is nobody's work.
* A `conflicted` issue needs a human: git could not merge two machines' edits.
* Old `updated_at` with a non-closed status is a candidate for triage (`/jira list --all`).

Do not build a private board in a file: the store is the single source of truth, and a
second view of it will disagree with the first one.