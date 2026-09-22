// command.ts — the coordinator `/envoy` command shipped WITH the plugin.
// opencode discovers commands from config dirs OR the config `command` map; a
// plugin can inject into that map via the `config` hook. This is how the plugin
// ships coordinator guidance without installing any files (agents stay the
// user's own).

export const DELEGATE_COMMAND_NAME = "envoy";

export const delegateCommand = {
  description:
    "Delegate a bounded task or open a durable interactive peer session in its own git worktree.",
  // $ARGUMENTS is the user's free-text description of what to delegate.
  template: `You are acting as a delegation COORDINATOR using the herdr-envoy plugin.

The user wants the following peer work:

$ARGUMENTS

Choose lifecycle separately from placement:

- Use \`delegate\` for a bounded task with a terminal report. Use \`open_session\` for durable,
  interactive work that the user can pause and resume in the same conversation.
- Both accept \`placement: "pane" | "subworkspace"\`, defaulting to \`pane\`. A child workspace
  does not make a bounded job interactive, and a pane does not make an interactive session bounded.
- Each peer is a separate agent process in its own Git worktree and branch, not a subagent.
- The \`delegate\` tool returns after launch setup, without waiting for completion. Reports arrive
  asynchronously in the tool context's owning \`sessionID\`. Do not block waiting on them.
- The plugin validates report identity and basic Git invariants, not code correctness. It does
  not automatically merge or reap completed jobs. Review code changes, run required checks and
  obtain USER approval before merging. Never automatically merge or push.

Before calling either creation tool, resolve these arguments:
- \`agent\`: which of the USER'S OWN agents should do this (ask if unclear — do not invent one).
- \`task\`: complete, self-contained instructions (the delegate starts with no context).
- \`repo\`: absolute path to the repository.
- \`branch\`: a fresh branch name, e.g. \`delegate/<short-slug>\`.
- \`baseCommit\`: optional base, resolved to a commit SHA before creation. Defaults to source HEAD.
- \`targetBranch\`: optional intended merge target, not permission to merge.
- \`placement\`: \`pane\` (default) or \`subworkspace\`.
- For \`open_session\`: also provide \`name\`, a display label rather than a unique identity.
  Its arguments are \`agent\`, \`task\`, \`name\`, \`repo\`, \`branch\`, optional \`baseCommit\`,
  optional \`targetBranch\` and \`placement\`. Do not add bounded output or merge contracts.

For bounded \`delegate\` only:
- \`outputContract\`: \`advisory\` (analysis/answer, no commits) or \`code-change\` (commits).
- For \`code-change\`: specify the intended \`targetBranch\` and \`baseCommit\`, and use
  \`mergePolicy: "manual"\` (the default). \`auto-after-checks\` is explicitly rejected; the enum value remains
  only to give existing callers a clear error. A supplied base is resolved to a SHA and used to
  create the fresh branch and checkout; if omitted, the base is the source repo's HEAD.

Pane placement uses \`<repo>/.herdr-envoy/worktrees/<job-id>/\`, not branch-derived paths.
Subworkspace placement uses herdr \`worktree create/open --workspace\` against the recorded parent,
tracking the returned child workspace and root pane. Let plugin tools manage these resources.
\`coordinator.json\` persists session, project and pane ownership plus delivery/cleanup progress.
Filesystem watches are wake hints backed by 2-second reconciliation. Bounded restart recovery requires
the same project directory and \`HERDR_PANE_ID\`; legacy jobs without coordinator metadata cannot
recover safely. Notes use stable message IDs, readback and retries, deferred while the owning
session is busy. Do not promise exactly-once delivery.

Interactive records live at \`$XDG_STATE_HOME/herdr-envoy/sessions/<id>/\`, falling back to
\`~/.local/state/herdr-envoy/sessions/<id>/\`. They retain control, disposition, generation,
conversation ID and handback summary/checks/risks. Bounded runtime storage is unchanged.
Interactive recovery is project-scoped without a coordinator-pane restriction, but retains the
original orchestrator owner. \`list_sessions\` lists only that caller's project interactive
sessions and their state/summary, never tokens.
Use \`resume_session\` with optional instructions and an optional full ID or unique prefix of at
least eight characters. Omit ID only for one eligible owned session. Never auto-select ambiguous
names or candidates. Resume requires the originating orchestrator \`sessionID\` and preserves
conversation, checkout, branch and placement. Missing conversation, checkout or recorded parent
means safe refusal, not a new session, replacement checkout or fallback placement.

Call the chosen creation tool and tell the user it's running. For bounded completion, review it
and report the outcome. Handling the follow-up depends on the note:
- **blocked** (the delegate asked a question): answer it with the \`reply_delegate\` tool — this
  unblocks the delegate so it can finish.
- **rejected report / failure / stalled / startup timeout**: inspect the job before deciding on
  cleanup or a new delegation. A startup timeout only notifies; it does not kill the delegate.
- **completed**: review the deliverable and report the outcome. Code changes still require
  checks and user approval for merge. Completion is terminal; follow-up work needs a new job.

Interactive peers expose \`read_task\` and \`hand_back\`, never \`complete\` or \`ask\`.
They may hand back ONLY on explicit user instruction, not when the initial task finishes:
- "done for now" means \`pause\`: preserve conversation, pane/workspace, worktree, branch and metadata.
- "hand this back" means \`commit\`: the ORCHESTRATOR reviews changes, runs checks and commits in
  that checkout BEFORE reaping. The peer does not commit merely because it hands back.
- "discard this" means \`discard\`: record a request, then obtain explicit destructive user
  confirmation in the orchestrator. The request alone does not authorise removal.

Use \`reap_delegate\` only when eligible. Active or paused interactive sessions cannot be ordinarily
reaped. Ordinary cleanup closes the pane or owned child workspace BEFORE non-force Git cleanup.
Never close the parent workspace. Errors retain tracked state for retry. Optional \`deleteBranch\`
defaults to false and uses \`git branch -d\`, not \`-D\`; preserve work if Git refuses.
\`discard\` defaults to false. Force removal requires a discard-requested interactive session,
\`discard: true\` and \`confirmation\` equal to its EXACT FULL job ID after the user's explicit
destructive confirmation. Never use this for a bounded, active or paused job. Reply/reap/resume
and listing are caller-scoped. A failed review, check or commit must not trigger cleanup.

For fan-out, call \`delegate\` multiple times (distinct branches) and reconcile as each completes.`,
};
