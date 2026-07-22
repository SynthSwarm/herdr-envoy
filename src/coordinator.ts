// coordinator.ts — coordinator-role behavior (spec §2, §6, §12, §13).
// Exposes a `delegate` tool; watches job-dirs via fs.watch and ENQUEUES events
// (result/block) so the coordinator never blocks the user. Merge/verify land in
// a later slice; this slice reproduces the cleared trial: spawn -> watch -> report.
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { tool } from "@opencode-ai/plugin";
const z = tool.schema;
import type { PluginInput } from "@opencode-ai/plugin";
type Shell = PluginInput["$"];
type Client = PluginInput["client"];
import {
  PROTOCOL_VERSION,
  JOBDIR_ENV,
  FILES,
  atomicWriteJSON,
  exists,
  jobDir,
  rand,
  readJSON,
  type Consumed,
  type Handoff,
  type Result,
} from "./protocol.js";
import { verify, synthMerge } from "./verify.js";

export interface QueuedEvent {
  kind: "result" | "block" | "startup-timeout" | "stalled";
  jobId: string;
  at: number;
  payload?: unknown;
}

// One coordinator per opencode process. Holds the async event queue + watchers.
export class Coordinator {
  private queue: QueuedEvent[] = [];
  private watchers = new Map<string, FSWatcher>();
  private jobs = new Map<string, { agent: string; pane?: string; worktree: string; branch: string; repo: string; consumed?: Consumed; reaped?: boolean }>();
  // The coordinator's own opencode session id, learned from session.idle events.
  // Used to enqueue completion/block notes into opencode's native prompt QUEUE
  // (session.promptAsync) instead of force-injecting into the TUI text box.
  private sessionId: string | null = null;

  constructor(private $: Shell, private client: Client) {}

  setSessionId(id: string) {
    this.sessionId = id;
  }

  enqueue(ev: QueuedEvent) {
    this.queue.push(ev);
  }

  // Drained by the plugin at safe points (between turns). Non-blocking; returns
  // and clears whatever has accumulated.
  drain(): QueuedEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  pending(): number {
    return this.queue.length;
  }

  // Surface a drained event to the coordinator non-blockingly. For results,
  // auto-verify (§5/§6) and — under auto-after-checks — synthetic-merge (§7)
  // before surfacing, so the coordinator agent gets an already-adjudicated note.
  async surface(ev: QueuedEvent): Promise<void> {
    const short = ev.jobId.slice(0, 8);
    let toast = "";
    let note = "";
    if (ev.kind === "result") {
      const r = ev.payload as Result;
      const job = this.jobs.get(ev.jobId);
      const consumed = await this.loadConsumed(ev.jobId);

      let adjudication = "";
      let verifyOk = true;
      let merged = false;
      if (consumed) {
        const v = await verify(this.$, r, consumed, job?.worktree);
        if (!v.ok) {
          verifyOk = false;
          adjudication = ` VERIFY FAILED: ${v.reason}. Do not merge.`;
        } else if (r.outputContract === "code-change" && r.status === "success") {
          adjudication = ` verified (${v.commits} commit(s)).`;
          const policy = consumed.mergePolicy;
          const target = consumed.targetBranch;
          if (policy === "auto-after-checks" && job && target) {
            const m = await synthMerge(this.$, job.repo, r.branch!, target, consumed.checks ?? []);
            if (m.ok) {
              merged = true;
              adjudication += ` MERGED into ${target} @ ${m.mergeCommit!.slice(0, 8)} (checks passed).`;
            } else {
              adjudication += ` MERGE HELD: ${m.reason}.`;
            }
          } else {
            adjudication += ` mergePolicy=${policy}; awaiting your authorization to merge into ${target}.`;
          }
        } else {
          adjudication = ` (${r.outputContract}, trusted).`;
        }
      }

      toast = `delegate ${short}: ${r.status}`;
      note =
        `[peer-delegate] job ${short} completed (${r.status}, ${r.outputContract}).` +
        adjudication +
        ` Summary: ${r.summary}`;
      // acknowledge: delete result.json (§6 — chat note is the retained record).
      try {
        await fs.unlink(path.join(jobDir(ev.jobId), FILES.result));
      } catch {
        /* best-effort */
      }

      // Auto-reap: clean up pane + worktree + orphan workspace + job-dir once the
      // job is done. Keep the pane (and don't delete the branch) if verification
      // failed OR a code-change wasn't merged, so you can inspect/retry. Advisory
      // and merged code-change reap fully, deleting the now-merged branch.
      const cleanClose = verifyOk && (r.outputContract !== "code-change" || merged || r.status !== "success");
      if (cleanClose) {
        note += ` [reaped: pane closed, worktree + workspace removed]`;
        await this.reap(ev.jobId, { deleteBranch: merged });
      } else {
        note += ` [kept: pane + worktree retained for inspection — reap manually when done]`;
      }
    } else if (ev.kind === "block") {
      let question = "";
      try {
        const b = await readJSON<{ question: string }>(path.join(jobDir(ev.jobId), FILES.block));
        question = b.question;
      } catch {
        /* block may have been consumed already */
      }
      toast = `delegate ${short}: BLOCKED`;
      note =
        `[peer-delegate] job ${short} is blocked and asks:\n"${question}"\n` +
        `Reply with the peer-delegate reply mechanism (coordinator.reply) to unblock it.`;
    } else if (ev.kind === "stalled") {
      toast = `delegate ${short}: STALLED`;
      note =
        `[peer-delegate] job ${short} appears STALLED — no heartbeat for >30s and no result ` +
        `(delegate may have crashed or hung). Read its pane; reap_delegate to clean up, or ` +
        `restart the job.`;
    } else {
      toast = `delegate ${short}: startup timeout`;
      note = `[peer-delegate] job ${short} failed to start within its timeout.`;
    }
    try {
      await this.client.tui.showToast({ body: { message: toast, variant: ev.kind === "result" ? "success" : "warning" } } as any);
    } catch {
      /* toast is best-effort */
    }
    // Deliver the note into opencode's native prompt QUEUE (runs when the current
    // turn finishes) rather than injecting into the TUI text box where the user
    // may be typing. Falls back to appendPrompt only if the session id is unknown.
    let queued = false;
    if (this.sessionId) {
      try {
        await this.client.session.promptAsync({
          path: { id: this.sessionId },
          body: { parts: [{ type: "text", text: note }] },
        } as any);
        queued = true;
      } catch {
        /* fall through to appendPrompt */
      }
    }
    if (!queued) {
      try {
        await this.client.tui.appendPrompt({ body: { text: note } } as any);
      } catch {
        /* appendPrompt is best-effort */
      }
    }
  }

  // Resolve a full jobId from a full id or its 8-char short prefix.
  resolveJobId(idOrPrefix: string): string | undefined {
    if (this.jobs.has(idOrPrefix)) return idOrPrefix;
    for (const id of this.jobs.keys()) {
      if (id.startsWith(idOrPrefix)) return id;
    }
    return undefined;
  }

  private async loadConsumed(jobId: string): Promise<Consumed | null> {
    const job = this.jobs.get(jobId);
    if (job?.consumed) return job.consumed;
    const p = path.join(jobDir(jobId), FILES.consumed);
    if (!(await exists(p))) return null;
    const c = await readJSON<Consumed>(p);
    if (job) job.consumed = c;
    return c;
  }

  // Answer a blocked delegate: write reply.json (watched + consumed by the
  // delegate). The delegate removes block.json + reply.json on read.
  async reply(jobId: string, answer: string): Promise<void> {
    const consumed = await this.loadConsumed(jobId);
    if (!consumed) throw new Error(`peer-delegate: no job ${jobId.slice(0, 8)}`);
    await atomicWriteJSON(path.join(jobDir(jobId), FILES.reply), {
      protocolVersion: PROTOCOL_VERSION,
      jobId,
      generation: consumed.generation,
      answer,
      at: Date.now(),
    });
  }

  // Reap a finished job: close the delegate pane, remove the git worktree, and
  // clear all in-memory state + the job-dir. No herdr worktree/workspace calls —
  // the checkout is a plain `git worktree` we own. Idempotent; best-effort per
  // step so one failure doesn't strand the rest.
  async reap(jobId: string, opts: { deleteBranch?: boolean; keepPane?: boolean } = {}): Promise<void> {
    const $ = this.$;
    const job = this.jobs.get(jobId);

    // stop watching + cancel any startup timer first
    const w = this.watchers.get(jobId);
    if (w) {
      w.close();
      this.watchers.delete(jobId);
    }
    const t = this.startupTimers.get(jobId);
    if (t) {
      clearTimeout(t);
      this.startupTimers.delete(jobId);
    }
    const lv = this.livenessTimers.get(jobId);
    if (lv) {
      clearInterval(lv);
      this.livenessTimers.delete(jobId);
    }
    this.stalledFired.delete(jobId);
    this.seen.delete(jobId);

    if (job && !job.reaped) {
      job.reaped = true;
      // 1. close the delegate pane (unless caller wants it kept for inspection)
      if (job.pane && !opts.keepPane) {
        await $`herdr pane close ${job.pane}`.quiet().catch(() => {});
      }
      // 2. remove the git worktree we created, then prune
      await $`git -C ${job.repo} worktree remove --force ${job.worktree}`.quiet().catch(() => {});
      await $`git -C ${job.repo} worktree prune`.quiet().catch(() => {});
      // 3. optionally delete the delegate branch (only if merged/no longer needed)
      if (opts.deleteBranch && job.branch) {
        await $`git -C ${job.repo} branch -D ${job.branch}`.quiet().catch(() => {});
      }
    }

    // 4. clear the job-dir (all transport files) and forget the job
    await fs.rm(jobDir(jobId), { recursive: true, force: true }).catch(() => {});
    this.jobs.delete(jobId);
  }

  // Startup-timeout: if the delegate hasn't consumed the handoff (.consumed.json
  // present) within N seconds, treat as failed-to-start — stop the process,
  // enqueue an event, leave the pane open for inspection (spec §3).
  private startupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private armStartupTimeout(jobId: string, pane: string, seconds: number) {
    const t = setTimeout(async () => {
      this.startupTimers.delete(jobId);
      const consumedPath = path.join(jobDir(jobId), FILES.consumed);
      if (await exists(consumedPath)) return; // booted fine
      this.enqueue({ kind: "startup-timeout", jobId, at: Date.now() });
      try {
        // interrupt the pane's foreground process; leave the pane open.
        await this.$`herdr pane send-keys ${pane} C-c`.quiet();
      } catch {
        /* best-effort */
      }
    }, seconds * 1000);
    this.startupTimers.set(jobId, t);
  }

  // Mid-run liveness: after boot, poll the heartbeat file. If it goes stale past
  // `stallSeconds` (delegate crashed/hung) with no result yet, fire `stalled`
  // once (spec §13 — distinguish working from crashed). Leaves pane open.
  private livenessTimers = new Map<string, ReturnType<typeof setInterval>>();
  private stalledFired = new Set<string>();

  private armLiveness(jobId: string, stallSeconds = 30, pollMs = 10_000) {
    const timer = setInterval(async () => {
      const dir = jobDir(jobId);
      // not booted yet, or already finished/reaped → nothing to monitor
      if (!(await exists(path.join(dir, FILES.consumed)))) return;
      if (await exists(path.join(dir, FILES.result))) return;
      if (this.stalledFired.has(jobId)) return;
      const hb = path.join(dir, FILES.heartbeat);
      let ageMs = Infinity;
      try {
        const st = await stat(hb);
        ageMs = Date.now() - st.mtimeMs;
      } catch {
        // no heartbeat file yet: fall back to time since consume via .consumed mtime
        try {
          const st = await stat(path.join(dir, FILES.consumed));
          ageMs = Date.now() - st.mtimeMs;
        } catch {
          return;
        }
      }
      if (ageMs > stallSeconds * 1000) {
        this.stalledFired.add(jobId);
        this.enqueue({ kind: "stalled", jobId, at: Date.now() });
      }
    }, pollMs);
    (timer as any).unref?.();
    this.livenessTimers.set(jobId, timer);
  }

  // Watch a job-dir. NOTE: atomic temp+rename makes fs.watch report the TEMP
  // filename on the rename, not the canonical name — so we ignore the reported
  // filename and re-scan the dir for canonical files on every event (debounced).
  private seen = new Map<string, Set<string>>();

  private watchJob(jobId: string) {
    if (this.watchers.has(jobId)) return;
    const dir = jobDir(jobId);
    this.seen.set(jobId, new Set());
    let pendingScan = false;
    const scan = async () => {
      if (pendingScan) return;
      pendingScan = true;
      await new Promise((r) => setTimeout(r, 50)); // debounce/settle
      pendingScan = false;
      const seen = this.seen.get(jobId)!;

      // consumed → cancel startup timeout (once)
      if (!seen.has("consumed") && (await exists(path.join(dir, FILES.consumed)))) {
        seen.add("consumed");
        const t = this.startupTimers.get(jobId);
        if (t) {
          clearTimeout(t);
          this.startupTimers.delete(jobId);
        }
      }
      // result → enqueue (once)
      if (!seen.has("result") && (await exists(path.join(dir, FILES.result)))) {
        seen.add("result");
        // job finished — stop the liveness monitor
        const lv = this.livenessTimers.get(jobId);
        if (lv) {
          clearInterval(lv);
          this.livenessTimers.delete(jobId);
        }
        try {
          const payload = await readJSON<Result>(path.join(dir, FILES.result));
          this.enqueue({ kind: "result", jobId, at: Date.now(), payload });
        } catch {
          seen.delete("result"); // partial; retry on next event
        }
      }
      // block → enqueue each time a new block appears (delegate removes it on reply)
      if (await exists(path.join(dir, FILES.block))) {
        if (!seen.has("block")) {
          seen.add("block");
          this.enqueue({ kind: "block", jobId, at: Date.now() });
        }
      } else {
        seen.delete("block"); // block consumed; allow the next one
      }
    };
    const w = watch(dir, () => void scan());
    this.watchers.set(jobId, w);
    void scan(); // initial scan in case files already exist
  }

  async createJob(input: {
    agent: string;
    task: string;
    repo: string;
    outputContract: "advisory" | "code-change";
    targetBranch?: string;
    baseCommit?: string;
    mergePolicy?: "manual" | "auto-after-checks";
    checks?: { command: string; expectedExitCode: number }[];
    startupTimeoutSeconds?: number;
  }): Promise<{ jobId: string; jobDir: string }> {
    const jobId = rand();
    const dir = jobDir(jobId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);

    const handoff: Handoff = {
      protocolVersion: PROTOCOL_VERSION,
      jobId,
      generation: 1,
      completionToken: rand(),
      agent: input.agent,
      task: input.task,
      outputContract: input.outputContract,
      targetBranch: input.targetBranch ?? "",
      baseCommit: input.baseCommit ?? "",
      mergePolicy: input.mergePolicy ?? "auto-after-checks",
      checks: input.checks ?? [],
      startupTimeoutSeconds: input.startupTimeoutSeconds ?? 30,
    };
    await atomicWriteJSON(path.join(dir, FILES.handoff), handoff);
    return { jobId, jobDir: dir };
  }

  // Validate that the requested opencode agent actually exists (in the target
  // repo's scope) BEFORE we create worktrees/panes — otherwise the delegate pane
  // boots into an error and strands a worktree. `opencode agent list` prints one
  // agent per line as "<name> (<kind>)"; we match the leading token.
  async assertAgentExists(agent: string, repo: string): Promise<void> {
    let listing: string;
    try {
      listing = await this.$`opencode agent list`.cwd(repo).text();
    } catch (e) {
      throw new Error(`peer-delegate: could not list opencode agents in ${repo}: ${(e as Error).message ?? e}`);
    }
    const names = new Set<string>();
    for (const line of listing.split("\n")) {
      const m = /^(\S+)\s+\((primary|subagent)\)\s*$/.exec(line.trim());
      if (m) names.add(m[1]);
    }
    if (!names.has(agent)) {
      const available = [...names].sort().join(", ") || "(none found)";
      throw new Error(`peer-delegate: agent '${agent}' not found. Available agents: ${available}.`);
    }
  }

  // Pick which pane to split and in which direction so the workspace stays
  // balanced as delegates accumulate. Reads the current workspace layout, finds
  // the pane with the largest area, and splits it along its longer axis:
  //   width >= height  -> "right" (carve a new column)
  //   height >  width   -> "down"  (carve a new row)
  // Falls back to splitting the current pane "right" if the layout is unreadable.
  async chooseSplitTarget(currentPane: string): Promise<{ targetPane: string; direction: "right" | "down" }> {
    try {
      const raw = await this.$`herdr pane layout --pane ${currentPane}`.text();
      const layout = JSON.parse(raw)?.result?.layout;
      const panes: Array<{ pane_id: string; rect: { width: number; height: number } }> = layout?.panes ?? [];
      if (!panes.length) return { targetPane: currentPane, direction: "right" };
      let best = panes[0];
      let bestArea = best.rect.width * best.rect.height;
      for (const p of panes) {
        const area = p.rect.width * p.rect.height;
        if (area > bestArea) {
          best = p;
          bestArea = area;
        }
      }
      // Terminal cells are ~2x taller than wide; weight width so a "square-looking"
      // pane in cells is actually wider on screen and splits into columns.
      const direction: "right" | "down" = best.rect.width >= best.rect.height ? "right" : "down";
      return { targetPane: best.pane_id, direction };
    } catch {
      return { targetPane: currentPane, direction: "right" };
    }
  }

  // Create worktree, split a pane in the current herdr workspace, boot the agent
  // with JOBDIR_ENV set so its plugin activates the delegate role.
  async spawnDelegate(jobId: string, input: { agent: string; repo: string; branch: string; task: string; outputContract: "advisory" | "code-change"; startupTimeoutSeconds?: number }): Promise<{ pane: string; worktree: string }> {
    const $ = this.$;
    // Fail fast if the agent doesn't exist (before any worktree/pane creation).
    await this.assertAgentExists(input.agent, input.repo);
    // Plain `git worktree add` — NOT `herdr worktree create` (which spins up an
    // orphan herdr workspace we'd have to clean up separately). We manage the
    // checkout ourselves under <repo>/.herdr-envoy/worktrees and split into the
    // CURRENT herdr workspace. No herdr worktree/workspace involvement.
    const wtRoot = `${input.repo}/.herdr-envoy/worktrees`;
    const worktree = `${wtRoot}/${input.branch.replace(/\//g, "-")}`;
    await $`mkdir -p ${wtRoot}`.quiet();
    const wtList = await $`git -C ${input.repo} worktree list --porcelain`.text();
    if (!wtList.includes(worktree)) {
      const branchExists = await $`git -C ${input.repo} rev-parse --verify --quiet ${`refs/heads/${input.branch}`}`
        .then(() => true)
        .catch(() => false);
      if (branchExists) {
        await $`git -C ${input.repo} worktree add --quiet ${worktree} ${input.branch}`.quiet();
      } else {
        await $`git -C ${input.repo} worktree add --quiet -b ${input.branch} ${worktree}`.quiet();
      }
    }

    const pane = process.env.HERDR_PANE_ID;
    if (!pane) throw new Error("peer-delegate: HERDR_PANE_ID missing (not in a herdr session)");
    // Balance the workspace: instead of always halving the CURRENT pane (which
    // shrinks every subsequent delegate), analyze the layout, pick the pane with
    // the most screen area, and split it along its LONGER axis (wide -> right,
    // tall -> down). This spreads delegates evenly across the workspace.
    const { targetPane, direction } = await this.chooseSplitTarget(pane);
    const splitJson = await $`herdr pane split ${targetPane} --direction ${direction} --ratio 0.5 --cwd ${worktree} --no-focus --env ${`${JOBDIR_ENV}=${jobDir(jobId)}`}`.text();
    const newPane: string = JSON.parse(splitJson).result.pane.pane_id;

    // Boot race (learned in trial): `pane run` blasts the command as keystrokes.
    // If the interactive shell (zsh + direnv hook) hasn't finished initializing,
    // the command gets mangled/echoed and opencode never launches ("agent never
    // starts"). A fixed sleep is unreliable — direnv timing varies. Instead wait
    // for the shell prompt to actually render (the cwd basename shows in the
    // prompt) before running anything.
    const cwdMarker = path.basename(worktree);
    // If the worktree carries a .envrc, authorize it FIRST so the shell's direnv
    // hook loads (not prompts) and settles before we launch opencode.
    if (await exists(path.join(worktree, ".envrc"))) {
      await $`direnv allow ${worktree}`.quiet().catch(() => {});
    }
    await this.waitForShellReady(newPane, cwdMarker);
    // Task delivery rides in on the launch command: `opencode --prompt <task>`
    // starts the first turn automatically (verified in trial). This replaces the
    // old, racy post-boot keystroke injection (herdr agent send) entirely — a
    // fresh TUI has no session to inject into until a turn starts, so launching
    // WITH the prompt is the only reliable bootstrap.
    // --auto: delegates are trusted same-user peers; auto-approve permissions so
    // the agent can write to its worktree + the job-dir without a blocking prompt
    // (finding §11a.6).
    const brief =
      `You are a delegated peer worker. Your task:\n\n${input.task}\n\n` +
      `Work in this worktree. When done, call the \`complete\` tool with status and a one-sentence summary` +
      (input.outputContract === "code-change"
        ? `, plus branch, baseCommit and headCommit for your commit.`
        : `.`);
    // `herdr pane run` executes the string in the pane's shell, so the whole
    // opencode invocation must be ONE shell-safe command. Single-quote the brief
    // and escape any embedded single-quotes ('\'') so arbitrary task text is safe.
    const safeBrief = `'${brief.replace(/'/g, `'\\''`)}'`;
    const launchCmd = `opencode --agent ${input.agent} --auto --prompt ${safeBrief}`;
    await $`herdr pane run ${newPane} ${launchCmd}`.quiet();
    await $`herdr pane rename ${newPane} ${`${input.agent}-delegate`}`.quiet();

    this.jobs.set(jobId, { agent: input.agent, pane: newPane, worktree, branch: input.branch, repo: input.repo });
    this.watchJob(jobId);
    this.armStartupTimeout(jobId, newPane, input.startupTimeoutSeconds ?? 30);
    this.armLiveness(jobId);

    return { pane: newPane, worktree };
  }

  // Wait until the pane's interactive shell has rendered its prompt (the cwd
  // basename appears in the prompt line). Proves the shell + direnv hook finished
  // so a following `pane run` won't race a still-initializing shell. Best-effort:
  // falls back to a short fixed delay if the marker never shows.
  private async waitForShellReady(pane: string, cwdMarker: string): Promise<void> {
    try {
      await this.$`herdr wait output ${pane} --match ${cwdMarker} --timeout 10000`.quiet();
    } catch {
      // Marker never matched (unusual prompt); settle briefly rather than blast.
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  dispose() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.startupTimers.values()) clearTimeout(t);
    this.startupTimers.clear();
    for (const lv of this.livenessTimers.values()) clearInterval(lv);
    this.livenessTimers.clear();
  }
}

// The `delegate` tool exposed to the coordinator agent.
export function delegateTool(coord: Coordinator) {
  return tool({
    description:
      "Delegate a bounded task to a real peer opencode agent running in its own git worktree, " +
      "spawned as a split pane. Returns immediately; completion is reported asynchronously.",
    args: {
      agent: z.string().describe("opencode agent name to run as the delegate (e.g. worker)."),
      task: z.string().describe("Complete task instructions (this is the ephemeral brief)."),
      repo: z.string().describe("Absolute path to the source repository."),
      branch: z.string().describe("Branch name for the delegate's worktree, e.g. delegate/foo."),
      outputContract: z.enum(["advisory", "code-change"]).default("advisory"),
      targetBranch: z.string().optional(),
      baseCommit: z.string().optional(),
      mergePolicy: z.enum(["manual", "auto-after-checks"]).optional(),
      startupTimeoutSeconds: z.number().optional(),
    },
    async execute(args) {
      const { jobId } = await coord.createJob({
        agent: args.agent,
        task: args.task,
        repo: args.repo,
        outputContract: args.outputContract,
        targetBranch: args.targetBranch,
        baseCommit: args.baseCommit,
        mergePolicy: args.mergePolicy,
      });
      const { pane, worktree } = await coord.spawnDelegate(jobId, {
        agent: args.agent,
        repo: args.repo,
        branch: args.branch,
        task: args.task,
        outputContract: args.outputContract,
        startupTimeoutSeconds: args.startupTimeoutSeconds,
      });
      return (
        `Delegated to ${args.agent} (job ${jobId.slice(0, 8)}) in pane ${pane}\n` +
        `worktree: ${worktree}\n` +
        `Watching for completion — result will be surfaced asynchronously.`
      );
    },
  });
}

// The `reap_delegate` tool: manually clean up a job's pane, worktree, orphan
// workspace and job-dir (for held/blocked/timed-out jobs the coordinator kept).
export function reapTool(coord: Coordinator) {
  return tool({
    description:
      "Clean up a delegate job: close its pane, remove its git worktree + the orphan herdr " +
      "workspace, and clear its job-dir. Use for jobs that were kept for inspection.",
    args: {
      jobId: z.string().describe("The job id (full or the 8-char short prefix shown in notes)."),
      deleteBranch: z.boolean().default(false).describe("Also delete the delegate branch."),
    },
    async execute(args) {
      const jobId = coord.resolveJobId(args.jobId);
      if (!jobId) return `No tracked job matching '${args.jobId}'.`;
      await coord.reap(jobId, { deleteBranch: args.deleteBranch });
      return `Reaped job ${jobId.slice(0, 8)}: pane closed, worktree + workspace removed.`;
    },
  });
}
