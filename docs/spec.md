# Peer-Delegation Protocol — v0.1 (lean)

Controller (main opencode) delegates a task to a **real peer agent** running in its own
git worktree + branch, spawned as a split pane in the current herdr workspace, then monitors
and merges it. Chosen over subagents for: own worktree/branch (no clobber), sessions that
survive/resume/human-attach, and mid-flight interjection.

Derived from the grilling-agent trial spec (GPT-5.6 Sol), reduced to a lean subset.

## Decisions locked
- **Protocol weight:** lean subset — **no `ready.json` handshake**; readiness comes from herdr
  `agent wait --status idle`. One-time tokens are completion-only (optional elsewhere).
- **Merge default:** `auto-after-checks` — controller auto-merges when declared checks pass
  (still surfaces the diff summary; per-job `manual` override supported).

## 1. Runtime layout (outside Git)
```
${XDG_RUNTIME_DIR:-/tmp/herdr-$UID}/herdr/<job-id>/
├── handoff.json     # controller writes; delegate reads then unlinks (ephemeral brief)
├── result.json      # delegate publishes via the completion command
└── complete         # controller-provided completion command (absolute path)
```
- dir `0700`, files `0600`, `job-id` cryptographically unguessable
- same-user delegates are trusted peers
- **no protocol artifact may ever enter the repository**

## 2. handoff.json (ephemeral job contract)
```json
{
  "protocolVersion": 1,
  "jobId": "<unguessable-id>",
  "generation": 1,
  "completionToken": "<one-time-token>",
  "agent": "<exact-opencode-agent-name>",
  "task": "<complete task instructions>",
  "outputContract": "advisory | code-change",
  "targetBranch": "<branch>",
  "baseCommit": "<sha>",
  "mergePolicy": "manual | auto-after-checks",
  "checks": [{ "command": "<exact command>", "expectedExitCode": 0 }],
  "startupTimeoutSeconds": 30,
  "completionCommand": "<absolute-path-to-complete>"
}
```
Before launch the controller validates only that the requested agent name exists. Launch/config
failures fail closed, no fallback.

## 3. Delegate startup (lean — no ready receipt)
Delegate must: read + validate `handoff.json`, retain instructions in context, **unlink
`handoff.json`**, and know nothing about herdr/pane management.

Readiness is observed by the **controller via herdr**: `herdr agent wait <pane> --status idle`
(and status polling). Startup timeout (default 30s) → stop the agent process, delete runtime
artifacts, **leave the pane open**.

## 4. Completion contract
Delegate invokes the controller-provided `complete` command (must not handcraft `result.json`).
```json
{
  "protocolVersion": 1,
  "jobId": "<job-id>",
  "generation": 1,
  "completionToken": "<completion-token>",
  "origin": "delegate",
  "status": "success | failure",
  "outputContract": "advisory | code-change",
  "summary": "<concise human-readable summary>",
  "evidence": ["<reference or observation>"],
  "checksPerformed": [{ "command": "<command>", "exitCode": 0, "summary": "<result>" }],
  "risks": ["<remaining risk>"],
  "followUps": ["<optional follow-up>"],
  "branch": "<required for code-change>",
  "baseCommit": "<required for code-change>",
  "headCommit": "<required for code-change>"
}
```
`complete` must: authenticate jobId + generation + one-time token, validate schema, reject an
already-completed generation, atomically publish `result.json` (temp-file + rename), return a
clear success/failure diagnostic.

## 5. Code-change invariants
A successful `code-change` completion requires: clean worktree; ≥1 task commit; `headCommit`
reachable from the assigned branch; commit range descends from the declared base; no completion/
handoff artifacts committed. Multiple commits allowed. `advisory` requires no commit.

## 6. Controller acknowledgement
Parse + validate `result.json`; verify identity/generation/token/output-contract; for code
changes independently verify §5 invariants; display a concise chat summary; **delete `result.json`**
immediately after. The chat summary is the only retained record beyond Git commits. If the
delegate crashes before completion, controller reports an `origin: controller` infra-failure
summary — never fabricates a delegate result.

## 7. Merge flow (default: auto-after-checks)
For code changes:
1. Controller reviews the unrestricted diff (surfaces summary to user).
2. Build a synthetic merge against latest target HEAD in an isolated integration worktree.
3. Run every declared check; validate expected outcomes.
4. If target HEAD drifted since the merge SHA, rebuild + rerun (drift retry ≤ 2).
5. After two retries → require manual merge.
6. Merge only the exact synthetic result that passed checks.

`auto-after-checks`: controller merges automatically once checks pass (diff summary still shown).
`manual` (per-job override): always requires explicit user authorization.

## 8. Pane / process lifecycle
- Delegate has no herdr awareness.
- Completion does not stop the agent; acknowledgement does not close the pane; merge does not
  close the pane.
- Pane closes only via explicit user exit or a user command to the controller.
- Automatic process stop allowed only for startup timeout or explicit cancellation.
- Resource-limit enforcement is out of scope.

## 9. Reopening
First valid completion is terminal. Reopen by: incrementing `generation`, issuing a new one-time
completion token, rejecting receipts/results from previous generations, keeping the same pane and
job identity.

## 10. Trial acceptance criteria (manual) — ✅ CLEARED
Trial passed live (advisory + code-change) with real delegate agents:
- ✅ Exact specialized agent launches (`opencode --agent <name>`).
- ✅ Handoff is consumed and deleted by the delegate.
- ✅ Readiness observed via herdr `agent wait --status idle`.
- ✅ Completion command publishes a valid `result.json`.
- ✅ Duplicate completion is rejected; bad token rejected; forged code-change (no commit) rejected.
- ✅ Controller displays the summary and deletes the result.
- ✅ Code-change invariants pass (§5) against a real commit.
- ✅ Synthetic merge + checks pass (auto-after-checks, §7).
- ✅ No runtime artifact appears in Git.
- ✅ Pane remains open after completion.

The manual harness (`research/harness/`, bash+jq+git) is the **executable spec** — the plugin
reimplements this behavior in TS. The gate is cleared: plugin work may begin.

## 11. Findings from the manual trial
1. **Advisory results are trusted (accepted).** The controller machine-checks code-change
   invariants (§5) but not advisory summaries. This is an accepted trade-off: advisory delegates
   are trusted same-user peers; no verification gate is required for advisory output.
2. **`update-ref` staleness (must handle).** Updating a branch that is checked out in a live
   worktree leaves that worktree's files stale. The controller must merge into a target it does
   **not** occupy, or resync (`git reset --hard`) after. `hd-merge` warns; the plugin must avoid
   the situation structurally (dedicated integration/target worktree, never the coordinator's own).

## 11a. Findings from the live plugin run (§12 wiring)
3. **Plugin loader quirks (resolved).** opencode discovers a plugin only if a `Plugin` function is
   defined/called in the loaded file (a bare `export { X } from …` re-export is NOT discovered);
   it does **not** follow symlinks in the plugins dir; and plugin source must resolve its deps via
   the config's `node_modules` (import `@opencode-ai/plugin`, use `tool.schema` — never import
   `zod` directly). Fix: copy source into `~/.config/opencode/plugins/peer-delegate-src` (see
   `plugin/sync.sh`) with a wrapper bridge that calls the impl.
4. **Delegate auto-consume vs. instructions (design change).** The plugin's delegate role consumes
   (and deletes) `handoff.json` on boot. If the coordinator ALSO tells the agent to read the
   handoff, the file is already gone → confusion. The coordinator must NOT reference handoff.json in
   its prompt; the delegate gets its task from the plugin, not from the file.
5. **Task text is lost on consume (must fix).** `handoff.json.task` is destroyed on consume and not
   kept in `.consumed.json`, so a crash/restart between consume and doing the work loses the
   instructions. **Fix:** persist the task (e.g. `task.txt` or a `.task` field in `.consumed.json`)
   so a restarted delegate can recover. The delegate role should also inject the task into the
   agent's context on boot rather than relying on the coordinator to send it.
6. **Job-dir permission prompt (must handle).** The delegate agent writing to the job-dir
   (`$XDG_RUNTIME_DIR/herdr/<id>/`) triggers opencode's external-directory permission prompt,
   blocking completion until approved. The plugin should pre-authorize the job-dir pattern for the
   delegate (via config/permission), or place the completion channel where the agent already has
   write access.

## 11b. Resolutions (implemented + live-verified in the plugin)
- **.3 loader:** source copied to `~/.config/opencode/plugins/peer-delegate-src` via `plugin/sync.sh`
  + a wrapper bridge that calls the impl; uses `tool.schema`, never imports `zod`.
- **.4/.5 task:** task persisted in `.consumed.json`; coordinator delivers it via `herdr agent send`
  after boot (never referencing handoff.json). TUI self-injection from the delegate proved
  unreliable; coordinator-send is authoritative.
- **.6 permissions:** delegate launches with `opencode --agent <name> --auto` (trusted same-user
  peer) so it writes its worktree + job-dir without a blocking prompt.
- **verify+merge:** coordinator auto-verifies every result (§5/§6) and, under `auto-after-checks`,
  auto-merges code-change via synthetic merge into a non-occupied target (§7). Live-verified:
  advisory (trusted, no gate) and code-change (verified → merged into `integration`, `main`
  untouched); result.json acknowledged/deleted after.

## 12. Plugin architecture (single TS plugin, dual role)
Both coordinator and delegate are opencode processes, so **one plugin** loads in both. There is no
shared bash: the delegate-side behavior (consume/complete) becomes in-process TS + opencode tools,
not on-disk shims.

- **Role detection.** The coordinator sets a job-dir/env marker when spawning a delegate; the
  plugin activates the coordinator half by default, the delegate half when that marker is present.
- **Coordinator role.** Exposes a `delegate(agent, task, repo, outputContract, checks, mergePolicy)`
  tool: writes `handoff.json`, creates the worktree, splits the pane, boots `opencode --agent`,
  observes readiness via herdr, verifies (§5/§6), merges (§7, into a non-occupied target per §11.2).
- **Delegate role.** On boot reads `handoff.json` in-process (TS), unlinks it (§3), keeps the task
  in context, and exposes a `complete(...)` tool the delegate agent calls → writes `result.json`
  (token-authed, dup-rejecting, §4).
- **Transport is the disk, full stop.** Separate OS processes with separate memory do not share
  in-process state. **All** coordinator↔delegate communication goes through job-dir files
  (`handoff.json`, `result.json`, and any block/question/heartbeat files). There is no socket, no
  in-process messaging between the two processes — the disk is the single channel. The plugin
  reads/writes these files in TS instead of shelling out. Same protocol, no bash.

## 13. Async event model — file-watch driven, coordinator never blocks the user
The disk is the transport (§12); **file-watches are the event mechanism.** Each side watches the
job-dir and reacts to files appearing/changing — this is how completion, blocking, and readiness
are detected. Nothing polls in a blocking loop; nothing interrupts the user.

- **Delegate→coordinator via watched files.** The coordinator watches each job-dir. A delegate
  signals by writing a file:
  - `result.json` → job complete (success/failure).
  - `block.json` (or equivalent) → delegate is waiting on the user/coordinator (question/approval).
  - `heartbeat`/mtime → liveness; absence past a timeout → treated as stalled/crashed.
  The watch **enqueues** an event; the coordinator drains the queue at safe points (between turns),
  never preempting the user's current turn.
- **Coordinator→delegate via watched files.** The delegate watches its own job-dir. The coordinator
  answers a blocked delegate or issues a follow-up by writing a file (e.g. `reply.json`); the
  delegate's watch picks it up when it next checks. Delivered when the delegate is idle/awaiting.
- **No lost events.** A file that appears mid-turn is captured by the watch and surfaced at the next
  safe point, never dropped. File creation is inherently async-friendly.
- **Fan-out.** Each delegate's job-dir is watched independently; events key by `jobId` and reconcile
  as the coordinator drains — out-of-order completions are fine.
- **Backpressure.** Draining is non-blocking and best-effort; a slow/never-finishing delegate cannot
  stall the queue or the user (startup timeout §3; stalled delegates surface via heartbeat absence).
- **Mechanism.** Filesystem watch (inotify/fs-watch on the job-dir) is authoritative and sufficient;
  it works regardless of whether the delegate is herdr-managed. herdr agent-status, if available, is
  only an optional wake-hint — never required for correctness.

## 14. Final slice — implemented + live-verified
- **block/reply round-trip.** Delegate `ask` tool writes `block.json` and blocks (polling) until the
  coordinator's `reply()` writes `reply.json`; the delegate reads the answer and unlinks both. The
  coordinator surfaces the question text on the `block` event. Verified in-process end-to-end.
- **Startup-timeout.** On spawn the coordinator arms a timer; if `.consumed.json` doesn't appear
  within `startupTimeoutSeconds` (default 30) it enqueues `startup-timeout`, interrupts the pane's
  process (Ctrl-C), and leaves the pane open. The timer is cancelled when the watch sees
  `.consumed.json`. Verified.
- **fs-watch temp-filename fix (important).** `atomic temp+rename` makes `fs.watch` report the TEMP
  filename on the rename, not the canonical name. The watcher therefore ignores the reported filename
  and **re-scans the job-dir** for canonical files on every event (debounced, dedup via a per-job
  `seen` set). Without this, results were never enqueued. Verified: live fs-watch enqueues result and
  block.
- **Live drain proven.** A real delegate's `result.json` was picked up by the live fs-watch (no
  polling), drained exactly as the plugin's `session.idle` handler does (`drain()` → `surface()`),
  auto-verified (§5/§6) and auto-merged (§7) into `integration`. The full async path — disk transport
  + file-watch queue + between-turns drain — works end-to-end.

## Related
- Plugin (implementation): `research/plugin/src/` — `protocol.ts`, `delegate.ts`, `coordinator.ts`,
  `verify.ts`, `index.ts`; wired via `~/.config/opencode/plugins/peer-delegate.ts` + `plugin/sync.sh`
- Harness (executable spec): `research/harness/` — `hd-new`, `hd-consume`, `hd-complete`,
  `hd-verify`, `hd-merge`, `hd-lib.sh`
- Skill: `~/.config/opencode/skills/herdr-delegate/SKILL.md` (manual orchestration workflow)
- Agents: `~/.config/opencode/agent/grilling.md` (Sol), `~/.config/opencode/agent/worker.md` (Opus 4.8)

## 15. Worktree strategy — plain git, no `herdr worktree create`
`herdr worktree create` was DROPPED: it spun up an orphan herdr *workspace* per job that
littered the sidebar (labeled `... (deleted)`) and needed separate cleanup. Instead:
- Coordinator uses **plain `git worktree add`** under `<repo>/.peer-delegate/worktrees/<branch>`
  (gitignored) and splits the delegate pane into the CURRENT herdr workspace.
- No herdr worktree/workspace is ever created — the sidebar stays clean.
- **Auto-reap:** on advisory or merged-code-change completion, `surface()` calls `reap()` —
  closes the pane, `git worktree remove`, optional branch delete, clears the job-dir. Jobs whose
  verify failed or merge was held are KEPT for inspection (reap manually via the `reap_delegate`
  tool). Verified live: a full advisory job left the herdr workspace list unchanged and reaped
  with zero residue (no pane, no worktree, no job-dir).
