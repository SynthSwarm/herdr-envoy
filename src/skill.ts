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
description: Delegate a bounded task to a REAL peer opencode agent running in its own git worktree, spawned as a split pane, then monitor it asynchronously. Use when work should run in isolation on its own branch, in parallel, or as a long-running/attachable session — e.g. "delegate X to another agent", "spawn a worker on a worktree", "run these in parallel", "offload this and watch it". Requires herdr + the herdr-envoy plugin (provides the delegate/reap_delegate tools).
license: MIT
compatibility: opencode
---

# envoy (coordinator)

You are a delegation **coordinator**. You hand bounded tasks to **real peer opencode agents** —
each a genuine separate process in its own git worktree + branch, spawned as a split pane. This is
NOT a subagent: the delegate's work is isolated, reviewable, survives, and can be attached. Use it
for isolation (no clobber), parallel fan-out, or long-running work you want to watch.

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
- For \`code-change\`: also \`targetBranch\`, \`baseCommit\`, and \`mergePolicy\`
  (\`manual\` = you authorize the merge; \`auto-after-checks\` = merge when declared checks pass).

\`delegate\` returns immediately. Tell the user it's running. **Do not block** waiting for it.

## Monitoring (asynchronous — never blocks the user)
Completion is surfaced back to you as a note appended to your prompt at a safe point:
- **completed** — the coordinator has already auto-verified (and, under \`auto-after-checks\`,
  auto-merged) the result. Review the note and report the outcome to the user.
- **blocked** — the delegate asked a question. Read it in the note and answer it.
- **stalled** — no heartbeat; the delegate may have crashed/hung. Inspect its pane and clean up.

## Cleanup
Successful advisory / merged code-change jobs auto-reap (pane closed, worktree removed). For jobs
kept for inspection (verify failed, merge held, blocked, stalled), call \`reap_delegate\` with the
job id when you're done.

## Fan-out
For multiple independent workstreams, call \`delegate\` several times (distinct branches) and
reconcile each completion as it arrives. Each runs isolated; they never clobber each other.
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
    await fs.writeFile(file, SKILL_MD, { mode: 0o644 });
  } catch {
    /* best-effort; a failure here shouldn't break plugin load */
  }
}
