# herdr-envoy

An [opencode](https://opencode.ai) plugin that lets a **coordinator** session delegate bounded
tasks or open durable interactive sessions with **real peer opencode agents**, each in its own
**git worktree**. Either lifecycle can use a split pane or a child [herdr](https://herdr.dev)
workspace. Placement does not determine lifecycle. **There is no automatic merge or push.**
Bounded completion never triggers cleanup. Interactive handback requires explicit user direction.

Unlike a subagent, each delegate is a genuine separate agent process with its own context
window and its own branch. Separate checkouts isolate file edits, and you can inspect each
delegate's pane or interject mid-flight. Restart recovery has explicit ownership limits below.

> **Agents are yours.** This package ships only the delegation *tooling*. You choose which of
> your own opencode agents to delegate to (by name). Nothing installs or overrides your agents.

## Requirements

- opencode `>= 1.17`
- [herdr](https://herdr.dev) running, and opencode launched inside a herdr pane
  (the plugin uses `HERDR_PANE_ID` + the `herdr` CLI to split panes and boot delegates).
- `git` (delegates run in plain `git worktree` checkouts).

## Install

Add it to your opencode config `plugin` array:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["herdr-envoy"]
}
```

opencode installs npm plugins automatically at startup. No agents are installed. The plugin
provisions the coordinator skill described below if it is missing.

## What you get

The plugin is **dual-role**; it activates the right half automatically per process. It also ships
coordinator guidance so a fresh install knows *how and when* to delegate — without touching your agents:

- **`/envoy` command** — injected into your config on load (via the plugin's `config` hook). Type
   `/envoy <what to delegate or open>` in the TUI to start peer work. Won't override an `envoy`
  command you already defined.
- **`envoy` skill** — provisioned to `$XDG_CONFIG_HOME/opencode/skills/envoy/SKILL.md`
  (default `~/.config/opencode/skills/envoy/SKILL.md`) only if missing. Existing installed skills
  are not overwritten and need **manual review/update** when the shipped guidance changes.
  It lets the coordinator recognise delegable work and load guidance on demand.

Both are guidance only — **no agents are installed or overridden.** You still choose which of your
own agents each delegate runs as.

After installing/updating the plugin or manually updating an installed skill, quit and restart
opencode to load the changes.

### Coordinator tools (in your normal sessions)

**`delegate`** spawns a peer agent on a task:

| Argument | Contract |
| --- | --- |
| `agent` | Name of one of your own agents, validated in the source repo's scope. `primary`, `subagent` and `all` modes are supported. |
| `task` | Complete instructions, persisted for the delegate to read. |
| `repo` | Absolute path to the source repo. |
| `branch` | Fresh branch name, e.g. `delegate/foo`. Existing branches are rejected. |
| `outputContract` | `advisory` (default, no commits) or `code-change` (commits). |
| `targetBranch` | Optional intended merge target, not an instruction to merge. |
| `baseCommit` | Optional base revision, resolved to a commit SHA and used to create the branch/worktree. Defaults to source repo `HEAD`. |
| `mergePolicy` | Defaults to `manual`. `auto-after-checks` is explicitly rejected. The enum value remains only to give existing callers a clear error. |
| `startupTimeoutSeconds` | Defaults to 30. Timeout notifies only, without killing the delegate. |
| `placement` | `pane` (default) or `subworkspace`, independently of the bounded lifecycle. |

The call returns after launch setup, without waiting for completion. Jobs belong to the tool
context's `sessionID`. Notes target that session, with delivery deferred while it is busy.

- **`open_session`** opens a durable interactive peer, not a bounded job. Arguments are `agent`,
  `task`, `name`, `repo`, `branch`, optional `baseCommit` (defaults to source repo `HEAD`), optional
  `targetBranch`, and `placement` (`pane` by default, or `subworkspace`). Agent, repository and
  fresh-branch validation match `delegate`. The name is a display label, not a unique identity.
- **`list_sessions`** lists durable interactive sessions for this project owned by the calling
  orchestrator `sessionID`, including their IDs, state, generation, handback summary, checks, risks,
  `notificationPending` and `notificationAttemptedAt` (the pending note's `attemptedAt`). It exposes no tokens.
- **`resume_session`** resumes the same interactive conversation, worktree, branch and placement,
  with optional instructions and an optional full ID or unique prefix (at least eight characters).
  It requires the originating orchestrator `sessionID`. Omit the ID only when there is exactly
  one paused session. An explicit ID can resume paused or commit-ready work without waiting for
  notification delivery. It returns the previous handback summary, checks and risks, durably
  supersedes the old queued notice and does not commit or reap. Wait for a new handback before
  commit or cleanup. Discard-requested sessions cannot resume.
  Ambiguous names or candidates must not be auto-selected. A missing
  conversation, checkout or recorded parent workspace causes a safe refusal, not a new session,
  replacement worktree or fallback placement.
- **`reap_delegate`** explicitly closes the owned pane or child workspace before Git cleanup.
  Ordinary cleanup removes only a clean worktree without force. Optional `deleteBranch` defaults
  to false and uses `git branch -d`, not `-D`. Errors retain the job for retry. Active or paused
  interactive sessions cannot be ordinarily reaped. A commit handback must be reviewed, checked
  and committed by the orchestrator before reaping. Destructive discard requires `discard: true`
  (default false) and `confirmation` equal to the exact full job ID, after explicit destructive
  confirmation from the user in the orchestrator. Only a discard-requested interactive session
  can use this force-removal path. A delegate's discard request alone is not confirmation.

- **`reply_delegate`** — answer a delegate that called `ask` and is blocked. Unblocks it so it can
  continue. Use this when a completion note reports a delegate is *blocked* on a question.

### Delegate tools (auto-available inside a delegated agent)

Bounded delegates consume their brief and expose:

- **`read_task`** — read the persisted task and working instructions. Call this first.
- **`complete`** — report the outcome (`status`, `summary`, and for code-change: `branch`,
  `baseCommit`, `headCommit` on success). Token-authenticated; duplicate completion is rejected.
  Completion is terminal, with no reopen operation. Use a new job for follow-up work.
- **`ask`** — ask the coordinator a question and block until answered.

Interactive delegates expose **only `read_task` and `hand_back`**, not `complete` or `ask`.
They remain interactive until the user explicitly instructs handback. Finishing an initial task,
going idle or deciding the work looks done is not permission to hand back.

| User instruction | `hand_back` disposition | Orchestrator action |
| --- | --- | --- |
| "done for now" | `pause` | Preserve conversation, pane/workspace, checkout, branch and metadata for resume. |
| "hand this back" | `commit` | Review changes, run checks and commit in the session checkout **before** reaping. Do not automatically merge or push. |
| "discard this" | `discard` | Record a discard request. Ask for explicit destructive confirmation in the orchestrator before force removal. |

Handback records a summary, checks and risks. The interactive peer does not commit or clean up
merely because it hands back. Reply/reap/resume and listing remain scoped to the calling owner.
An explicit `hand_back` can move paused work to `commit` or `discard` without resuming first.
Same-disposition retries preserve the original report, even if the supplied summary differs.
Commit/discard handbacks cannot change disposition through `hand_back`; only the orchestrator
can explicitly resume commit-ready work. Discard never implicitly resurrects a session.

## How it works

- **Bounded disk protocol.** Per-job files remain in `$XDG_RUNTIME_DIR/herdr/<job-id>/` (fallback
  `<os.tmpdir()>/herdr-<uid>/herdr/<job-id>/`). They include `handoff.json`, `.consumed.json`,
  `coordinator.json`, `result.json`, `block.json`, `reply.json` and `heartbeat`.
- **Interactive durability.** Session metadata lives in
  `$XDG_STATE_HOME/herdr-envoy/sessions/<id>/`, falling back to
  `~/.local/state/herdr-envoy/sessions/<id>/`. It records owner/project, lifecycle control,
  disposition, generation, conversation ID, checkout/branch/placement and handback summary,
  checks and risks. This does not move or change bounded runtime storage.
- **Bounded ownership and recovery.** `coordinator.json` persists the originating session, project
  directory, coordinator/delegate panes, checkout and notification/cleanup progress. Filesystem
  watches are wake hints backed by 2-second reconciliation. Restart recovery requires the same
  project directory and `HERDR_PANE_ID`. Legacy jobs without coordinator metadata cannot be
  recovered safely and are skipped, not claimed by another session.
- **Interactive recovery.** Recovery is project-scoped without a coordinator-pane restriction.
  The original session owner is retained, not transferred to whichever session discovers it.
  Durable metadata is not a backup of the conversation or checkout. Missing resources are
   reported and preserved for repair, never silently replaced.
- **Uncertain operations.** A partial workspace creation or uncertain interactive launch retains
  metadata and resources for inspection instead of deleting them. Cleanup reconciles herdr/Git
  inventories, including an older wrong-parent repository, and clears creation uncertainty only
  when no checkout, workspace or branch remains and no launch was attempted. Surviving resources keep
  cleanup refused for inspection. Per-session locks shared by coordinator operations and
  `hand_back` prevent concurrent updates. An incomplete lock requires inspection; a confirmed dead owner can
  be recovered. Interrupted resumes retain their generation and can be retried with the full ID.
- **Notifications.** Pending notes have persisted stable message IDs, readback and retries.
  Delivery is deferred while the owning session is busy; toasts are best-effort. This is not an
  exactly-once delivery guarantee. A stale heartbeat indicates a possible stall, not proof of a crash.
- **Lifecycle logs.** Durable redacted logs live at
  `$XDG_STATE_HOME/herdr-envoy/logs/YYYY-MM-DD.jsonl` (fallback
  `~/.local/state/herdr-envoy/logs/`). Records contain only UTC timestamps, job IDs, event/reason
  codes, generation, disposition and HTTP status, never free text, paths or tokens. Retention is
  today plus the previous 29 UTC dates. The daily append cap is a soft 8 MiB, allowing concurrent
  overshoot. Reconciliation failure logging is limited to once per minute per job per process.
  Logging failures do not block operations, and historical events are not backfilled.
- **Validation, not approval.** Reports are checked for identity and contract. Successful
  code-change reports also get basic Git checks: clean tree, at least one commit past the assigned
  base, head reachable from the assigned branch, base ancestry and a limited protocol-artifact
  filename check. This does not prove correctness or passing project checks. Advisory content is
  trusted. Review code changes, run required checks and obtain user approval before merging.
- **Placement.** `pane` uses plain Git at `<repo>/.herdr-envoy/worktrees/<job-id>/` and a split
  pane in the current workspace. `subworkspace` uses `herdr worktree create/open --workspace`
  with the requested repository's parent, found through `herdr worktree list --cwd <repo>` and
  verified against the same realpath repository root, not the caller's workspace. If no parent
  exists, open that repository in herdr first. It records the returned child workspace and root pane.
  Cleanup closes that owned child workspace before non-force Git cleanup, not the parent.
- **Explicit cleanup.** Bounded completion keeps the pane/workspace, checkout and result for
  inspection. Interactive pause preserves everything. Launch failures attempt safe cleanup,
  retaining tracked state on failure. Neither placement grants permission to discard work.

## Development

- `npm test` builds and runs the regression suite using temporary Git repositories and mocked OpenCode/herdr boundaries.
- `npm run test:bun` exercises cleanup with Bun's real shell parser (requires Bun), which the Node shell adapter does not emulate.
- `npm run test:coverage` measures all compiled source modules, including the dormant merge helper, and enforces 95% line/function and 90% branch coverage. The suite is validated on Node.js 24, using its coverage and mock-timer APIs.
- `npm run typecheck` checks TypeScript without emitting files.
- Automated coverage does not replace a live herdr/OpenCode smoke test for pane startup and message processing.

## Notes

- The delegate is launched with `opencode --agent <name> --auto` (trusted same-user peer) so it
  can write its worktree and job-dir without permission prompts.
- Add `.herdr-envoy/` to the repo's `.gitignore`.
- See [`docs/spec.md`](docs/spec.md) for the full protocol.
