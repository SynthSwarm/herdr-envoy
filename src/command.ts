// command.ts — the coordinator `/delegate` command shipped WITH the plugin.
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
- The \`delegate\` tool returns immediately. Completion is surfaced back to you
  asynchronously (a note is appended to your prompt) — do not block waiting on it.
- The coordinator (this session) auto-verifies the result and, for code-change jobs under
  \`auto-after-checks\`, auto-merges into the target branch.

Before calling \`delegate\`, resolve these arguments:
- \`agent\`: which of the USER'S OWN agents should do this (ask if unclear — do not invent one).
- \`task\`: complete, self-contained instructions (the delegate starts with no context).
- \`repo\`: absolute path to the repository.
- \`branch\`: a fresh branch name, e.g. \`delegate/<short-slug>\`.
- \`outputContract\`: \`advisory\` (analysis/answer, no commits) or \`code-change\` (commits).
- For \`code-change\`: also set \`targetBranch\`, \`baseCommit\`, and \`mergePolicy\`
  (\`manual\` to require your approval, or \`auto-after-checks\` to merge when declared checks pass).

Then call \`delegate\` and tell the user it's running. When the completion note arrives, review
it, report the outcome, and — for held/failed/blocked jobs — use \`reap_delegate\` to clean up or
answer the delegate's question. For fan-out, call \`delegate\` multiple times and reconcile as
each completes.`,
};
