# Triaging the ledger

Triage is the cheapest way to keep a ledger honest. Work from the facts in the store, never
from memory.

## What to look for

1. `/jira list --all` — everything, including closed, so you can see the shape of the work.
2. Issues with no assignee and an old `updated_at`: either somebody should own it, or it
   should be closed with a resolution.
3. Duplicates: two issues describing one thing. Link them (`action: "link"`, types
   `related` / `duplicate` / `is_blocked_by` / `parent`) rather than deleting either.
4. Blocked work: `is_blocked_by` links where the blocker is closed mean the block is gone.
5. Stale priorities: a `S1` that has been open for weeks is either not really `S1`, or it
   needs the attention it claims.

## How to close something

Do not close work to tidy the board. Closing means the question is answered:

* `fixed` — the thing works now. Say how you verified it, in a comment.
* `invalid` — it was never a problem, or not ours. Say why.
* `limitation` — real, understood, and we are not going to fix it. **Always** add a
  `resolution_note` naming the limit; this is the one resolution the store forces you to
  explain.
* `abandoned` — we stopped caring. Say what changed.

Reopening is allowed and cheap: it clears the conclusion and keeps it as a comment, so a
wrongly closed issue costs a comment, not an apology.

## Tags are vocabulary, not free text

A tag has to be registered before an issue can use it: `UNKNOWN_TAG` lists what exists (`registered`)
and tells you how to create one when nothing does (`jira_issue { action: "tag_create", … }` or
`jira tag-create <name> --description <why>`). Create a tag when triage actually needs a new axis —
not per issue.
