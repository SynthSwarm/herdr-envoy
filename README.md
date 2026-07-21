# herdr-envoy

An [opencode](https://opencode.ai) plugin that lets a **coordinator** session delegate
bounded tasks to **real peer opencode agents**, each running in its own **git worktree**,
spawned as a split pane in the current [herdr](https://herdr.dev) workspace. The coordinator
monitors them asynchronously, then auto-verifies and (optionally) auto-merges their work.

Unlike a subagent, each delegate is a genuine separate agent process with its own context
window and its own branch — so parallel delegates never clobber each other, sessions survive
and can be attached, and you can interject mid-flight.

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

opencode installs npm plugins automatically at startup. That's it — no agent or skill files
are added to your config.

## What you get

The plugin is **dual-role**; it activates the right half automatically per process. It also ships
coordinator guidance so a fresh install knows *how and when* to delegate — without touching your agents:

- **`/envoy` command** — injected into your config on load (via the plugin's `config` hook). Type
  `/envoy <what to delegate>` in the TUI to kick off a delegation. Won't override an `envoy`
  command you already defined.
- **`envoy` skill** — self-provisioned to `~/.config/opencode/skills/envoy/SKILL.md`
  on first load (idempotent; never overwrites your edits). Lets the coordinator agent *proactively*
  recognize delegable work and load the how/when guidance on demand.

Both are guidance only — **no agents are installed or overridden.** You still choose which of your
own agents each delegate runs as.

### Coordinator tools (in your normal sessions)

- **`delegate`** — spawn a peer agent on a task.
  - `agent` — the name of **one of your own agents** to run as the delegate.
  - `task` — full instructions (the ephemeral brief).
  - `repo` — absolute path to the source repo.
  - `branch` — branch for the delegate's worktree, e.g. `delegate/foo`.
  - `outputContract` — `advisory` (no commits) or `code-change`.
  - `targetBranch`, `baseCommit`, `mergePolicy` (`manual` | `auto-after-checks`), `startupTimeoutSeconds`.

  Returns immediately. Completion is surfaced asynchronously (toast + a note appended to your
  prompt) at a safe point — it never interrupts your current turn.

- **`reap_delegate`** — clean up a job kept for inspection (close pane, remove worktree, clear state).

### Delegate tools (auto-available inside a delegated agent)

When a delegate boots, the plugin consumes its brief and exposes:

- **`complete`** — report the outcome (`status`, `summary`, and for code-change: `branch`,
  `baseCommit`, `headCommit`). Token-authenticated; duplicates rejected.
- **`ask`** — ask the coordinator a question and block until answered.

Your delegate agents don't need to know any of the protocol — just tell them (in their own
instructions) to do the task and call `complete` when done, or `ask` if blocked.

## How it works

- **Disk is the only transport.** Coordinator and delegate are separate processes; they
  communicate purely through per-job files in `$XDG_RUNTIME_DIR/herdr/<job-id>/`
  (`handoff.json`, `result.json`, `block.json`, `reply.json`, `heartbeat`) — never a socket.
- **File-watches are the events.** The coordinator watches each job-dir; results/blocks enqueue
  events drained between turns. A mid-run heartbeat distinguishes a working delegate from a
  crashed one.
- **Verification & merge.** Advisory results are trusted. Code-change results are machine-checked
  (clean tree, ≥1 commit, head reachable from branch, base ancestor of head, no protocol files
  committed); under `auto-after-checks` the coordinator builds a synthetic merge in an isolated
  worktree, runs declared checks, guards against target drift, and merges only the validated result.
- **Clean teardown.** Plain `git worktree add` under `<repo>/.herdr-envoy/worktrees/` (add
  `.herdr-envoy/` to your `.gitignore`); jobs auto-reap on completion — no herdr workspaces,
  no sidebar litter.

## Notes

- The delegate is launched with `opencode --agent <name> --auto` (trusted same-user peer) so it
  can write its worktree and job-dir without permission prompts.
- Add `.herdr-envoy/` to the repo's `.gitignore`.
- See [`docs/spec.md`](docs/spec.md) for the full protocol.
