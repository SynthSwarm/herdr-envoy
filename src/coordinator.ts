// coordinator.ts — coordinator-role behavior (spec §2, §6, §12, §13).
// Filesystem watches are wake hints. Persisted jobs are reconciled after restart
// and periodically, so a missed watch event cannot lose a completion.
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
  root,
  type Consumed,
  type Handoff,
  type Result,
} from "./protocol.js";
import { verify } from "./verify.js";

interface Job {
  jobId: string;
  directory: string;
  coordinatorPane: string;
  sessionID: string;
  agent: string;
  pane?: string;
  worktree: string;
  branch: string;
  repo: string;
  baseCommit: string;
  createdAt: number;
  startupTimeoutSeconds: number;
  phase: "starting" | "running" | "cleanup";
  worktreeCreated?: boolean;
  branchCreated?: boolean;
  deleteBranch?: boolean;
  delivered: string[];
  pending?: { key: string; messageID: string; text: string; attemptedAt?: number };
  consumed?: Consumed;
}

export class Coordinator {
  private watchers = new Map<string, FSWatcher>();
  private jobs = new Map<string, Job>();
  private scans = new Map<string, Promise<void>>();
  private cleanups = new Map<string, Promise<void>>();
  private messageClock = 0n;
  private disposed = false;
  private reconcileTimer?: ReturnType<typeof setInterval>;

  constructor(private $: Shell, private client: Client, private directory: string) {}

  private async save(job: Job) {
    // Auth stays in .consumed.json, not coordinator metadata.
    const { consumed, ...metadata } = job;
    await atomicWriteJSON(path.join(jobDir(job.jobId), FILES.coordinator), metadata);
  }

  async recover(): Promise<void> {
    const entries = await fs.readdir(root(), { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
      const metadata = path.join(jobDir(entry.name), FILES.coordinator);
      if (!(await exists(metadata))) continue; // Legacy jobs have no safe session owner.
      try {
        const job = await readJSON<Job>(metadata);
        if (job.directory !== this.directory || job.coordinatorPane !== process.env.HERDR_PANE_ID) continue;
        if (job.jobId !== entry.name || !job.sessionID || !Array.isArray(job.delivered)) {
          throw new Error("invalid coordinator metadata");
        }
        this.jobs.set(job.jobId, job);
        this.watchJob(job.jobId);
      } catch (error) {
        console.error(`herdr-envoy: cannot recover ${entry.name}:`, error);
      }
    }
    this.reconcileTimer ??= setInterval(() => {
      for (const id of this.jobs.keys()) void this.reconcile(id);
    }, 2000);
    this.reconcileTimer.unref();
  }

  // A stable message ID lets read-back recover an accepted request whose response
  // was lost. Never redirect to another session or an unsubmitted TUI prompt.
  private async promptSelf(jobId: string, key: string, text: string): Promise<void> {
    const job = this.jobs.get(jobId)!;
    if (job.delivered.includes(key)) return;
    if (!job.pending) {
      job.pending = { key, text, messageID: this.messageID() };
      await this.save(job);
    }
    const pending = job.pending;
    const request = { path: { id: job.sessionID, messageID: pending.messageID } };
    let receipt = await this.client.session.message({ ...request, signal: AbortSignal.timeout(15_000) });
    if (receipt.error && receipt.response.status !== 404) throw new Error(`message read-back failed: ${receipt.response.status}`);
    if (!receipt.data) {
      if (pending.attemptedAt && Date.now() - pending.attemptedAt < 10_000) return;
      const status = await this.client.session.status({ throwOnError: true, signal: AbortSignal.timeout(15_000) });
      if (status.data?.[job.sessionID]?.type !== undefined && status.data[job.sessionID].type !== "idle") return;
      // Deferred notifications must sort after the turn that just finished.
      if (!pending.attemptedAt) pending.messageID = this.messageID();
      request.path.messageID = pending.messageID;
      pending.attemptedAt = Date.now();
      await this.save(job);
      await this.client.session.promptAsync({
        path: { id: job.sessionID },
        body: { messageID: pending.messageID, parts: [{ type: "text", text: pending.text }] },
        throwOnError: true,
        signal: AbortSignal.timeout(15_000),
      });
      receipt = await this.client.session.message({ ...request, signal: AbortSignal.timeout(15_000) });
    }
    if (!receipt.data?.parts.some((part) => part.type === "text" && part.text === pending.text)) return;
    job.delivered.push(pending.key);
    job.pending = undefined;
    try {
      await this.save(job);
    } catch (error) {
      job.delivered.pop();
      job.pending = pending;
      throw error;
    }
  }

  private messageID(): string {
    // OpenCode 1.18 IDs pack milliseconds and a counter into six bytes.
    // https://github.com/anomalyco/opencode/blob/v1.18.4/packages/opencode/src/id/id.ts
    // Match its ordering so injected messages do not outrank all future prompts.
    const now = BigInt(Date.now()) * 0x1000n;
    this.messageClock = now > this.messageClock ? now : this.messageClock + 1n;
    return `msg_${(this.messageClock & 0xffffffffffffn).toString(16).padStart(12, "0")}${rand().slice(0, 14)}`;
  }


  // Validate the report before delivery. Merging and cleanup remain explicit.
  async notifyResult(jobId: string, r: Result): Promise<void> {
    const short = jobId.slice(0, 8);
    const job = this.jobs.get(jobId);
    const consumed = await this.loadConsumed(jobId);

    try {
      await this.client.tui.showToast({ body: { message: `delegate ${short}: ${r.status}`, variant: "success" } } as any);
    } catch {
      /* toast best-effort */
    }

    if (!consumed) throw new Error("result arrived without consumed handoff");
    const validation = await verify(this.$, r, consumed, job?.worktree);
    if (!validation.ok) {
      await this.promptSelf(jobId, "result", `[peer-delegate] Job ${short}: report REJECTED (${validation.reason}). No merge performed. Inspect the job before cleanup.`);
      return;
    }
    if (r.outputContract === "code-change" && r.status === "success" && (r.branch !== job?.branch || r.baseCommit !== job?.baseCommit)) {
      await this.promptSelf(jobId, "result", `[peer-delegate] Job ${short}: report REJECTED (assigned branch/base mismatch). No merge performed.`);
      return;
    }
    const lines: string[] = [];
    lines.push(`[peer-delegate] Delegate job ${short} reported: ${r.status} (${r.outputContract}).`);
    lines.push(`Summary: ${r.summary}`);
    if (r.evidence?.length) lines.push(`Evidence:\n- ${r.evidence.join("\n- ")}`);
    if (r.risks?.length) lines.push(`Risks:\n- ${r.risks.join("\n- ")}`);
    if (r.followUps?.length) lines.push(`Follow-ups:\n- ${r.followUps.join("\n- ")}`);
    if (r.outputContract === "code-change") {
      lines.push(
        `Code-change details: branch=${r.branch ?? "?"} base=${r.baseCommit ?? "?"} head=${r.headCommit ?? "?"}` +
          (consumed?.targetBranch ? ` targetBranch=${consumed.targetBranch}` : ``) +
          (consumed?.mergePolicy ? ` mergePolicy=${consumed.mergePolicy}` : ``),
      );
    }
    if (job) {
      lines.push(`Delegate pane ${job.pane ?? "?"} is still OPEN; worktree: ${job.worktree}.`);
    }
    lines.push(
        `No merge or cleanup has been performed. Review the deliverable and run the required checks. ` +
         `Obtain user approval before merging code changes, then use \`reap_delegate\` (jobId ${short}) ` +
         `when the checkout is clean and no longer needed. Completion is terminal; use a new job for follow-up work. ` +
        `Report the outcome to the user.`,
    );
    await this.promptSelf(jobId, "result", lines.join("\n"));
  }

  // A delegate is blocked awaiting an answer (block.json present). Notify the
  // coordinator agent to answer via reply_delegate. Fired by the fs.watcher.
  async notifyBlock(jobId: string, key: string): Promise<void> {
    const short = jobId.slice(0, 8);
    let question = "";
    try {
      const b = await readJSON<{ question: string }>(path.join(jobDir(jobId), FILES.block));
      question = b.question;
    } catch {
      /* block may have been consumed already */
    }
    try {
      await this.client.tui.showToast({ body: { message: `delegate ${short}: BLOCKED`, variant: "warning" } } as any);
    } catch {
      /* toast best-effort */
    }
    await this.promptSelf(jobId, key,
      `[peer-delegate] Delegate job ${short} is BLOCKED and asks:\n"${question}"\n` +
        `Answer it with the \`reply_delegate\` tool (jobId ${short}) to unblock it.`,
    );
  }

  // Delegate appears stalled (no heartbeat, no result). Notify the agent.
  async notifyStalled(jobId: string): Promise<void> {
    const short = jobId.slice(0, 8);
    const job = this.jobs.get(jobId);
    try {
      await this.client.tui.showToast({ body: { message: `delegate ${short}: STALLED`, variant: "warning" } } as any);
    } catch {
      /* toast best-effort */
    }
    await this.promptSelf(jobId, "stalled",
      `[peer-delegate] Delegate job ${short} appears STALLED — no heartbeat for >30s and no result ` +
        `(it may have crashed or hung). Read its pane (${job?.pane ?? "?"}); \`reap_delegate\` (jobId ${short}) ` +
        `to clean up, or push a nudge via \`herdr pane run ${job?.pane ?? "<pane>"} ...\`.`,
    );
  }

  // Delegate failed to start within its timeout. Notify the agent.
  async notifyStartupTimeout(jobId: string): Promise<void> {
    const short = jobId.slice(0, 8);
    const job = this.jobs.get(jobId);
    try {
      await this.client.tui.showToast({ body: { message: `delegate ${short}: startup timeout`, variant: "warning" } } as any);
    } catch {
      /* toast best-effort */
    }
    await this.promptSelf(jobId, "startup-timeout",
      `[peer-delegate] Delegate job ${short} failed to start within its timeout. Read its pane ` +
        `(${job?.pane ?? "?"}); \`reap_delegate\` (jobId ${short}) to clean up and optionally re-delegate.`,
    );
  }


  // Resolve a full jobId from a full id or its 8-char short prefix.
  resolveJobId(idOrPrefix: string, sessionID?: string): string | undefined {
    const matches = [...this.jobs.keys()].filter((id) =>
      idOrPrefix.length >= 8 && id.startsWith(idOrPrefix) && (!sessionID || this.jobs.get(id)?.sessionID === sessionID));
    return matches.length === 1 ? matches[0] : undefined;
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

  // Persist each successful cleanup step. Stop on failure and retain the job.
  async reap(jobId: string, opts: { deleteBranch?: boolean; keepPane?: boolean } = {}): Promise<void> {
    const running = this.cleanups.get(jobId);
    if (running) return running;
    const cleanup = this.cleanup(jobId, opts).finally(() => this.cleanups.delete(jobId));
    this.cleanups.set(jobId, cleanup);
    return cleanup;
  }

  private async cleanup(jobId: string, opts: { deleteBranch?: boolean; keepPane?: boolean }): Promise<void> {
    const $ = this.$;
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (opts.keepPane) throw new Error("Cannot remove a checkout while retaining its delegate pane");
    job.phase = "cleanup";
    job.deleteBranch ||= opts.deleteBranch;
    await this.scans.get(jobId);
    await this.save(job);
    if (job.pane) {
      const panes = JSON.parse(await $`herdr pane list`.text()).result?.panes;
      if (!Array.isArray(panes)) throw new Error("Cannot establish whether delegate pane exists");
      if (panes.some((pane: { pane_id: string }) => pane.pane_id === job.pane)) {
        await $`herdr pane close ${job.pane}`.quiet();
      }
      job.pane = undefined;
      await this.save(job);
    }
    if (job.worktreeCreated) {
      // No --force: uncommitted or untracked work must survive cleanup.
      if (await exists(job.worktree)) await $`git -C ${job.repo} worktree remove ${job.worktree}`.quiet();
      await $`git -C ${job.repo} worktree prune`.quiet();
      job.worktreeCreated = false;
      await this.save(job);
    }
    if (job.deleteBranch && job.branchCreated) {
      const branches = (await $`git -C ${job.repo} for-each-ref --format=%(refname) refs/heads/`.text()).split("\n");
      if (branches.includes(`refs/heads/${job.branch}`)) await $`git -C ${job.repo} branch -d ${job.branch}`.quiet();
      job.branchCreated = false;
      await this.save(job);
    }
    await fs.rm(jobDir(jobId), { recursive: true, force: true });
    this.watchers.get(jobId)?.close();
    this.watchers.delete(jobId);
    this.jobs.delete(jobId);
  }

  // Watch events only accelerate the periodic scan, including atomic renames.
  private watchJob(jobId: string) {
    if (this.watchers.has(jobId)) return;
    try {
      const watcher = watch(jobDir(jobId), () => void this.reconcile(jobId));
      watcher.on("error", (error) => {
        console.error(`herdr-envoy: watch failed for ${jobId}:`, error);
        watcher.close();
        this.watchers.delete(jobId);
      });
      this.watchers.set(jobId, watcher);
    } catch (error) {
      console.error(`herdr-envoy: watch unavailable for ${jobId}, using reconciliation:`, error);
    }
    void this.reconcile(jobId);
  }

  async reconcile(jobId: string): Promise<void> {
    if (this.disposed) return;
    const existing = this.scans.get(jobId);
    if (existing) return existing;
    const scan = (async () => {
      const job = this.jobs.get(jobId);
      if (!job || job.phase === "cleanup") return;
      if (job.pending) {
        await this.promptSelf(jobId, job.pending.key, job.pending.text);
        if (job.pending) return;
      }
      const dir = jobDir(jobId);
      if (await exists(path.join(dir, FILES.result))) {
        if (!job.delivered.includes("result")) await this.notifyResult(jobId, await readJSON<Result>(path.join(dir, FILES.result)));
        return;
      }
      if (await exists(path.join(dir, FILES.block))) {
        const block = await readJSON<import("./protocol.js").Block>(path.join(dir, FILES.block));
        const consumed = await this.loadConsumed(jobId);
        if (!consumed || block.jobId !== jobId || block.generation !== consumed.generation || block.completionToken !== consumed.completionToken) throw new Error("invalid block identity");
        const key = `block:${block.at}`;
        if (!job.delivered.includes(key)) await this.notifyBlock(jobId, key);
        return;
      }
      if (!(await exists(path.join(dir, FILES.consumed)))) {
        if (Date.now() - job.createdAt > job.startupTimeoutSeconds * 1000 && !job.delivered.includes("startup-timeout")) await this.notifyStartupTimeout(jobId);
        return;
      }
      const heartbeat = await stat(path.join(dir, FILES.heartbeat)).catch(() => stat(path.join(dir, FILES.consumed)));
      if (Date.now() - heartbeat.mtimeMs > 30_000 && !job.delivered.includes("stalled")) await this.notifyStalled(jobId);
    })().catch((error) => {
      console.error(`herdr-envoy: reconciliation failed for ${jobId}, will retry:`, error);
    }).finally(() => this.scans.delete(jobId));
    this.scans.set(jobId, scan);
    return scan;
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
    sessionID: string;
    branch: string;
  }): Promise<{ jobId: string; jobDir: string }> {
    if (input.mergePolicy === "auto-after-checks") throw new Error("auto-after-checks is not implemented. Use manual and review/check the result before merging.");
    if (!process.env.HERDR_PANE_ID) throw new Error("peer-delegate: HERDR_PANE_ID missing (not in a herdr session)");
    if (!input.sessionID || !path.isAbsolute(input.repo)) throw new Error("A session owner and absolute repo path are required");
    await this.assertAgentExists(input.agent, input.repo);
    await this.$`git -C ${input.repo} check-ref-format --branch ${input.branch}`.quiet();
    const branchExists = await this.$`git -C ${input.repo} show-ref --verify --quiet ${`refs/heads/${input.branch}`}`.then(() => true).catch(() => false);
    if (branchExists) throw new Error(`Branch already exists: ${input.branch}. Use a fresh branch.`);
    const baseCommit = (await this.$`git -C ${input.repo} rev-parse --verify --end-of-options ${`${input.baseCommit ?? "HEAD"}^{commit}`}`.text()).trim();
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
      baseCommit,
      mergePolicy: "manual",
      checks: input.checks ?? [],
      startupTimeoutSeconds: input.startupTimeoutSeconds ?? 30,
    };
    await atomicWriteJSON(path.join(dir, FILES.handoff), handoff);
    const job: Job = {
      jobId, directory: this.directory, coordinatorPane: process.env.HERDR_PANE_ID, sessionID: input.sessionID,
      agent: input.agent, repo: input.repo, branch: input.branch, baseCommit,
      worktree: path.join(input.repo, ".herdr-envoy", "worktrees", jobId),
      createdAt: Date.now(), startupTimeoutSeconds: handoff.startupTimeoutSeconds,
      phase: "starting", delivered: [],
    };
    await this.save(job);
    this.jobs.set(jobId, job);
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
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);
    // Plain `git worktree add` — NOT `herdr worktree create` (which spins up an
    // orphan herdr workspace we'd have to clean up separately). We manage the
    // checkout ourselves under <repo>/.herdr-envoy/worktrees and split into the
    // CURRENT herdr workspace. No herdr worktree/workspace involvement.
    const pane = process.env.HERDR_PANE_ID;
    if (!pane) throw new Error("peer-delegate: HERDR_PANE_ID missing (not in a herdr session)");
    const worktree = job.worktree;
    try {
      await fs.mkdir(path.dirname(worktree), { recursive: true });
      await $`git -C ${job.repo} worktree add --quiet -b ${job.branch} ${worktree} ${job.baseCommit}`.quiet();
      job.worktreeCreated = true;
      job.branchCreated = true;
      await this.save(job);
      const { targetPane, direction } = await this.chooseSplitTarget(pane);
      const splitJson = await $`herdr pane split ${targetPane} --direction ${direction} --ratio 0.5 --cwd ${worktree} --no-focus --env ${`${JOBDIR_ENV}=${jobDir(jobId)}`}`.text();
      const newPane: string = JSON.parse(splitJson).result.pane.pane_id;
      job.pane = newPane;
      await this.save(job);

      // pane run sends keystrokes: wait for shell/direnv startup before launching.
      const cwdMarker = path.basename(worktree);
      if (await exists(path.join(worktree, ".envrc"))) {
        await $`direnv allow ${worktree}`.quiet().catch(() => {});
      }
      await this.waitForShellReady(newPane, cwdMarker);
      // The full task stays in the handoff, never on the shell command line.
      const bootPrompt =
        `Call the \`read_task\` tool now to get your task, then carry it out in this worktree. ` +
        `Call \`complete\` when done; call \`ask\` if you need a decision from the coordinator.`;
      const safePrompt = `'${bootPrompt.replace(/'/g, `'\\''`)}'`;
      const safeAgent = `'${input.agent.replace(/'/g, `'\\''`)}'`;
      const launchCmd = `opencode --agent ${safeAgent} --auto --prompt ${safePrompt}`;
      await $`herdr pane run ${newPane} ${launchCmd}`.quiet();
      await $`herdr pane rename ${newPane} ${`${input.agent}-delegate`}`.quiet();

      job.phase = "running";
      job.createdAt = Date.now();
      await this.save(job);
      this.watchJob(jobId);
      return { pane: newPane, worktree };
    } catch (error) {
      try {
        await this.reap(jobId, { deleteBranch: true });
      } catch (cleanupError) {
        throw new Error(`Job ${jobId} failed to launch: ${error}. Cleanup failed and remains tracked; retry reap_delegate: ${cleanupError}`);
      }
      throw error;
    }
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

  async dispose() {
    this.disposed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    await Promise.all(this.scans.values());
    await Promise.all(this.cleanups.values());
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
      outputContract: z
        .enum(["advisory", "code-change"])
        .default("advisory")
        .describe(
          "advisory = analysis/answer only, delegate makes NO commits; code-change = delegate commits to its branch."
        ),
      targetBranch: z
        .string()
        .optional()
        .describe("code-change only: the branch the delegate's result should merge into."),
      baseCommit: z
        .string()
        .optional()
        .describe("code-change only: the commit the delegate's worktree/branch is based on."),
      mergePolicy: z
        .enum(["manual", "auto-after-checks"])
        .optional()
        .describe(
          "Only manual is supported. auto-after-checks is rejected until automatic merging is implemented."
        ),
      startupTimeoutSeconds: z
        .number()
        .positive()
        .finite()
        .optional()
        .describe("Seconds to wait for the delegate to boot before marking the job stalled."),
    },
    async execute(args, context) {
      const { jobId } = await coord.createJob({
        sessionID: context.sessionID,
        branch: args.branch,
        agent: args.agent,
        task: args.task,
        repo: args.repo,
        outputContract: args.outputContract,
        targetBranch: args.targetBranch,
        baseCommit: args.baseCommit,
        mergePolicy: args.mergePolicy,
        startupTimeoutSeconds: args.startupTimeoutSeconds,
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
       "Clean up a delegate job: close its pane, remove its clean git worktree and clear its job-dir. " +
       "Dirty worktrees are preserved. Failed cleanup remains tracked for retry.",
    args: {
      jobId: z.string().describe("The job id (full or the 8-char short prefix shown in notes)."),
      deleteBranch: z.boolean().default(false).describe("Also delete the delegate branch."),
    },
    async execute(args, context) {
      const jobId = coord.resolveJobId(args.jobId, context.sessionID);
      if (!jobId) return `No tracked job matching '${args.jobId}'.`;
      await coord.reap(jobId, { deleteBranch: args.deleteBranch });
      return `Reaped job ${jobId.slice(0, 8)}: pane closed, worktree and runtime state removed.`;
    },
  });
}

// The `reply_delegate` tool: answer a blocked delegate that called `ask`. Writes
// reply.json into the job-dir; the delegate is polling for it and unblocks on read.
export function replyTool(coord: Coordinator) {
  return tool({
    description:
      "Answer a blocked delegate that asked you a question (surfaced in a note). Unblocks the " +
      "delegate so it can continue its task.",
    args: {
      jobId: z.string().describe("The job id (full or the 8-char short prefix shown in the block note)."),
      answer: z.string().describe("Your answer to the delegate's question."),
    },
    async execute(args, context) {
      const jobId = coord.resolveJobId(args.jobId, context.sessionID);
      if (!jobId) return `No tracked job matching '${args.jobId}'.`;
      try {
        await coord.reply(jobId, args.answer);
      } catch (e) {
        return `Could not reply to job ${jobId.slice(0, 8)}: ${(e as Error).message}`;
      }
      return `Replied to job ${jobId.slice(0, 8)}; the delegate will unblock and continue.`;
    },
  });
}
