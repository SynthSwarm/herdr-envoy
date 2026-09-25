# Peer Delegation: Current Contract

This document defines the bounded and interactive lifecycles and placement options.
A coordinator launches a real peer opencode process
in a separate Git worktree. Lifecycle and placement are independent: both `delegate` and
`open_session` accept `placement: pane | subworkspace`, defaulting to `pane`.
**No automatic merge or push occurs.** Bounded completion never triggers reaping. Interactive
handback is user-directed, with review, checks and commit before commit-disposition cleanup.

## Roles and Ownership

- `list_machines` discovers Local and saved SSH profiles with live OpenCode agents. Disabled
  profiles are not contacted, unavailable inventories are not empty, and IDs are machine-scoped.
- `request_agent({paneId, sessionId, task})` queues a request to an existing local OpenCode
  conversation. It validates the expected conversation, pins socket/terminal/pane/directory,
  and persists the brief and interactive control in the durable session root. It does not
  create or own a checkout, branch, pane or conversation. Both processes need the updated plugin.
- The recipient's plugin polls its inbox, serialises delivery per pane, and submits only after
  herdr idle/done and OpenCode idle checks, preserving the prior user message's persona/model.
  One request remains outstanding until explicit handback. Idle checking and legacy API
  submission are not atomic against concurrent user input. No abort or terminal input is used.
- All roles expose request-aware `read_task({jobId})` and `hand_back({jobId, ...})`. Omitting
  jobId still refers to the original startup delegation, if any. Handback is user-directed and
  reports only the request, never ownership of unrelated work. Existing-agent requests refuse
  `resume_session` and `reap_delegate`. `cancel_request({jobId})` is owner-scoped queue retirement,
  not an interrupt or retraction of already-submitted work.
- `list_sessions` exposes delivery, attempted-submission and cancellation fields for requests.
  Ambiguous submission is recovered by message read-back, never blindly replayed. If no receipt
  can be confirmed, the owner must inspect and cancel before issuing a replacement. Queue state
  survives restarts but does not retarget closed/replaced terminals or remote machines.

- The coordinator exposes `delegate`, `open_session`, `list_sessions`, `resume_session`,
  `reply_delegate` and `reap_delegate`. A peer consumes the brief identified by
  `PEER_DELEGATE_JOBDIR`. Bounded peers expose `read_task`, `complete` and `ask`. Interactive
  peers expose `read_task` and `hand_back`, with no `complete` or `ask` tools. Bounded peers also
  expose `hand_back` for separately addressed existing-agent requests, not their bounded job.
- Creation binds the job to its tool context's originating orchestrator `sessionID`, not
  whichever session is active later. Reply/reap/resume only resolve owned jobs, using the full
  job ID or a unique prefix of at least eight characters. Listing is also caller-scoped.
- `coordinator.json` persists the session ID, plugin project directory, coordinator
  `HERDR_PANE_ID`, delegate pane, repository, branch, resolved base SHA, worktree, startup timing,
  lifecycle/cleanup progress, delivered notification keys and any pending notification.
- For bounded jobs, restart recovery only accepts metadata for the same project directory and
  `HERDR_PANE_ID`. Notifications retain their original session owner. Legacy jobs without
  coordinator metadata cannot recover safely and are skipped. Recovery depends on the runtime
  files still existing; it is not a guarantee across runtime-directory removal or machine reboot.
- Interactive recovery accepts durable metadata for the same project without requiring the
  original coordinator pane. Recovery retains the original session owner. Discovering metadata
  does not grant a different orchestrator session ownership, listing access or resume rights.

## Creation and Launch

- `repo` must be absolute, `HERDR_PANE_ID` and a session owner must be present, and the named
  user-owned agent must exist in the repository's opencode scope. Agent listing accepts
  `primary`, `subagent` and `all` modes.
- `branch` must be a valid fresh branch. Existing branches are rejected. A supplied `baseCommit`
  is resolved to a commit SHA; otherwise the source repository's `HEAD` is resolved. That SHA is
  recorded and actually used by `git worktree add -b`.
- With `placement: pane`, worktrees live at `<repo>/.herdr-envoy/worktrees/<job-id>/`, not
  branch-derived directories. Add `.herdr-envoy/` to the source repository's `.gitignore`.
  The plugin uses plain Git and splits a pane in the current herdr workspace.
- With `placement: subworkspace`, use herdr's `worktree create/open --workspace` operations
  against the recorded parent workspace. Resolve that parent with
  `herdr worktree list --cwd <repo>`, including cross-repository requests, and verify its repository
  root matches the requested Git root by realpath. Never substitute the caller's repository.
  If no parent workspace exists, refuse and ask the user to open the requested repository in herdr.
  Record the returned child workspace, root pane and
  checkout rather than guessing IDs or paths. Close only the owned child workspace on cleanup.
  A missing parent is an error, not permission to select another parent or fall back to a pane.
- For bounded `delegate`, `outputContract` defaults to `advisory` (no commits). `code-change`
  requests commits on the assigned branch. `targetBranch` records the intended merge target;
  it does not trigger a merge.
- `mergePolicy` defaults to `manual`. `auto-after-checks` is explicitly rejected before job
  creation. The enum value remains only to give existing callers a clear unsupported-operation
  error, not to offer an automatic mode.
- The delegate launches as `opencode --agent <name> --auto` with a small prompt to call
  `read_task` first. Full task text stays in the disk protocol, not the shell command line.
  Delegates are trusted same-user peers, not sandboxed processes.
- The tool returns after launch setup rather than waiting for completion. Launch errors attempt
  cleanup using the same non-force cleanup path before interactive process submission. Once an
  interactive launch is attempted, errors retain the session for inspection rather than closing
  a possibly live conversation. Uncertain workspace creation also retains metadata and blocks
  cleanup until inventories prove no resources remain, as described under Explicit Cleanup.
  No placement fallback is attempted.

## Interactive Sessions

`open_session` accepts `agent`, `task`, `name`, `repo`, `branch`, optional `baseCommit`, optional
`targetBranch` and `placement` (default `pane`). The base defaults to source repo `HEAD` and is
resolved before creation. The agent, repository and fresh branch follow the creation checks
above. The name is a display label, not a unique key. Interactive sessions do not use bounded
`outputContract` or `mergePolicy` to decide when to finish or commit.

`list_sessions` returns durable interactive sessions for the current project and calling
orchestrator `sessionID`, including ID, name, placement, state and handback summary. It must not
return authentication tokens. Recovery may discover other owners' records but listing must not
expose those sessions to the caller. It also returns generation, checks, risks,
`notificationPending` and `notificationAttemptedAt` (the pending note's `attemptedAt`, if attempted).

`resume_session` accepts an optional ID (full or unique prefix of at least eight characters) and
optional instructions. An explicit ID permits paused or commit-ready work to resume independently
of pending notification delivery. Without an ID, exactly one paused owned session must exist. Never
auto-select an ambiguous display name or one of several candidates. Resume requires the same
originating orchestrator `sessionID` and continues the saved opencode conversation in the same
worktree and branch, preserving placement and the recorded parent/child relationship. Additional
instructions supplement the existing conversation, not a replacement brief in a new session.
Resume returns the previous handback summary, checks and risks and durably supersedes its queued
notice. It does not commit or reap; a new handback is required before commit or cleanup.
Discard-requested sessions cannot resume and are never implicitly resurrected.

If the saved conversation, checkout or required parent workspace is missing, refuse safely with
the missing resource identified. Do not silently create a new conversation or checkout, change
the branch, adopt another owner's session, or substitute placement. Metadata is durable, but it
is not a backup of external resources. Keep state available for inspection and repair.

Interactive peers call `read_task` first and expose `hand_back` instead of `complete`/`ask`.
`hand_back` is permitted only on an explicit user instruction, never merely because the initial
task is finished or the peer is idle. It records a disposition, summary, checks and risks:

| User instruction | Disposition | Required behaviour |
| --- | --- | --- |
| "done for now" | `pause` | Pause and preserve conversation, pane/workspace, worktree, branch and durable metadata. No commit or reap. |
| "hand this back" | `commit` | Return control to the orchestrator. The orchestrator reviews the diff, runs required checks and commits in the session worktree before reaping. No automatic merge or push. |
| "discard this" | `discard` | Mark the session discard-requested. The orchestrator must obtain separate explicit destructive confirmation before force removal. |

Handback is not a peer-side commit, merge or cleanup command. A failed review, check or commit
leaves the session available, without reaping. Pause is resumable and preserves all resources.
An active or paused interactive session cannot be ordinarily reaped. A discard request is not
itself authorisation to destroy work.

An explicit `hand_back` may transition paused work to `commit` or `discard` without a resume.
Same-disposition retries are idempotent and preserve the original report, even when the retry's
summary, checks or risks differ. Commit/discard handbacks cannot transition through `hand_back`.
Only explicit orchestrator resume can reopen commit-ready work; discard is not resumable.

## Disk Protocol

Protocol version is 1. Job IDs and completion tokens are random 128-bit hex strings. Job
directories are mode `0700`; JSON and heartbeat files are written with mode `0600`. JSON is
published through a temporary file and rename. These permissions do not isolate same-user peers.

The bounded runtime root remains `$XDG_RUNTIME_DIR/herdr/`, falling back to
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

Interactive session metadata lives outside the runtime root at
`$XDG_STATE_HOME/herdr-envoy/sessions/<id>/`, with `~/.local/state/herdr-envoy/sessions/<id>/`
as the fallback when `XDG_STATE_HOME` is unset or empty. Bounded storage and terminal completion
are unchanged. Durable records use the same private-directory, private-file and atomic-write
rules. They contain the originating orchestrator owner, project, peer conversation ID, agent,
task/name, repository, branch/base/target, placement and parent/child/pane identities, lifecycle
control, disposition, generation, handback summary/checks/risks and notification/cleanup progress.
Credentials remain private and are never included in listing responses.

Interactive control is in `session.json`. Coordinator operations and `hand_back` share a per-job exclusive lock
under `sessions/.locks/`, and reread metadata while holding it. Live owners cause a retryable
refusal. Dead process owners can be recovered; incomplete locks require manual inspection.
Resume intent and its generation are persisted before dispatch. An interrupted active resume
can be retried with an explicit job ID. Dispatch errors preserve work, and never replace a newer
handback with an older state. Launch submission is not proof the model processed a prompt.

Generation identifies the current interactive handback/resume cycle. Persist control and
generation transitions before accepting new reports, and reject stale-generation handbacks.
The saved conversation ID is the peer's identity, distinct from the originating orchestrator
`sessionID`. Resume must retain both identities. Bounded `complete` stays terminal and has no
generation-increment or reopen operation.

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
- Superseded interactive notices are durably retired before delivery, including after explicit
  resume or a newer handback. Otherwise pending delivery is reconciled before new events.
  Results take precedence over blocks and
  liveness checks. Block identity, generation and token are checked before notification.
- Startup timeout defaults to 30 seconds without a consumed handoff. It **only notifies**;
  it does not interrupt or kill the delegate, close the pane or remove runtime files.
- After consumption, a heartbeat older than 30 seconds (or the consumed-file timestamp if no
  heartbeat exists) produces a possible-stall notification, not proof that the task has crashed.
  This applies only to bounded jobs. Interactive peers have no idle heartbeat alarm; their
  startup timeout checks for the conversation binding created by `read_task`.

## Lifecycle Logs

Redacted daily JSONL logs live at `$XDG_STATE_HOME/herdr-envoy/logs/YYYY-MM-DD.jsonl`, falling
back to `~/.local/state/herdr-envoy/logs/` when `XDG_STATE_HOME` is unset or empty. Timestamps
and filenames use UTC. Records contain only `time`, `jobId`, `event`, and optional `reason`,
`generation`, `disposition` and `httpStatus`. No free-form text, paths, prompts, reports, tokens
or exception messages are logged.

Retention keeps today and the previous 29 UTC dates, independently of job cleanup. A soft
8 MiB daily append cap can be exceeded by concurrent writers. Reconciliation failure logging
is rate-limited to once per minute per job per process; reconciliation itself still runs every
2 seconds. Logging failures never block operations. Existing jobs do not receive historical
event backfill.

## Bounded Tools and Validation

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

Bounded completion leaves the pane/workspace, worktree, branch and runtime files for inspection.
`reap_delegate` is the explicit cleanup operation; it does not merge or push anything. It accepts
`discard: boolean` (default false) and an optional `confirmation` in addition to job ID and
`deleteBranch` (default false). Ordinary cleanup follows these steps:

1. Persist cleanup intent and stop normal job reconciliation.
2. Close the delegate pane, or the owned child workspace for `subworkspace`, before touching
   its checkout. Record success. Never close the parent workspace.
3. Remove the worktree using non-force `git worktree remove` and prune its registration.
   Dirty/untracked work prevents removal and is preserved.
4. If `deleteBranch` was requested (default false), use `git branch -d`, never `-D`.
   Git's merged-branch safety check can refuse deletion, retaining the unmerged branch.
5. Only after successful cleanup, remove the applicable runtime or durable session state,
   close the watcher and forget the job.

Before ordinary interactive cleanup, require a commit handback and orchestrator review, checks
and commit. Refuse ordinary reaping for active, paused or discard-requested interactive sessions.
Do not infer that a clean tree alone is proof the orchestrator performed the review and checks.

Destructive cleanup is a separate, narrow exception: only a discard-requested interactive session
may use `discard: true`, and `confirmation` must exactly equal its full job ID, not a prefix,
name, boolean or generic approval. The orchestrator must first obtain explicit user confirmation
that the session's work will be destroyed. Reject this path for bounded, active or paused jobs.
Only this confirmed path may force-remove the worktree. Branch deletion remains a separate
`deleteBranch` choice, not an implicit effect of requesting discard. Close the owned pane/child
workspace before Git cleanup and retain tracked progress if any step fails.

Errors stop cleanup and retain the tracked job and progress for retry, including after eligible
coordinator restart. A failed branch deletion may leave a job whose pane and checkout are already
removed. Preserve work and resolve the refusal rather than forcing deletion. Restart recovery
does not automatically retry reaping; call `reap_delegate` again when ready.

For uncertain creation, cleanup first reconciles herdr worktree/workspace and Git inventories,
including an older recorded parent that targeted the wrong repository. Clear uncertainty only
when inventories and disk prove no checkout, workspace or branch remains and no launch was
attempted. Surviving resources or inconclusive inventories keep cleanup refused for inspection.

## Shipped Guidance

The plugin injects `/envoy` only if no command of that name already exists. It provisions
`$XDG_CONFIG_HOME/opencode/skills/envoy/SKILL.md` (default
`~/.config/opencode/skills/envoy/SKILL.md`) only when missing. It does not install agents or
overwrite an existing skill. **Existing installed skills need manual review/update** after
guidance changes. Quit and restart opencode after installing/updating the plugin or updating
the installed skill; running sessions retain the already-loaded guidance.
