# herdr-envoy

An [opencode](https://opencode.ai) plugin that lets a **coordinator** session delegate
bounded tasks to **real peer opencode agents**, each running in its own **git worktree**,
spawned as a split pane in the current [herdr](https://herdr.dev) workspace. The coordinator
monitors them asynchronously and validates their reports. **It does not automatically merge
or reap completed jobs.** Code changes require review, checks and user approval before merging.

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
  `/envoy <what to delegate>` in the TUI to kick off a delegation. Won't override an `envoy`
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
| `agent` | Name of one of your own agents, validated in the source repo's scope. |
| `task` | Complete instructions, persisted for the delegate to read. |
| `repo` | Absolute path to the source repo. |
| `branch` | Fresh branch name, e.g. `delegate/foo`. Existing branches are rejected. |
| `outputContract` | `advisory` (default, no commits) or `code-change` (commits). |
| `targetBranch` | Optional intended merge target, not an instruction to merge. |
| `baseCommit` | Optional base revision, resolved to a commit SHA and used to create the branch/worktree. Defaults to source repo `HEAD`. |
| `mergePolicy` | Defaults to `manual`. `auto-after-checks` is explicitly rejected. The enum value remains only to give existing callers a clear error. |
| `startupTimeoutSeconds` | Defaults to 30. Timeout notifies only, without killing the delegate. |

The call returns after launch setup, without waiting for completion. Jobs belong to the tool
context's `sessionID`. Notes target that session, with delivery deferred while it is busy.

- **`reap_delegate`** — explicitly close the pane, then remove the clean worktree without force
  and clear runtime state. Errors retain the tracked job for retry. Optional `deleteBranch`
  defaults to false and uses `git branch -d`, not `-D`; an unmerged branch is retained if Git
  refuses deletion. Reply/reap tools only resolve jobs owned by the calling session.

- **`reply_delegate`** — answer a delegate that called `ask` and is blocked. Unblocks it so it can
  continue. Use this when a completion note reports a delegate is *blocked* on a question.

### Delegate tools (auto-available inside a delegated agent)

When a delegate boots, the plugin consumes its brief and exposes:

- **`read_task`** — read the persisted task and working instructions. Call this first.
- **`complete`** — report the outcome (`status`, `summary`, and for code-change: `branch`,
  `baseCommit`, `headCommit` on success). Token-authenticated; duplicate completion is rejected.
  Completion is terminal, with no reopen operation. Use a new job for follow-up work.
- **`ask`** — ask the coordinator a question and block until answered.

Your delegate agents don't need to know any of the protocol — just tell them (in their own
instructions) to do the task and call `complete` when done, or `ask` if blocked.

## How it works

- **Disk protocol.** Per-job files live in `$XDG_RUNTIME_DIR/herdr/<job-id>/` (fallback
  `<os.tmpdir()>/herdr-<uid>/herdr/<job-id>/`). They include `handoff.json`, `.consumed.json`,
  `coordinator.json`, `result.json`, `block.json`, `reply.json` and `heartbeat`.
- **Ownership and recovery.** `coordinator.json` persists the originating session, project
  directory, coordinator/delegate panes, checkout and notification/cleanup progress. Filesystem
  watches are wake hints backed by 2-second reconciliation. Restart recovery requires the same
  project directory and `HERDR_PANE_ID`. Legacy jobs without coordinator metadata cannot be
  recovered safely and are skipped, not claimed by another session.
- **Notifications.** Pending notes have persisted stable message IDs, readback and retries.
  Delivery is deferred while the owning session is busy; toasts are best-effort. This is not an
  exactly-once delivery guarantee. A stale heartbeat indicates a possible stall, not proof of a crash.
- **Validation, not approval.** Reports are checked for identity and contract. Successful
  code-change reports also get basic Git checks: clean tree, at least one commit past the assigned
  base, head reachable from the assigned branch, base ancestry and a limited protocol-artifact
  filename check. This does not prove correctness or passing project checks. Advisory content is
  trusted. Review code changes, run required checks and obtain user approval before merging.
- **Explicit cleanup.** Each fresh branch starts at the resolved base SHA in
  `<repo>/.herdr-envoy/worktrees/<job-id>/`, using plain Git rather than a new herdr workspace.
  Completion keeps the pane, worktree and result available for inspection. There is no automatic
  merge or completion-triggered reap. Launch failures attempt cleanup; failures remain tracked.

## Development

- `npm test` builds and runs the regression suite using temporary Git repositories and mocked OpenCode/herdr boundaries.
- `npm run test:coverage` measures all compiled source modules, including the dormant merge helper, and enforces 95% line/function and 90% branch coverage. The suite is validated on Node.js 24, using its coverage and mock-timer APIs.
- `npm run typecheck` checks TypeScript without emitting files.
- Automated coverage does not replace a live herdr/OpenCode smoke test for pane startup and message processing.

## Notes

- The delegate is launched with `opencode --agent <name> --auto` (trusted same-user peer) so it
  can write its worktree and job-dir without permission prompts.
- Add `.herdr-envoy/` to the repo's `.gitignore`.
- See [`docs/spec.md`](docs/spec.md) for the full protocol.
