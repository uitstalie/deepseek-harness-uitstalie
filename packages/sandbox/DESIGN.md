# Process-sandbox design decisions

Design records for the process-sandbox family. Each entry states the problem, the chosen rule, and the boundary the rule accepts; the subsystem reference is [`docs/subsystems/sandbox.md`](../../docs/subsystems/sandbox.md).

## Decision 1: `home-write` is the single OS user-data mode

**Problem.** `workspace-write` denies writing the thing the task must produce when it lands outside the checkout (a report next to the source tree, a download, a mailbox export), and `danger-full-access` removes every boundary. Asking a person to choose between "cannot do my task" and "no sandbox" produces either escalation fatigue or a permanently unconfined deployment.

**Rule.** `home-write` is the one confining mode between those neighbours and grants the user-data area plus the workspace:

- **Windows:** the signed-in user's home (`C:\Users\<user>`) and every fixed drive except the system drive. C: outside the user home stays read-only; the session workspace stays writable even when it is on C:.
- **Linux and macOS:** the signed-in user's home directory (`$HOME`), hidden entries included. Everything outside `$HOME` stays read-only apart from the session workspace and configured temp exceptions.

The workspace exception is deliberate: a checkout on C: or outside `$HOME` must remain writable, so `home-write` is a strict superset of `workspace-write`. It is opt-in (never a deployment default) and goes through the same `sandbox_permissions` approval ladder: it is wider than `workspace-write` and narrower than `danger-full-access`. The earlier, separately released `non-critical-write` mode was folded into this one rather than kept as an overlapping fourth mode; old mode strings and `nonCriticalRoots` load as `home-write`.

**Exclusions.** `excludePaths` (default empty) forces matching directories read-only even inside a granted root. Entries expand a leading `~` on the enforcing host, must name an existing directory, and accept a trailing `/*` or `/**` as the subtree spelling; any other glob syntax is rejected rather than silently granting more. The default is empty on purpose: the person who asked for this mode asked for the whole home directory and data drives, credential stores included, and a hidden exclusion would make the mode lie about what it grants.

**Why not the neighbours.**

- `workspace-write` cannot express "this task may write the user's data but not the system": the only knob is more roots, and on Windows a per-directory grant list is the wrong shape for "my D: drive".
- `danger-full-access` also writes C: system locations and anything outside `$HOME` — the areas where a wrong command does the most damage — and removes approval.
- A separate POSIX blocklist mode would be a different axis and would not map to Windows, so the platform rule lives in one mode.

**Accepted boundary.** Reads are unconfined in every mode, so the mode does not protect data from being read. On Windows the ACL backend stays partial (NTFS hard links alias one file object across paths; ambient `Everyone` rights are a documented residual). Non-system drives are classified lexically (`D:`…`Z:`): a removable or mapped network drive that carries a letter is treated like a fixed drive, and UNC paths are deliberately not roots (a UNC grant has no fixed identity to canonicalize). A configured root on the system drive is dropped, and junction, 8.3 and `\\?\` spellings are resolved to the target file object before the ACL check, so C: stays read-only through every alias. A Windows drive root must grant the signed-in user Modify plus Change permissions because the Low mandatory label is a SACL edit; without it the mode fails closed with the one-time `icacls` instruction. `fsAdditionalWritableRoots` (the superagent cross-workspace delivery grant) is independent and composes: the in-process fence adds both sets while process backends keep ignoring the fs-only field. Landlock cannot express a read-only hole inside a granted root, so a Landlock-only host refuses the mode when `excludePaths` is non-empty (bubblewrap is the Linux backend that can); without exclusions Landlock grants the roots directly. On Fedora, SELinux labels remain in force: the sandbox edits DACLs and never relabels, so an enforcing policy can still deny a write the DACL allows, and that denial surfaces as the operation's own error rather than a sandbox denial.

**Suggested hardening (not default).** For untrusted work, configure `excludePaths: ["~/.dsh", "~/.ssh", "~/.gnupg"]` (and `C:\Windows` on a Windows deployment that wants belt-and-braces). This is a recommendation, not a default: enabling it silently is exactly the "hidden whitelist" this decision rejects.
