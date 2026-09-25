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
  sessionRoot,
  withSessionLock,
  SessionLockBusyError,
  type InteractiveSession,
  type Placement,
  type Consumed,
  type Handoff,
  type Result,
} from "./protocol.js";
import { verify } from "./verify.js";
import { lifecycle } from "./log.js";

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
  mode?: "interactive";
  name?: string;
  placement?: Placement;
  parentWorkspace?: string;
  workspace?: string;
  discard?: boolean;
  launchAttempted?: boolean;
  resourceUncertain?: boolean;
  resuming?: { generation: number; instructions?: string };
}

export class Coordinator {
  private watchers = new Map<string, FSWatcher>();
  private jobs = new Map<string, Job>();
  private scans = new Map<string, Promise<void>>();
  private cleanups = new Map<string, Promise<void>>();
  private resumes = new Map<string, Promise<string>>();
  private transactions = new Map<string, Promise<unknown>>();
  private messageClock = 0n;
  private deliveryLog = new Map<string, string>();
  private failureLog = new Map<string, number>();
  private disposed = false;
  private reconcileTimer?: ReturnType<typeof setInterval>;

  constructor(private $: Shell, private client: Client, private directory: string) {}

  private dir(jobId: string): string {
    return this.jobs.get(jobId)?.mode === "interactive" ? path.join(sessionRoot(), jobId) : jobDir(jobId);
  }

  private async save(job: Job) {
    // Auth stays in .consumed.json, not coordinator metadata.
    const { consumed, ...metadata } = job;
    const dir = job.mode === "interactive" ? path.join(sessionRoot(), job.jobId) : jobDir(job.jobId);
    await atomicWriteJSON(path.join(dir, FILES.coordinator), metadata);
  }

  private async exclusive<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    if (this.jobs.get(jobId)?.mode !== "interactive") return action();
    const previous = this.transactions.get(jobId) ?? Promise.resolve();
    const transaction = previous.catch(() => {}).then(() => this.locked(jobId, action));
    this.transactions.set(jobId, transaction);
    try { return await transaction; }
    finally { if (this.transactions.get(jobId) === transaction) this.transactions.delete(jobId); }
  }

  private async locked<T>(jobId: string, action: () => Promise<T>): Promise<T> {
    if (!this.jobs.has(jobId)) throw new Error("Session was removed by another operation");
    return withSessionLock(jobId, async () => {
      const metadata = await readJSON<Job>(path.join(this.dir(jobId), FILES.coordinator));
      this.jobs.set(jobId, metadata);
      return await action();
    });
  }

  async recover(): Promise<void> {
    for (const directory of [root(), sessionRoot()]) {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
        const metadata = path.join(directory, entry.name, FILES.coordinator);
        if (!(await exists(metadata))) continue; // Legacy jobs have no safe session owner.
        try {
          const job = await readJSON<Job>(metadata);
          if (job.directory !== this.directory || (job.mode !== "interactive" && job.coordinatorPane !== process.env.HERDR_PANE_ID)) continue;
          if ((job.mode === "interactive") !== (directory === sessionRoot())) continue;
          if (job.jobId !== entry.name || !job.sessionID || !Array.isArray(job.delivered)) {
            throw new Error("invalid coordinator metadata");
          }
          this.jobs.set(job.jobId, job);
          await lifecycle(job.jobId, "recovered");
          this.watchJob(job.jobId);
        } catch (error) {
          console.error(`herdr-envoy: cannot recover ${entry.name}:`, error);
        }
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
      await lifecycle(jobId, "notification_queued");
    }
    const pending = job.pending;
    const request = { path: { id: job.sessionID, messageID: pending.messageID } };
    let receipt = await this.client.session.message({ ...request, signal: AbortSignal.timeout(15_000) });
    if (receipt.error && receipt.response.status !== 404) {
      await this.logDelivery(jobId, "readback", receipt.response.status);
      throw new Error(`message read-back failed: ${receipt.response.status}`);
    }
    if (!receipt.data) {
      if (pending.attemptedAt && Date.now() - pending.attemptedAt < 10_000) return;
      const status = await this.client.session.status({ throwOnError: true, signal: AbortSignal.timeout(15_000) });
      if (status.data?.[job.sessionID]?.type !== undefined && status.data[job.sessionID].type !== "idle") {
        await this.logDelivery(jobId, "busy");
        return;
      }
      // Deferred notifications must sort after the turn that just finished.
      if (!pending.attemptedAt) pending.messageID = this.messageID();
      request.path.messageID = pending.messageID;
      pending.attemptedAt = Date.now();
      await this.save(job);
      await lifecycle(jobId, "notification_attempted");
      try {
        await this.client.session.promptAsync({
          path: { id: job.sessionID },
          body: { messageID: pending.messageID, parts: [{ type: "text", text: pending.text }] },
          throwOnError: true,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        await this.logDelivery(jobId, "transport");
        throw error;
      }
      receipt = await this.client.session.message({ ...request, signal: AbortSignal.timeout(15_000) });
    }
    if (!receipt.data?.parts.some((part) => part.type === "text" && part.text === pending.text)) {
      await this.logDelivery(jobId, "readback", receipt.response.status);
      return;
    }
    job.delivered.push(pending.key);
    job.pending = undefined;
    try {
      await this.save(job);
      this.deliveryLog.delete(jobId);
      await lifecycle(jobId, "notification_delivered");
    } catch (error) {
      job.delivered.pop();
      job.pending = pending;
      throw error;
    }
  }

  private async logDelivery(jobId: string, reason: "busy" | "readback" | "transport", httpStatus?: number) {
    const state = `${reason}:${httpStatus ?? ""}`;
    if (this.deliveryLog.get(jobId) === state) return;
    this.deliveryLog.set(jobId, state);
    await lifecycle(jobId, "notification_deferred", { reason, httpStatus });
  }

  // Explicit control operations supersede obsolete notes, not session state.
  // Keep the retired key durable so restart cannot resurrect a stale instruction.
  private async retireNotification(job: Job, reason: "resume" | "new_handback", key?: string) {
    if (job.pending) {
      if (!job.delivered.includes(job.pending.key)) job.delivered.push(job.pending.key);
      job.pending = undefined;
    }
    if (key && !job.delivered.includes(key)) job.delivered.push(key);
    await this.save(job);
    this.deliveryLog.delete(job.jobId);
    await lifecycle(job.jobId, "notification_superseded", { reason });
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
      const b = await readJSON<{ question: string }>(path.join(this.dir(jobId), FILES.block));
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

  private async readSession(job: Job): Promise<InteractiveSession> {
    const dir = this.dir(job.jobId);
    const session = await readJSON<InteractiveSession>(path.join(dir, FILES.session));
    const auth = await this.loadConsumed(job.jobId) ?? await readJSON<Handoff>(path.join(dir, FILES.handoff));
    if (session.protocolVersion !== PROTOCOL_VERSION || session.jobId !== job.jobId ||
        session.completionToken !== auth.completionToken || !Number.isSafeInteger(session.generation) ||
        session.generation < auth.generation || !["active", "paused", "commit", "discard"].includes(session.status)) {
      throw new Error("Invalid interactive session identity or state");
    }
    return session;
  }

  async listSessions(sessionID: string): Promise<string> {
    const sessions = [];
    for (const job of this.jobs.values()) {
      if (job.mode !== "interactive" || job.sessionID !== sessionID) continue;
      const state = await this.readSession(job);
      sessions.push({ jobId: job.jobId, name: job.name, status: state.status, phase: job.phase,
        placement: job.placement, worktree: job.worktree, branch: job.branch,
        pane: job.pane, workspace: job.workspace, sessionID: state.sessionID, summary: state.summary,
        generation: state.generation, checks: state.checks, risks: state.risks,
        notificationPending: Boolean(job.pending), notificationAttemptedAt: job.pending?.attemptedAt });
    }
    return JSON.stringify(sessions, null, 2);
  }

  async resolveSession(sessionID: string, id?: string): Promise<string> {
    if (id) {
      const match = this.resolveJobId(id, sessionID);
      if (match && this.jobs.get(match)?.mode === "interactive") return match;
      throw new Error("No uniquely matching session owned by this orchestrator");
    }
    const candidates = [];
    for (const job of this.jobs.values()) {
      if (job.mode === "interactive" && job.sessionID === sessionID && job.phase !== "cleanup" &&
          (await this.readSession(job)).status === "paused") candidates.push(job.jobId);
    }
    if (candidates.length !== 1) throw new Error("Specify a session ID: expected exactly one paused session");
    return candidates[0];
  }

  async resumeSession(jobId: string, instructions?: string): Promise<string> {
    const existing = this.resumes.get(jobId);
    if (existing) return existing;
    const resume = this.exclusive(jobId, () => this.resume(jobId, instructions)).catch(async (error) => {
      await lifecycle(jobId, "resume_failed", { reason: "state" });
      throw error;
    }).finally(() => this.resumes.delete(jobId));
    this.resumes.set(jobId, resume);
    return resume;
  }

  private async resume(jobId: string, instructions?: string): Promise<string> {
    const job = this.jobs.get(jobId);
    if (!job || job.mode !== "interactive" || job.phase === "cleanup") throw new Error("No resumable interactive session");
    const state = await this.readSession(job);
    if (!["paused", "commit"].includes(state.status) && !(job.resuming && state.status === "active")) {
      throw new Error(`Only paused or commit-ready sessions can be resumed; current state: ${state.status}`);
    }
    if (!state.sessionID) throw new Error("Saved conversation identity is missing; refusing to create a substitute");
    if (!(await exists(job.worktree))) throw new Error("Saved worktree is missing; refusing to create a substitute");
    const branch = (await this.$`git -C ${job.worktree} symbolic-ref --short HEAD`.text()).trim();
    if (branch !== job.branch) throw new Error("Saved worktree branch has changed");
    const conversation = await this.client.session.get({ path: { id: state.sessionID }, query: { directory: job.worktree }, throwOnError: true });
    if (conversation.data?.id !== state.sessionID || conversation.data.directory !== job.worktree) throw new Error("Saved conversation does not belong to this worktree");
    const panes = JSON.parse(await this.$`herdr pane list`.text()).result?.panes;
    if (!Array.isArray(panes)) throw new Error("Cannot inspect existing panes");
    const pane = panes.find((p: { pane_id: string }) => p.pane_id === job.pane);
    if (pane && (pane.agent !== "opencode" || pane.agent_session?.value !== state.sessionID || pane.agent_status === "working")) {
      throw new Error("Saved pane is busy or its conversation identity cannot be verified. Close it before reopening the saved conversation.");
    }
    const resumed: InteractiveSession = { ...state, status: "active", handbackID: undefined, generation: job.resuming?.generation ?? state.generation + 1 };
    job.resuming = { generation: resumed.generation, instructions };
    await this.save(job);
    await this.retireNotification(job, "resume", state.handbackID ? `handback:${state.handbackID}` : undefined);
    await atomicWriteJSON(path.join(this.dir(jobId), FILES.session), resumed);
    await lifecycle(jobId, "resume_started", { generation: resumed.generation });
    const prompt = "Resume the saved interactive session. Call read_task to refresh control before continuing. " + (instructions ?? "Wait for the user's next instruction.");
    try {
      if (pane) {
        await this.$`herdr agent prompt ${job.pane!} ${prompt}`.quiet();
      } else {
        job.pane = undefined;
        await this.place(job, true);
        await this.launch(job, prompt, state.sessionID);
      }
      await this.save(job);
      job.resuming = undefined;
      await this.save(job);
    } catch (error) {
      const current = await this.readSession(job);
      if (current.status === "active" && current.generation === resumed.generation) {
        await atomicWriteJSON(path.join(this.dir(jobId), FILES.session), { ...current, status: "paused" });
      }
      job.resuming = undefined;
      await this.save(job);
      throw new Error(`Resume failed; work is preserved. Inspect the saved session before retrying: ${error}`);
    }
    await lifecycle(jobId, "resume_completed", { generation: resumed.generation });
    return `Resumed ${job.name} (${jobId}) in pane ${job.pane}. Worktree: ${job.worktree}\n` +
      `Previous hand-back (${state.status}, generation ${state.generation}): ${state.summary ?? "No summary"}\n` +
      `Checks: ${(state.checks ?? []).join("; ")}\nRisks: ${(state.risks ?? []).join("; ")}\n` +
      `The prior hand-back is superseded by this explicit resume. Do not commit or reap until a new hand-back.`;
  }

  private async loadConsumed(jobId: string): Promise<Consumed | null> {
    const job = this.jobs.get(jobId);
    if (job?.consumed) return job.consumed;
    const p = path.join(this.dir(jobId), FILES.consumed);
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
    await atomicWriteJSON(path.join(this.dir(jobId), FILES.reply), {
      protocolVersion: PROTOCOL_VERSION,
      jobId,
      generation: consumed.generation,
      answer,
      at: Date.now(),
    });
  }

  // Persist each successful cleanup step. Stop on failure and retain the job.
  async reap(jobId: string, opts: { deleteBranch?: boolean; keepPane?: boolean; discard?: boolean; confirmation?: string } = {}): Promise<void> {
    const running = this.cleanups.get(jobId);
    if (running) return running;
    const cleanup = this.exclusive(jobId, () => this.cleanup(jobId, opts)).catch(async (error) => {
      await lifecycle(jobId, "cleanup_failed", { reason: "state" });
      throw error;
    }).finally(() => this.cleanups.delete(jobId));
    this.cleanups.set(jobId, cleanup);
    return cleanup;
  }

  private async cleanup(jobId: string, opts: { deleteBranch?: boolean; keepPane?: boolean; discard?: boolean; confirmation?: string }): Promise<void> {
    const $ = this.$;
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (this.resumes.has(jobId)) throw new Error("Session is being resumed; retry cleanup afterwards");
    if (job.resourceUncertain) await this.reconcileCreation(job);
    if (opts.keepPane) throw new Error("Cannot remove a checkout while retaining its delegate pane");
    if (job.mode === "interactive" && (job.phase !== "starting" || job.launchAttempted)) {
      const session = await this.readSession(job);
      if (session.status === "active" || session.status === "paused") throw new Error("Active or paused sessions must be handed back before cleanup");
      if (session.status === "discard" && !job.discard && (!opts.discard || opts.confirmation !== jobId)) {
        throw new Error(`Confirm destructive discard with discard=true and confirmation=${jobId} only after user approval`);
      }
      if (opts.discard && session.status !== "discard") throw new Error("Session has not requested discard");
      job.discard ||= opts.discard;
    } else if (opts.discard) throw new Error("Discard requires an interactive discard request");
    job.phase = "cleanup";
    job.deleteBranch ||= opts.deleteBranch;
    if (job.mode !== "interactive") await this.scans.get(jobId);
    await this.save(job);
    await lifecycle(jobId, "cleanup_started");
    if (job.workspace) {
      const workspaces = JSON.parse(await $`herdr workspace list`.text()).result?.workspaces;
      if (!Array.isArray(workspaces)) throw new Error("Cannot establish whether delegate workspace exists");
      if (workspaces.some((workspace: { workspace_id: string }) => workspace.workspace_id === job.workspace)) {
        await $`herdr workspace close ${job.workspace}`.quiet();
      }
      job.workspace = undefined;
      job.pane = undefined;
      await this.save(job);
    } else if (job.pane) {
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
      if (await exists(job.worktree)) {
        if (job.discard) await $`git -C ${job.repo} worktree remove --force ${job.worktree}`.quiet();
        else await $`git -C ${job.repo} worktree remove ${job.worktree}`.quiet();
      }
      await $`git -C ${job.repo} worktree prune`.quiet();
      job.worktreeCreated = false;
      await this.save(job);
    }
    if (job.deleteBranch && job.branchCreated) {
      const branches = (await $`git -C ${job.repo} for-each-ref ${"--format=%(refname)"} refs/heads/`.text()).split("\n");
      if (branches.includes(`refs/heads/${job.branch}`)) {
        if (job.discard) await $`git -C ${job.repo} branch -D ${job.branch}`.quiet();
        else await $`git -C ${job.repo} branch -d ${job.branch}`.quiet();
      }
      job.branchCreated = false;
      await this.save(job);
    }
    await fs.rm(this.dir(jobId), { recursive: true, force: true });
    this.watchers.get(jobId)?.close();
    this.watchers.delete(jobId);
    this.jobs.delete(jobId);
    this.deliveryLog.delete(jobId);
    await lifecycle(jobId, "cleanup_completed");
  }

  private async reconcileCreation(job: Job) {
    // Only clear uncertainty when independent inventories prove no resources exist.
    // An uncertain create may have targeted a different repo in older versions.
    const $ = this.$;
    const inventory = JSON.parse(await $`herdr worktree list --cwd ${job.repo} --json`.text()).result;
    if (!Array.isArray(inventory?.worktrees) || !inventory.source?.repo_root) throw new Error("Cannot reconcile uncertain creation: invalid worktree inventory");
    const workspaces = JSON.parse(await $`herdr workspace list`.text()).result?.workspaces;
    if (!Array.isArray(workspaces)) throw new Error("Cannot reconcile uncertain creation: invalid workspace inventory");
    const entries = (await $`git -C ${job.repo} worktree list --porcelain -z`.text()).split("\0");
    const branches = (await $`git -C ${job.repo} for-each-ref ${"--format=%(refname)"} refs/heads/`.text()).split("\n");
    if (inventory.worktrees.some((tree: { path: string }) => tree.path === job.worktree) ||
        workspaces.some((workspace: { workspace_id: string; worktree?: { checkout_path: string } }) =>
          workspace.workspace_id === job.workspace || workspace.worktree?.checkout_path === job.worktree) ||
        entries.includes(`worktree ${job.worktree}`) || branches.includes(`refs/heads/${job.branch}`) ||
        await exists(job.worktree) || job.launchAttempted) {
      throw new Error(`Resource creation is uncertain for ${job.jobId}; resources exist or launch was attempted. Preserve them for inspection.`);
    }
    // Older records may refer to a wrong parent. Check that repository too.
    if (job.parentWorkspace && workspaces.some((workspace: { workspace_id: string }) => workspace.workspace_id === job.parentWorkspace)) {
      const parent = JSON.parse(await $`herdr worktree list --workspace ${job.parentWorkspace} --json`.text()).result;
      if (!Array.isArray(parent?.worktrees) || !parent.source?.repo_root) throw new Error("Cannot reconcile uncertain creation: invalid parent inventory");
      const parentBranches = (await $`git -C ${parent.source.repo_root} for-each-ref ${"--format=%(refname)"} refs/heads/`.text()).split("\n");
      if (parent.worktrees.some((tree: { path: string; branch?: string }) => tree.path === job.worktree || tree.branch === job.branch) ||
          parentBranches.includes(`refs/heads/${job.branch}`)) throw new Error("Uncertain resources remain in the recorded parent repository");
    }
    job.resourceUncertain = false;
    await this.save(job);
    await lifecycle(job.jobId, "creation_reconciled");
  }

  // Watch events only accelerate the periodic scan, including atomic renames.
  private watchJob(jobId: string) {
    if (this.watchers.has(jobId)) return;
    try {
      const watcher = watch(this.dir(jobId), () => void this.reconcile(jobId));
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
    if (this.resumes.has(jobId) || this.cleanups.has(jobId)) return;
    const existing = this.scans.get(jobId);
    if (existing) return existing;
    const scan = this.exclusive(jobId, async () => {
      const job = this.jobs.get(jobId);
      if (!job || job.phase === "cleanup") return;
      if (job.mode === "interactive" && job.pending) {
        const state = await this.readSession(job);
        if (job.pending.key.startsWith("handback:") &&
            (state.status === "active" || (state.handbackID && job.pending.key !== `handback:${state.handbackID}`))) {
          await this.retireNotification(job, "new_handback");
        }
      }
      if (job.pending) {
        await this.promptSelf(jobId, job.pending.key, job.pending.text);
        if (job.pending) return;
      }
      const dir = this.dir(jobId);
      if (job.mode === "interactive") {
        const session = await this.readSession(job);
        if (job.resuming && session.status === "active") return;
        if (job.resuming) {
          job.resuming = undefined;
          await this.save(job);
        }
        if (session.status !== "active" && session.handbackID) {
          const key = `handback:${session.handbackID}`;
          const instruction = session.status === "paused"
            ? "PAUSED. Preserve the conversation, checkout and branch. Do not commit, merge or reap. Use resume_session to continue."
            : session.status === "commit"
              ? "READY FOR COMMIT. Review the diff and run checks, then commit in the worktree BEFORE reap_delegate. No merge or push is authorised."
              : `DISCARD REQUESTED. Ask the user to confirm deletion of this checkout and any unwanted commits. Only then reap_delegate with discard=true, confirmation=${jobId}, and deleteBranch if approved.`;
          await this.promptSelf(jobId, key, `[peer-session] ${job.name} (${jobId}): ${instruction}\nSummary: ${session.summary}\nChecks: ${(session.checks ?? []).join("; ")}\nRisks: ${(session.risks ?? []).join("; ")}\nWorktree: ${job.worktree}\nBranch: ${job.branch}\nUser instruction: ${session.userInstruction}`);
        } else if (!session.sessionID && Date.now() - job.createdAt > job.startupTimeoutSeconds * 1000 && !job.delivered.includes("startup-timeout")) {
          await this.notifyStartupTimeout(jobId);
        }
        return; // Idle interactive conversations are not stalled jobs.
      }
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
    }).catch(async (error) => {
      // Handback publication can wake the watcher before the delegate releases its lock.
      if (error instanceof SessionLockBusyError) return;
      if (Date.now() - (this.failureLog.get(jobId) ?? -Infinity) >= 60_000) {
        this.failureLog.set(jobId, Date.now());
        await lifecycle(jobId, "reconciliation_failed", { reason: "state" });
        console.error(`herdr-envoy: reconciliation failed for ${jobId}, will retry:`, error);
      }
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
    placement?: Placement;
    mode?: "interactive";
    name?: string;
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
    const dir = input.mode === "interactive" ? path.join(sessionRoot(), jobId) : jobDir(jobId);
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
      ...(input.mode ? { mode: input.mode } : {}),
    };
    await atomicWriteJSON(path.join(dir, FILES.handoff), handoff);
    const job: Job = {
      jobId, directory: this.directory, coordinatorPane: process.env.HERDR_PANE_ID, sessionID: input.sessionID,
      agent: input.agent, repo: input.repo, branch: input.branch, baseCommit,
      worktree: path.join(input.repo, ".herdr-envoy", "worktrees", jobId),
      createdAt: Date.now(), startupTimeoutSeconds: handoff.startupTimeoutSeconds,
      phase: "starting", delivered: [],
      ...(input.mode ? { mode: input.mode, name: input.name } : {}),
      placement: input.placement ?? "pane",
    };
    if (input.mode === "interactive") {
      await atomicWriteJSON(path.join(dir, FILES.session), {
        protocolVersion: PROTOCOL_VERSION, jobId, generation: 1,
        completionToken: handoff.completionToken, status: "active",
      } satisfies InteractiveSession);
    }
    await this.save(job);
    this.jobs.set(jobId, job);
    await lifecycle(jobId, "created");
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
      const m = /^(\S+)\s+\((primary|subagent|all)\)\s*$/.exec(line.trim());
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
    return this.exclusive(jobId, () => this.spawn(jobId));
  }

  private async spawn(jobId: string): Promise<{ pane: string; worktree: string }> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);
    try {
      await this.place(job, false);
      const bootPrompt =
        `Call the \`read_task\` tool now to get your task, then carry it out in this worktree. ` +
        (job.mode === "interactive" ? `Work interactively with the user. Do not finish automatically; hand_back only on explicit user instruction.` :
          `Call \`complete\` when done; call \`ask\` if you need a decision from the coordinator.`);
      await this.launch(job, bootPrompt);
      job.phase = "running";
      job.createdAt = Date.now();
      await this.save(job);
      this.watchJob(jobId);
      return { pane: job.pane!, worktree: job.worktree };
    } catch (error) {
      await lifecycle(jobId, "launch_failed", { reason: "state" });
      if (job.mode === "interactive" && job.launchAttempted) {
        await this.save(job);
        this.watchJob(jobId);
        throw new Error(`Launch may have started session ${jobId}; resources are preserved for inspection: ${error}`);
      }
      try {
        await this.cleanup(jobId, { deleteBranch: true });
      } catch (cleanupError) {
        throw new Error(`Job ${jobId} failed to launch: ${error}. Cleanup failed and remains tracked; retry reap_delegate: ${cleanupError}`);
      }
      throw error;
    }
  }

  private async place(job: Job, reopen: boolean) {
    const $ = this.$;
    const caller = process.env.HERDR_PANE_ID;
    if (!caller) throw new Error("peer-delegate: HERDR_PANE_ID missing (not in a herdr session)");
    if (job.placement === "subworkspace") {
      if (!job.parentWorkspace) {
        const inventory = JSON.parse(await $`herdr worktree list --cwd ${job.repo} --json`.text()).result;
        if (!inventory?.source?.source_workspace_id) throw new Error("Cannot identify a parent workspace for the requested repository. Open that repository in herdr first.");
        job.parentWorkspace = inventory.source.source_workspace_id;
        await this.save(job);
      }
      await $`herdr workspace get ${job.parentWorkspace!}`.quiet();
      const parent = JSON.parse(await $`herdr worktree list --workspace ${job.parentWorkspace!} --json`.text()).result?.source;
      const requestedRoot = (await $`git -C ${job.repo} rev-parse --show-toplevel`.text()).trim();
      if (!parent?.repo_root || await fs.realpath(parent.repo_root) !== await fs.realpath(requestedRoot) ||
          parent.source_checkout_path !== parent.repo_root) throw new Error("Recorded parent workspace does not match the requested repository root");
      await fs.mkdir(path.dirname(job.worktree), { recursive: true });
      job.resourceUncertain = true;
      await this.save(job);
      const response = reopen
        ? await $`herdr worktree open --workspace ${job.parentWorkspace!} --path ${job.worktree} --no-focus --json`.text()
        : await $`herdr worktree create --workspace ${job.parentWorkspace!} --branch ${job.branch} --base ${job.baseCommit} --path ${job.worktree} --label ${job.name ?? job.agent} --no-focus --json`.text();
      const result = JSON.parse(response).result;
      if (result?.worktree?.path !== job.worktree || !result.workspace?.workspace_id || !result.root_pane?.pane_id) throw new Error("Invalid herdr worktree response; inspect resources before retrying");
      job.workspace = result.workspace.workspace_id;
      job.pane = result.root_pane.pane_id;
      job.worktreeCreated = true;
      job.branchCreated = true;
      job.resourceUncertain = false;
      await this.save(job);
      if (reopen && result.already_open) throw new Error("Workspace is already open without the saved pane. Inspect it rather than launching a duplicate session.");
    } else {
      if (!reopen) {
        await fs.mkdir(path.dirname(job.worktree), { recursive: true });
        await $`git -C ${job.repo} worktree add --quiet -b ${job.branch} ${job.worktree} ${job.baseCommit}`.quiet();
        job.worktreeCreated = true;
        job.branchCreated = true;
        await this.save(job);
      }
      const { targetPane, direction } = await this.chooseSplitTarget(caller);
      const response = JSON.parse(await $`herdr pane split ${targetPane} --direction ${direction} --ratio 0.5 --cwd ${job.worktree} --no-focus --env ${`${JOBDIR_ENV}=${this.dir(job.jobId)}`}`.text());
      job.pane = response.result.pane.pane_id;
      await this.save(job);
    }
  }

  private async launch(job: Job, prompt: string, sessionID?: string) {
    const $ = this.$;
    if (await exists(path.join(job.worktree, ".envrc"))) await $`direnv allow ${job.worktree}`.quiet().catch(() => {});
    await this.waitForShellReady(job.pane!, path.basename(job.worktree));
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    // Worktree-created workspaces cannot receive --env, so set it for the process.
    const command = `env ${JOBDIR_ENV}=${quote(this.dir(job.jobId))} opencode --agent ${quote(job.agent)} --auto` +
      (sessionID ? ` --session ${quote(sessionID)}` : "") + ` --prompt ${quote(prompt)}`;
    job.launchAttempted = true;
    await this.save(job);
    await lifecycle(job.jobId, "launch_started");
    await $`herdr pane run ${job.pane!} ${command}`.quiet();
    await $`herdr pane rename ${job.pane!} ${job.name ?? `${job.agent}-delegate`}`.quiet();
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
    await Promise.all(this.resumes.values());
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
      placement: z.enum(["pane", "subworkspace"]).default("pane").describe("Split a pane or open a child worktree workspace, as the user requested."),
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
        placement: args.placement,
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
      discard: z.boolean().default(false).describe("Destructive: only after user confirmation for an interactive discard request."),
      confirmation: z.string().optional().describe("Exact full job ID, required to confirm destructive discard."),
    },
    async execute(args, context) {
      const jobId = coord.resolveJobId(args.jobId, context.sessionID);
      if (!jobId) return `No tracked job matching '${args.jobId}'.`;
      await coord.reap(jobId, { deleteBranch: args.deleteBranch, discard: args.discard, confirmation: args.confirmation });
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

export function openSessionTool(coord: Coordinator) {
  return tool({
    description: "Open a named interactive peer session for the user to steer. No automatic completion. Supports pane or subworkspace placement.",
    args: {
      agent: z.string(), name: z.string().min(1), task: z.string().min(1), repo: z.string(), branch: z.string(),
      baseCommit: z.string().optional(), targetBranch: z.string().optional(),
      placement: z.enum(["pane", "subworkspace"]).default("pane"),
    },
    async execute(args, context) {
      const { jobId } = await coord.createJob({ ...args, mode: "interactive", sessionID: context.sessionID, outputContract: "code-change" });
      const { pane, worktree } = await coord.spawnDelegate(jobId, { ...args, outputContract: "code-change" });
      return `Opened interactive session ${args.name} (${jobId}) in ${args.placement ?? "pane"}, pane ${pane}.\nWorktree: ${worktree}\nThe user steers this session and explicitly pauses, hands back for commit, or requests discard.`;
    },
  });
}

export function listSessionsTool(coord: Coordinator) {
  return tool({
    description: "List this orchestrator's durable interactive sessions, including paused work. Never guess when several sessions match the user's request.",
    args: {},
    async execute(_args, context) { return coord.listSessions(context.sessionID); },
  });
}

export function resumeSessionTool(coord: Coordinator) {
  return tool({
    description: "Resume paused or commit-ready work by ID without waiting for notification delivery. Omit ID only for one paused session. Preserves conversation, checkout and placement.",
    args: { jobId: z.string().optional(), instructions: z.string().optional() },
    async execute(args, context) {
      const jobId = await coord.resolveSession(context.sessionID, args.jobId);
      return coord.resumeSession(jobId, args.instructions);
    },
  });
}
