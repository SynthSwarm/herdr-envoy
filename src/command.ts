// command.ts — the coordinator `/envoy` command shipped WITH the plugin.
// opencode discovers commands from config dirs OR the config `command` map; a
// plugin can inject into that map via the `config` hook. This is how the plugin
// ships coordinator guidance without installing any files (agents stay the
// user's own).

import { HANDOVER_REVIEW } from "./review.js";

export const DELEGATE_COMMAND_NAME = "envoy";

export const delegateCommand = {
  description:
    "Delegate a bounded task or open a durable interactive peer session in its own git worktree.",
  // $ARGUMENTS is the user's free-text description of what to delegate.
  template: `You are acting as a delegation COORDINATOR using the herdr-envoy plugin.

The user wants the following peer work:

$ARGUMENTS

Prefer \`list_agents\` for stable identity references and local Git context. New Envoy agents
use the same reference as their pane or child-workspace label. Use \`request_agent({identity, task})\`
instead of exposing pane IDs. Refresh discovery before targeting. Remote or ambiguous matches
are refused; discovery never grants cleanup authority. Owned references also work as jobId
selectors for reap/reply/resume. Existing jobs retain their old labels and IDs.

Use \`list_machines\` for read-only discovery of Local and saved SSH machines and their live
OpenCode agents. Idle/done agents are included, not just working ones. Disabled machines are
not contacted; unavailable inventories are unknown, not empty. Pane IDs are machine-scoped.
Discovery does not claim agents or authorise sending requests. Creation/resume tools remain local.

Use \`request_agent({paneId, sessionId, task})\` for an existing LOCAL OpenCode agent, using the Local
inventory from \`list_machines\`. Both processes need the updated plugin. Requests wait for idle
and earlier requests' handback. No terminal input, new checkout or ownership takeover.
The target uses \`read_task({jobId})\` and \`hand_back({jobId, ...})\`; omit jobId only for its
original delegation. Automatically hand back finished work with nothing to commit as \`completed\`.
Pause, commit and discard require explicit user direction.
After an outage, the same peer conversation in its original worktree can use \`read_task\` or
\`hand_back\` without the original launch environment. Omit jobId for one matching owned peer or
pass its exact saved job ID. Do not use \`list_sessions\` to discover a peer's own identity or
manually edit saved authentication. Recovery refuses replacement conversations and changed branches.
Inspect \`list_sessions\` for requestDelivered/requestAttemptedAt/requestCancelled. An attempted
but unconfirmed delivery is not automatically replayed. \`cancel_request\` retires a request
without interrupting already-submitted work. Never reap/resume an existing-agent request.

Choose lifecycle separately from placement:

For an existing named agent, discover first and queue to a unique match, even when busy. If absent,
ask for its working folder, then \`open_session\` with \`placement: "workspace"\` and \`repo\` set
to that existing absolute folder (omit branch/base/target). This is an independent workspace, not
a child workspace or new Git worktree. Never delete the supplied project folder during reap.
"Beside me/same workspace" suggests pane; "child workspace" suggests subworkspace;
"own working folder/open this project" suggests workspace. These are intent cues, not strict
keywords. Respect negation and ask briefly if ambiguous. Busy/unreachable does not mean absent.
Before every new process, Envoy loads direnv in the destination and only spawns OpenCode after
successful export. New worktrees receive private copies of root .env/.envrc and direnv allow;
standalone folders use their own files. Never print secrets, bypass failed loading, or infer
environment readiness merely from a shell prompt. A running session's environment is unchanged.

- Use \`delegate\` for a bounded task with a terminal report. Use \`open_session\` for durable,
  interactive work that the user can pause and resume in the same conversation.
- Both accept \`placement: "pane" | "subworkspace"\`, defaulting to \`pane\`. A child workspace
  does not make a bounded job interactive, and a pane does not make an interactive session bounded.
- Each peer is a separate agent process in its own Git worktree and branch, not a subagent.
- The \`delegate\` tool returns after launch setup, without waiting for completion. Reports arrive
  asynchronously in the tool context's owning \`sessionID\`. Do not block waiting on them.
- The plugin validates report identity and basic Git invariants, not code correctness. It does
  not automatically merge or reap completed jobs. Use peer evidence and a focused handover review, and
  obtain USER approval before merging. Never automatically merge or push.

Before calling either creation tool, resolve these arguments:
- \`agent\`: which of the USER'S OWN agents should do this (ask if unclear — do not invent one).
  Repository-scoped validation supports \`primary\`, \`subagent\` and \`all\` modes.
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
Resolve the requested repository's parent with \`herdr worktree list --cwd <repo>\` and verify
the same realpath repository root, even across repositories. If no parent exists, ask the user
to open that repository in herdr. Never substitute the caller's workspace.
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
sessions with state, generation, summary, checks, risks, \`notificationPending\` and
\`notificationAttemptedAt\` (the pending note's \`attemptedAt\`), never tokens.
Use \`resume_session\` with optional instructions and an optional full ID or unique prefix of at
least eight characters. An explicit ID resumes paused or commit-ready work regardless of pending
delivery, returns the previous handback summary/checks/risks and durably supersedes its queued
notice. It never commits or reaps; wait for a new handback before commit or cleanup. Discard cannot
resume or implicitly resurrect. Omit ID only for exactly one paused owned session. Never auto-select ambiguous
names or candidates. Resume requires the originating orchestrator \`sessionID\` and preserves
conversation, checkout, branch and placement. Missing conversation, checkout or recorded parent
means safe refusal, not a new session, replacement checkout or fallback placement.

Durable redacted logs use \`$XDG_STATE_HOME/herdr-envoy/logs/YYYY-MM-DD.jsonl\` (fallback
\`~/.local/state/herdr-envoy/logs/\`). Only UTC timestamps, job IDs, event/reason codes, generation,
disposition and HTTP status are recorded, never text, paths or tokens. Keep today and the previous
29 UTC dates, with a soft 8 MiB daily append cap allowing concurrent overshoot. Reconciliation
failure logs are limited to once per minute per job per process. Logging failures do not block
operations, and historical events are not backfilled.

Handover review: ${HANDOVER_REVIEW}

Call the chosen creation tool and tell the user it's running. For bounded completion, review it
and report the outcome. Handling the follow-up depends on the note:
- **blocked** (the delegate asked a question): answer it with the \`reply_delegate\` tool — this
  unblocks the delegate so it can finish.
- **rejected report / failure / stalled / startup timeout**: inspect the job before deciding on
  cleanup or a new delegation. A startup timeout only notifies; it does not kill the delegate.
- **completed**: review the deliverable and report the outcome. Code changes still require
  check evidence and user approval for merge, not automatic reruns. Completion is terminal; follow-up work needs a new job.

Interactive peers expose \`read_task\` and \`hand_back\`, never \`complete\` or \`ask\`.
When the active task is finished with nothing to commit, automatically call \`hand_back\` with
disposition \`completed\`, including the deliverable in summary, checks and risks. Do not ask for
confirmation or invent a userInstruction. Verify no task changes need committing. A clean checkout
or idle agent alone is not completion. Respect an explicit instruction to keep the session open.
Pause, commit and discard require explicit user direction:
- "hand this back" with finished work and nothing to commit means \`completed\` directly.
- \`completed\` is terminal. Review and report the deliverable. No automatic commit or cleanup.
  Follow-up work needs a new job. A completed owned checkout is eligible for ordinary cleanup.
- "done for now" means \`pause\`: preserve conversation, pane/workspace, worktree, branch and metadata.
- "hand this back" with changes to commit means \`commit\`: the ORCHESTRATOR reviews scope, diff and peer evidence, then commits in
  that checkout BEFORE reaping. The peer does not commit merely because it hands back.
- "discard this" means \`discard\`: record a request, then obtain explicit destructive user
  confirmation in the orchestrator. The request alone does not authorise removal.

Explicit \`hand_back\` may move paused work to completed/commit/discard without resuming. Same-disposition
retries preserve the original report even with a different summary. Completed/commit/discard cannot
transition through \`hand_back\`; only explicit orchestrator resume can reopen commit-ready work.
Coordinator operations and \`hand_back\` share per-session locks.

Use \`reap_delegate\` only when eligible. Active or paused interactive sessions cannot be ordinarily
reaped. Ordinary cleanup closes the pane or owned child workspace BEFORE non-force Git cleanup.
Never close the parent workspace. Errors retain tracked state for retry. Optional \`deleteBranch\`
defaults to false and uses \`git branch -d\`, not \`-D\`; preserve work if Git refuses.
\`discard\` defaults to false. Force removal requires a discard-requested interactive session,
\`discard: true\` and \`confirmation\` equal to its EXACT FULL job ID after the user's explicit
destructive confirmation. Never use this for a bounded, active or paused job. Reply/reap/resume
and listing are caller-scoped. A failed review, check or commit must not trigger cleanup.
Uncertain creation cleanup reconciles herdr/Git inventories, including an older wrong-parent
repository. Clear uncertainty only with proof of no checkout, workspace, branch or attempted
launch. Surviving resources or inconclusive inventories keep cleanup refused for inspection.

For fan-out, call \`delegate\` multiple times (distinct branches) and reconcile as each completes.`,
};
