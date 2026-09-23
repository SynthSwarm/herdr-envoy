// skill.ts — the coordinator skill shipped WITH the plugin. Skills can only be
// discovered from config dirs (no config-hook injection like commands), so the
// plugin self-provisions the SKILL.md on load: writes it if missing, never
// overwrites user edits. Agents remain the user's — this is coordinator
// GUIDANCE (when/how to delegate), not an agent.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SKILL_NAME = "envoy";

const SKILL_MD = `---
name: envoy
description: Delegate bounded tasks or open durable interactive sessions with real peer opencode agents in isolated Git worktrees. Use for delegation, parallel work, or opening and resuming an attachable peer session in a pane or child workspace. Requires herdr and herdr-envoy (delegate, open_session, list_sessions, resume_session, reply_delegate and reap_delegate tools).
license: MIT
compatibility: opencode
---

# envoy (coordinator)

You are a delegation **coordinator**. Peers are real separate opencode processes with their own
Git worktree and branch, not subagents. Choose a bounded task or a durable interactive session
independently of placement: both support a pane or a child workspace. Use them for isolated
edits, parallel fan-out or interactive work that the user can pause and resume.

The herdr-envoy plugin gives you the tools. You do NOT manage panes/worktrees yourself.

## When to use
- The user says "delegate", "spawn a worker/agent", "run in parallel", "offload", "in its own worktree".
- Work benefits from isolation (its own branch) or from running several streams concurrently.
- Prefer this over a subagent when you want a real, separate, attachable session.

## Choose lifecycle and placement
Use \`delegate\` for bounded work with a terminal completion report. Use \`open_session\` for
durable interactive work. Neither lifecycle determines placement: both tools accept
\`placement: "pane" | "subworkspace"\`, defaulting to \`pane\`.

Resolve these creation arguments first:
- \`agent\`: which of the USER'S OWN agents runs the task. Ask if unclear — never invent one.
  Repository-scoped validation supports \`primary\`, \`subagent\` and \`all\` modes.
- \`task\`: complete, self-contained instructions. The delegate starts with NO context, so include
  everything it needs. Do not reference files it can't see.
- \`repo\`: absolute path to the repository.
- \`branch\`: a fresh branch, e.g. \`delegate/<short-slug>\`.
- \`baseCommit\`: optional base, resolved to a commit SHA. Defaults to source repository HEAD.
- \`targetBranch\`: optional intended merge target, never permission to merge.
- \`placement\`: \`pane\` (default) or \`subworkspace\`.

\`open_session\` also takes \`name\`, a display label, not a unique identifier. Its arguments are
\`agent\`, \`task\`, \`name\`, \`repo\`, \`branch\`, optional \`baseCommit\`, optional \`targetBranch\`
and \`placement\`. It does not take bounded output or merge contracts.

For bounded \`delegate\` only:
- \`outputContract\`: \`advisory\` (analysis/answer, no commits) or \`code-change\` (commits).
- For \`code-change\`: specify the intended \`targetBranch\` and \`baseCommit\`, and use
  \`mergePolicy: "manual"\` (the default). \`auto-after-checks\` is explicitly rejected; the enum value is
  retained only to give existing callers a clear error. A supplied base is resolved to a commit
  SHA and used to create the fresh branch/worktree. If omitted, the base is the source repo's HEAD.

Creation returns after launch setup, without waiting for completion. Tell the user it's running.
**Do not block** waiting for it. Pane placement uses \`<repo>/.herdr-envoy/worktrees/<job-id>/\`.
Subworkspace placement uses herdr \`worktree create/open --workspace\` against the recorded parent,
tracking the returned child workspace, root pane and checkout. Do not guess resource identities.
Resolve the requested repository's parent with \`herdr worktree list --cwd <repo>\` and verify
the same realpath repository root, even across repositories. If no parent exists, ask the user
to open that repository in herdr. Never substitute the caller's workspace.
Both peers read the persisted brief with \`read_task\`, not the already-consumed \`handoff.json\`.
Bounded peers report with \`complete\` and ask questions with \`ask\`. Interactive peers expose
\`read_task\` and \`hand_back\` only, with NO \`complete\` or \`ask\`.

## Monitoring and review
Jobs bind to the tool context's \`sessionID\`. \`coordinator.json\` persists that owner, the project
directory, coordinator/delegate panes and notification/cleanup progress. Filesystem watches are
wake hints backed by 2-second reconciliation. Bounded restart recovery requires the same project
directory and \`HERDR_PANE_ID\`. Legacy jobs without coordinator metadata cannot recover safely.

Interactive metadata is durable at \`$XDG_STATE_HOME/herdr-envoy/sessions/<id>/\`, falling back
to \`~/.local/state/herdr-envoy/sessions/<id>/\`. It retains owner/project, control, disposition,
generation, peer conversation ID, placement and handback summary/checks/risks. Bounded runtime
storage is unaffected. Interactive recovery is project-scoped without a coordinator-pane
restriction. The original orchestrator owner is retained, never reassigned to the discoverer.

Durable redacted logs use \`$XDG_STATE_HOME/herdr-envoy/logs/YYYY-MM-DD.jsonl\` (fallback
\`~/.local/state/herdr-envoy/logs/\`). Only UTC timestamps, job IDs, event/reason codes, generation,
disposition and HTTP status are recorded, never text, paths or tokens. Keep today and the previous
29 UTC dates, with a soft 8 MiB daily append cap allowing concurrent overshoot. Reconciliation
failure logs are limited to once per minute per job per process. Logging failures do not block
operations, and historical events are not backfilled.

Notes use persisted stable message IDs, readback and retries, with delivery deferred while the
owning session is busy. This is not an exactly-once delivery guarantee. Interpret notes as follows:
- **completed** — report identity is validated, plus basic Git invariants for code-change success,
  not code correctness.
  No merge or cleanup has happened. Review the deliverable and report the outcome to the user.
- **blocked** — the delegate asked a question. Read it in the note and answer it with the
  \`reply_delegate\` tool; that unblocks the delegate so it can continue.
- **rejected report / failure** — inspect the report and checkout before cleanup or re-delegation.
- **stalled / startup timeout** — inspect the pane. A stale heartbeat is only a possible stall;
  startup timeout (default 30 seconds) notifies only and does not kill the delegate.

For code changes, review the diff, run the required checks and obtain USER approval before
merging. Never automatically merge or push. Advisory content is trusted, not independently
verified. Bounded completion is terminal with no reopen operation; use a new job for follow-up.

## Interactive handback and resume
An interactive peer must call \`hand_back\` ONLY on explicit user instruction. Finishing the
initial task, going idle or deciding the work looks ready is not a handback instruction.
- "done for now": \`pause\` preserves the conversation, pane/workspace, checkout, branch and
  metadata. Do not commit or reap.
- "hand this back": \`commit\` returns control to the orchestrator, who reviews the diff, runs
  required checks and commits in the session checkout BEFORE reaping. A failed review, check or
  commit preserves the session. The peer does not commit or clean up merely because it hands back.
- "discard this": \`discard\` records a discard request. Obtain separate explicit destructive
  confirmation from the user in the orchestrator before removing work. The request is not consent.

Handback includes summary, checks and risks. Use \`list_sessions\` to inspect durable interactive
sessions for the current project owned by the calling orchestrator \`sessionID\`, with state,
generation, summary, checks, risks, \`notificationPending\` and \`notificationAttemptedAt\`
(the pending note's \`attemptedAt\`) but no tokens. Recovery does not broaden listing scope.

Explicit \`hand_back\` may move paused work to commit/discard without resuming. Same-disposition
retries preserve the original report even with a different summary. Commit/discard cannot
transition through \`hand_back\`; only explicit orchestrator resume can reopen commit-ready work.
Coordinator operations and \`hand_back\` share per-session locks.

\`resume_session\` takes optional instructions and an optional full ID or unique prefix of at
least eight characters. An explicit ID resumes paused or commit-ready work regardless of pending
delivery, returns the previous handback summary/checks/risks and durably supersedes its queued
notice. It never commits or reaps; wait for a new handback before commit or cleanup. Discard cannot
resume or implicitly resurrect. Omit ID only when exactly one paused owned session exists. Do not
auto-select an ambiguous name or candidate. Resume requires the originating orchestrator
\`sessionID\` and continues the same peer conversation, worktree, branch and placement.
Missing conversation, checkout or recorded parent workspace must cause a safe refusal, not a
fresh conversation, replacement checkout or fallback placement. Preserve metadata for repair.

## Cleanup
Bounded completion never auto-reaps. Call \`reap_delegate\` when inspection is finished and the
checkout is no longer needed. Interactive commit handback additionally requires orchestrator
review, checks and commit first. Active or paused interactive sessions cannot be ordinarily reaped.
Ordinary cleanup closes the pane, or the owned child workspace for subworkspace placement,
BEFORE non-force Git cleanup. Never close the parent workspace. Dirty work survives and errors
retain tracked progress for retry. Optional \`deleteBranch\` defaults to false and uses
\`git branch -d\`, not \`-D\`; an unmerged branch is retained if Git refuses deletion.

\`reap_delegate\` also takes \`discard: boolean\` (default false) and \`confirmation\`. Only a
discard-requested interactive session can use force removal: obtain explicit destructive user
confirmation in the orchestrator, then pass \`discard: true\` and \`confirmation\` equal to the
EXACT FULL job ID. A prefix, name or generic approval is insufficient. Never force-remove a
bounded, active or paused job. Branch deletion is a separate choice, not implied by discard.
Reply/reap/resume and listing are caller-scoped. Launch failures attempt safe cleanup and retain
the job if cleanup fails. Neither placement grants permission to discard work.
Uncertain creation cleanup reconciles herdr/Git inventories, including an older wrong-parent
repository. Clear uncertainty only with proof of no checkout, workspace, branch or attempted
launch. Surviving resources or inconclusive inventories keep cleanup refused for inspection.

## Fan-out
For multiple independent workstreams, call \`delegate\` several times (distinct branches) and
reconcile each completion as it arrives. Separate checkouts isolate file edits, not shared
external resources.

## Installed guidance
Skill provisioning only writes a missing SKILL.md; it does not overwrite an existing installed
skill. Existing copies need manual review/update when shipped guidance changes. Quit and restart
opencode after installing/updating the plugin or updating an installed skill.
`;

// Write the skill to ~/.config/opencode/skills/envoy/SKILL.md if it
// does not already exist. Idempotent; never overwrites (respects user edits).
export async function provisionSkill(): Promise<void> {
  const configHome =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  const dir = path.join(configHome, "opencode", "skills", SKILL_NAME);
  const file = path.join(dir, "SKILL.md");
  try {
    await fs.access(file);
    return; // already present — respect any user edits
  } catch {
    /* not present; create it */
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, SKILL_MD, { mode: 0o644, flag: "wx" });
  } catch {
    /* best-effort; a failure here shouldn't break plugin load */
  }
}
