# Peer Delegation: Current Contract

This document describes the current plugin, not the historical trial harness. A coordinator
launches a real peer opencode process in a separate Git worktree and herdr pane, monitors its
report and leaves the deliverable for review. **No automatic merge or completion-triggered
reap occurs.** Code changes require review, checks and user approval before merging.

## Roles and Ownership

- Without `PEER_DELEGATE_JOBDIR`, the plugin exposes `delegate`, `reply_delegate` and
  `reap_delegate`. With that marker, it consumes the job brief and exposes `read_task`,
  `complete` and `ask` instead.
- `delegate` binds the job to its tool context's `sessionID`, not whichever session is active
  later. Reply/reap tools resolve only jobs belonging to their calling session, using the full
  job ID or a unique prefix of at least eight characters.
- `coordinator.json` persists the session ID, plugin project directory, coordinator
  `HERDR_PANE_ID`, delegate pane, repository, branch, resolved base SHA, worktree, startup timing,
  lifecycle/cleanup progress, delivered notification keys and any pending notification.
- On restart, recovery only accepts metadata for the same project directory and
  `HERDR_PANE_ID`. Notifications retain their original session owner. Legacy jobs without
  coordinator metadata cannot recover safely and are skipped. Recovery depends on the runtime
  files still existing; it is not a guarantee across runtime-directory removal or machine reboot.

## Creation and Launch

- `repo` must be absolute, `HERDR_PANE_ID` and a session owner must be present, and the named
  user-owned agent must exist in the repository's opencode scope.
- `branch` must be a valid fresh branch. Existing branches are rejected. A supplied `baseCommit`
  is resolved to a commit SHA; otherwise the source repository's `HEAD` is resolved. That SHA is
  recorded and actually used by `git worktree add -b`.
- Worktrees live at `<repo>/.herdr-envoy/worktrees/<job-id>/`, not branch-derived directories.
  Add `.herdr-envoy/` to the source repository's `.gitignore`. The plugin uses plain Git and
  splits a pane in the current herdr workspace, rather than creating a herdr workspace per job.
- `outputContract` defaults to `advisory` (no commits). `code-change` requests commits on the
  assigned branch. `targetBranch` records the intended merge target; it does not trigger a merge.
- `mergePolicy` defaults to `manual`. `auto-after-checks` is explicitly rejected before job
  creation. The enum value remains only to give existing callers a clear unsupported-operation
  error, not to offer an automatic mode.
- The delegate launches as `opencode --agent <name> --auto` with a small prompt to call
  `read_task` first. Full task text stays in the disk protocol, not the shell command line.
  Delegates are trusted same-user peers, not sandboxed processes.
- The tool returns after launch setup rather than waiting for completion. Launch errors attempt
  cleanup using the same non-force cleanup path; cleanup failures leave the job tracked.

## Disk Protocol

Protocol version is 1. Job IDs and completion tokens are random 128-bit hex strings. Job
directories are mode `0700`; JSON and heartbeat files are written with mode `0600`. JSON is
published through a temporary file and rename. These permissions do not isolate same-user peers.

Runtime root is `$XDG_RUNTIME_DIR/herdr/`, falling back to
`<os.tmpdir()>/herdr-<uid>/herdr/`. Each job has its own `<job-id>/` directory outside Git:

| File | Purpose |
| --- | --- |
| `handoff.json` | Initial identity, token, agent, task, output contract, base, target, manual merge policy, checks metadata and startup timeout. |
| `.consumed.json` | Persisted identity/authentication and task snapshot, written before unlinking the handoff. Allows delegate reload to recover the brief. |
| `coordinator.json` | Coordinator ownership and notification/cleanup state. Authentication stays in `.consumed.json`, not this metadata. |
| `result.json` | Terminal delegate report. Retained until explicit cleanup, not deleted after notification. |
| `block.json` | Question, job identity, generation, token and timestamp. |
| `reply.json` | Answer associated with job ID and generation. |
| `heartbeat` | Liveness hint updated about every 10 seconds until a result exists or the delegate stops. |

Job files carry the cross-process protocol. The coordinator uses herdr CLI for pane lifecycle
and the opencode client API to notify the owning session. No separate peer socket is used.

## Reconciliation and Notifications

- Filesystem watches are wake hints, not an authoritative event queue. The coordinator rescans
  canonical files on a watch event, on recovery and every 2 seconds. Missed watch events or watch
  failures therefore do not by themselves prevent discovery. Concurrent scans of a job are serialised.
- A pending note is persisted with a stable message ID before submission. The coordinator reads
  back that ID, submits to the original session with `promptAsync` if needed, and verifies the
  matching text before recording delivery. Failed or uncertain delivery is retried, with at least
  10 seconds between submission attempts.
- Submission is deferred when the owning session is reported busy. The note is not redirected
  to another session or inserted into an unsubmitted TUI prompt. Toasts are best-effort only.
  Stable IDs, readback and retries do **not** constitute an exactly-once delivery guarantee.
- Pending delivery is reconciled before new events. Results take precedence over blocks and
  liveness checks. Block identity, generation and token are checked before notification.
- Startup timeout defaults to 30 seconds without a consumed handoff. It **only notifies**;
  it does not interrupt or kill the delegate, close the pane or remove runtime files.
- After consumption, a heartbeat older than 30 seconds (or the consumed-file timestamp if no
  heartbeat exists) produces a possible-stall notification, not proof that the task has crashed.

## Delegate Tools and Validation

`read_task` returns the persisted brief and working instructions. `ask` writes a block and polls
for a matching reply every 2 seconds, for up to 10 minutes, with abort support. On a matching
reply it removes the reply and block files and returns the answer. `reply_delegate` writes that
answer for an owned job.

`complete` publishes `status` (`success` or `failure`), summary, evidence, risks and follow-ups,
with identity, generation, completion token and output contract from the consumed snapshot.
Successful code-change reports must include `branch`, `baseCommit` and `headCommit`. An existing
result for the same generation rejects duplicate completion. Completion is terminal: there is
no reopen or generation-increment operation. Follow-up work requires a new job.

Before delivering a result, the coordinator validates basic report shape, protocol version,
job identity, generation, completion token and output contract. Successful code-change reports
also require:

- The assigned branch and resolved base SHA match the report.
- The delegate worktree is clean according to `git status --porcelain`.
- At least one commit exists between the base and reported head.
- The reported head is reachable from the assigned branch, and the base is its ancestor.
- The commit-range object listing passes the current limited filename check for `handoff.json`,
  `result.json` and paths ending in `/complete`. This is not a comprehensive artifact audit.

Advisory content and failure reports receive no Git checks. Identity and basic Git validation
do not establish code correctness, prove reported head equals branch tip, or prove project checks
passed. Check fields in the protocol are metadata, not an automated checks gate; the exposed
delegate tool does not accept a checks list, and `complete` writes an empty `checksPerformed`.
The coordinator does not invoke the retained synthetic-merge helper. Review the deliverable,
run required checks and obtain explicit user approval before any code merge.

## Explicit Cleanup

Completion leaves the pane, worktree, branch and runtime files available for inspection.
`reap_delegate` is the explicit cleanup operation; it does not merge anything:

1. Persist cleanup intent and stop normal job reconciliation.
2. Close the delegate pane before touching its checkout, recording the successful step.
3. Remove the worktree using non-force `git worktree remove` and prune its registration.
   Dirty/untracked work prevents removal and is preserved.
4. If `deleteBranch` was requested (default false), use `git branch -d`, never `-D`.
   Git's merged-branch safety check can refuse deletion, retaining the unmerged branch.
5. Only after successful cleanup, remove runtime state, close the watcher and forget the job.

Errors stop cleanup and retain the tracked job and progress for retry, including after eligible
coordinator restart. A failed branch deletion may leave a job whose pane and checkout are already
removed. Preserve work and resolve the refusal rather than forcing deletion. Restart recovery
does not automatically retry reaping; call `reap_delegate` again when ready.

## Shipped Guidance

The plugin injects `/envoy` only if no command of that name already exists. It provisions
`$XDG_CONFIG_HOME/opencode/skills/envoy/SKILL.md` (default
`~/.config/opencode/skills/envoy/SKILL.md`) only when missing. It does not install agents or
overwrite an existing skill. **Existing installed skills need manual review/update** after
guidance changes. Quit and restart opencode after installing/updating the plugin or updating
the installed skill; running sessions retain the already-loaded guidance.
