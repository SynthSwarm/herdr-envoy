// command.ts — the coordinator `/envoy` command shipped WITH the plugin.
// opencode discovers commands from config dirs OR the config `command` map; a
// plugin can inject into that map via the `config` hook. This is how the plugin
// ships coordinator guidance without installing any files (agents stay the
// user's own).

export const DELEGATE_COMMAND_NAME = "envoy";

export const delegateCommand = {
  description:
    "Delegate a bounded task to a real peer opencode agent in its own git worktree, then monitor it.",
  // $ARGUMENTS is the user's free-text description of what to delegate.
  template: `You are acting as a delegation COORDINATOR using the herdr-envoy plugin.

The user wants to delegate the following work to a peer agent:

$ARGUMENTS

Use the \`delegate\` tool to spawn a real peer opencode agent for this. How it works:

- Each delegate is a genuine separate agent process in its own git worktree + branch,
  spawned as a split pane. It is NOT a subagent — its work is isolated and reviewable.
- The \`delegate\` tool returns after launch setup, without waiting for completion. Reports arrive
  asynchronously in the tool context's owning \`sessionID\`. Do not block waiting on them.
- The plugin validates report identity and basic Git invariants, not code correctness. It does
  not automatically merge or reap completed jobs. Review code changes, run required checks and
  obtain USER approval before merging.

Before calling \`delegate\`, resolve these arguments:
- \`agent\`: which of the USER'S OWN agents should do this (ask if unclear — do not invent one).
- \`task\`: complete, self-contained instructions (the delegate starts with no context).
- \`repo\`: absolute path to the repository.
- \`branch\`: a fresh branch name, e.g. \`delegate/<short-slug>\`.
- \`outputContract\`: \`advisory\` (analysis/answer, no commits) or \`code-change\` (commits).
- For \`code-change\`: specify the intended \`targetBranch\` and \`baseCommit\`, and use
  \`mergePolicy: "manual"\` (the default). \`auto-after-checks\` is explicitly rejected; the enum value remains
  only to give existing callers a clear error. A supplied base is resolved to a SHA and used to
  create the fresh branch and checkout; if omitted, the base is the source repo's HEAD.

Worktrees use \`<repo>/.herdr-envoy/worktrees/<job-id>/\`, not branch-derived paths.
\`coordinator.json\` persists session, project and pane ownership plus delivery/cleanup progress.
Filesystem watches are wake hints backed by 2-second reconciliation. Restart recovery requires
the same project directory and \`HERDR_PANE_ID\`; legacy jobs without coordinator metadata cannot
recover safely. Notes use stable message IDs, readback and retries, deferred while the owning
session is busy. Do not promise exactly-once delivery.

Then call \`delegate\` and tell the user it's running. When the completion note arrives, review it
and report the outcome. Handling the follow-up depends on the note:
- **blocked** (the delegate asked a question): answer it with the \`reply_delegate\` tool — this
  unblocks the delegate so it can finish.
- **rejected report / failure / stalled / startup timeout**: inspect the job before deciding on
  cleanup or a new delegation. A startup timeout only notifies; it does not kill the delegate.
- **completed**: review the deliverable and report the outcome. Code changes still require
  checks and user approval for merge. Completion is terminal; follow-up work needs a new job.

When finished inspecting the job, call \`reap_delegate\` explicitly. It closes the pane first,
then removes the clean checkout without force. Errors retain the tracked job for retry. Optional
branch deletion uses \`git branch -d\`, not \`-D\`; an unmerged branch is retained if Git refuses
deletion. Preserve dirty work before retrying cleanup.

For fan-out, call \`delegate\` multiple times (distinct branches) and reconcile as each completes.`,
};
