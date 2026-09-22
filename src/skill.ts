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
description: Delegate a bounded task to a REAL peer opencode agent running in its own git worktree, spawned as a split pane, then monitor it asynchronously. Use when work should run in isolation on its own branch, in parallel, or as a long-running/attachable session — e.g. "delegate X to another agent", "spawn a worker on a worktree", "run these in parallel", "offload this and watch it". Requires herdr + the herdr-envoy plugin (provides delegate, reply_delegate and reap_delegate tools).
license: MIT
compatibility: opencode
---

# envoy (coordinator)

You are a delegation **coordinator**. You hand bounded tasks to **real peer opencode agents** —
each a genuine separate process in its own git worktree + branch, spawned as a split pane. This is
NOT a subagent: the delegate's checkout is separate and reviewable, and its pane can be inspected.
Use it for isolated file edits, parallel fan-out, or long-running work you want to watch.

The herdr-envoy plugin gives you the tools. You do NOT manage panes/worktrees yourself.

## When to use
- The user says "delegate", "spawn a worker/agent", "run in parallel", "offload", "in its own worktree".
- Work benefits from isolation (its own branch) or from running several streams concurrently.
- Prefer this over a subagent when you want a real, separate, attachable session.

## How to delegate
Call the \`delegate\` tool. Resolve these first:
- \`agent\`: which of the USER'S OWN agents runs the task. Ask if unclear — never invent one.
- \`task\`: complete, self-contained instructions. The delegate starts with NO context, so include
  everything it needs. Do not reference files it can't see.
- \`repo\`: absolute path to the repository.
- \`branch\`: a fresh branch, e.g. \`delegate/<short-slug>\`.
- \`outputContract\`: \`advisory\` (analysis/answer, no commits) or \`code-change\` (commits).
- For \`code-change\`: specify the intended \`targetBranch\` and \`baseCommit\`, and use
  \`mergePolicy: "manual"\` (the default). \`auto-after-checks\` is explicitly rejected; the enum value is
  retained only to give existing callers a clear error. A supplied base is resolved to a commit
  SHA and used to create the fresh branch/worktree. If omitted, the base is the source repo's HEAD.

\`delegate\` returns after launch setup, without waiting for completion. Tell the user it's running.
**Do not block** waiting for it. Worktrees use \`<repo>/.herdr-envoy/worktrees/<job-id>/\`.
The delegate reads the persisted brief with \`read_task\`, reports with \`complete\` and asks
questions with \`ask\`. Do not tell it to read the already-consumed \`handoff.json\`.

## Monitoring and review
Jobs bind to the tool context's \`sessionID\`. \`coordinator.json\` persists that owner, the project
directory, coordinator/delegate panes and notification/cleanup progress. Filesystem watches are
wake hints backed by 2-second reconciliation. Restart recovery requires the same project
directory and \`HERDR_PANE_ID\`. Legacy jobs without coordinator metadata cannot recover safely.

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
merging. The plugin does not run project checks or automatically merge. Advisory content is
trusted, not independently verified. Completion is terminal with no reopen operation; use a new
job for follow-up work.

## Cleanup
Completed jobs never auto-reap. Call \`reap_delegate\` with the job ID when inspection is finished
and the checkout is no longer needed. It closes the pane first, then removes the clean checkout
without force. Dirty work survives, and errors retain the tracked job for retry. Preserve that
work before retrying. Optional \`deleteBranch\` defaults to false and uses \`git branch -d\`, not
\`-D\`; an unmerged branch is retained if Git refuses deletion. Reply/reap tools are scoped to the
calling session. Launch failures attempt cleanup, retaining the job if cleanup fails.

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
