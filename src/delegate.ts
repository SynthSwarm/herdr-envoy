// delegate.ts — delegate-role behavior (spec §3, §4). Active when JOBDIR_ENV is set.
// On boot: read handoff.json in-process, snapshot auth, UNLINK handoff (ephemeral).
// Bounded delegates publish result.json; interactive delegates hand back session control.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { tool, type PluginInput } from "@opencode-ai/plugin";
import { lifecycle } from "./log.js";
const z = tool.schema;
import {
  PROTOCOL_VERSION,
  FILES,
  atomicWriteJSON,
  exists,
  rand,
  withSessionLock,
  readJSON,
  sessionRoot,
  type Block,
  type Consumed,
  type Handoff,
  type InteractiveSession,
  type Reply,
  type Result,
} from "./protocol.js";

export interface DelegateState {
  jobDir: string;
  task: string | null;
  consumed: Consumed | null;
  // Only read_task adopts a resumed generation, never a pending hand-back.
  interactiveGeneration?: number;
}

// Mid-run heartbeat: while the delegate is alive and the job isn't finished,
// touch the heartbeat file periodically. The coordinator watches its freshness
// to distinguish a working delegate from a crashed one (spec §13). Stops once
// result.json exists or the process exits. Returns a disposer.
export function startHeartbeat(jobDir: string, intervalMs = 10_000): () => void {
  const hbPath = path.join(jobDir, FILES.heartbeat);
  let stopped = false;
  const beat = async () => {
    if (stopped) return;
    // stop beating once the job has a result
    if (await exists(path.join(jobDir, FILES.result))) {
      stopped = true;
      return;
    }
    if (stopped) return;
    try {
      const now = Date.now();
      await fs.writeFile(hbPath, String(now), { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  };
  void beat();
  const timer = setInterval(beat, intervalMs);
  // don't keep the process alive just for the heartbeat
  (timer as any).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Consume the handoff: read task, snapshot auth to .consumed.json, unlink handoff.
export async function consume(jobDir: string): Promise<DelegateState> {
  const handoffPath = path.join(jobDir, FILES.handoff);
  const consumedPath = path.join(jobDir, FILES.consumed);

  if (await exists(consumedPath)) {
    // Already consumed (e.g. plugin reload) — recover auth AND task from snapshot.
    const consumed = await readJSON<Consumed>(consumedPath);
    if (consumed.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`peer-delegate: protocol mismatch ${consumed.protocolVersion}`);
    }
    return { jobDir, task: consumed.task ?? null, consumed };
  }
  if (!(await exists(handoffPath))) {
    return { jobDir, task: null, consumed: null };
  }

  const h = await readJSON<Handoff>(handoffPath);
  if (h.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`peer-delegate: protocol mismatch ${h.protocolVersion}`);
  }

  const consumed: Consumed = {
    protocolVersion: h.protocolVersion,
    jobId: h.jobId,
    generation: h.generation,
    completionToken: h.completionToken,
    agent: h.agent,
    task: h.task, // persist task so a restarted delegate can recover it (§11a.5)
    outputContract: h.outputContract,
    targetBranch: h.targetBranch,
    baseCommit: h.baseCommit,
    mergePolicy: h.mergePolicy,
    checks: h.checks,
    ...(h.mode ? { mode: h.mode } : {}),
  };
  await atomicWriteJSON(consumedPath, consumed);
  await fs.unlink(handoffPath); // ephemeral brief destroyed after read (§3)
  return { jobDir, task: h.task, consumed };
}

async function readInteractiveSession(state: DelegateState, sessionID?: string): Promise<InteractiveSession> {
  const c = state.consumed;
  if (!c || c.mode !== "interactive") throw new Error("peer-delegate: no interactive job auth");
  if (!sessionID) throw new Error("peer-delegate: interactive tools require ctx.sessionID");
  const session = await readJSON<InteractiveSession>(path.join(state.jobDir, FILES.session));
  if (c.protocolVersion !== PROTOCOL_VERSION || session.protocolVersion !== PROTOCOL_VERSION ||
      session.jobId !== c.jobId || session.completionToken !== c.completionToken) {
    throw new Error("peer-delegate: interactive session identity mismatch");
  }
  if (!Number.isSafeInteger(session.generation) ||
      session.generation < (state.interactiveGeneration ?? c.generation)) {
    throw new Error("peer-delegate: interactive session generation mismatch");
  }
  if (!["active", "paused", "completed", "commit", "discard"].includes(session.status)) {
    throw new Error("peer-delegate: invalid interactive session status");
  }
  if (session.sessionID !== undefined && session.sessionID !== sessionID) {
    throw new Error("peer-delegate: interactive session is bound to another sessionID");
  }
  return session;
}

// A restored OpenCode conversation need not retain its original launch environment.
// Recover only an already-bound owned peer, never adopt a checkout by path alone.
export async function recoverInteractivePeer($: PluginInput["$"], directory: string, sessionID: string, jobId?: string): Promise<DelegateState> {
  if (!sessionID) throw new Error("Peer recovery requires ctx.sessionID");
  const root = sessionRoot();
  const ids = jobId ? [jobId] : await fs.readdir(root).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const current = await fs.realpath(directory);
  const candidates: { dir: string; branch: string; session: InteractiveSession }[] = [];
  for (const id of ids.filter((id) => /^[a-f0-9]{32}$/.test(id))) {
    const dir = path.join(root, id);
    const job = await readJSON<{ jobId: string; mode?: string; existing?: unknown; worktree: string; branch: string;
      phase: string; worktreeCreated?: boolean; resourceUncertain?: boolean }>(path.join(dir, FILES.coordinator)).catch(() => null);
    if (!job || job.jobId !== id || job.mode !== "interactive" || job.existing !== undefined ||
        typeof job.worktree !== "string" || typeof job.branch !== "string") continue;
    if (await fs.realpath(job.worktree).catch(() => null) !== current) continue;
    const session = await readJSON<InteractiveSession>(path.join(dir, FILES.session));
    if (session.sessionID !== sessionID) continue;
    if (job.phase !== "running" || !job.worktreeCreated || job.resourceUncertain) {
      throw new Error("Peer recovery refused: checkout ownership is not ready or cleanup has started");
    }
    candidates.push({ dir, branch: job.branch, session });
  }
  if (candidates.length !== 1) throw new Error(candidates.length > 1
    ? "Ambiguous saved peer sessions. Specify the exact jobId; never guess."
    : "No saved peer matches this conversation and checkout. Specify the jobId from a queued request, or ask the coordinator to resume the original peer conversation.");
  const { dir, branch, session } = candidates[0];
  // Do not consume an unbound handoff or write new authority while recovering.
  const consumed = await readJSON<Consumed>(path.join(dir, FILES.consumed));
  if (consumed.jobId !== path.basename(dir)) throw new Error("Peer recovery identity mismatch");
  const state: DelegateState = { jobDir: dir, task: consumed.task ?? null, consumed };
  await readInteractiveSession(state, sessionID);
  const actualBranch = (await $`git -C ${directory} branch --show-current`.text()).trim();
  if (actualBranch !== branch) throw new Error("Peer recovery refused: checkout branch has changed");
  // A fresh process adopts the saved generation. Subsequent calls retain this
  // snapshot, so a coordinator resume still requires an explicit read_task.
  state.interactiveGeneration = session.generation;
  return state;
}

// The `read_task` tool exposed to the delegate agent. The coordinator launches
// the delegate with a tiny prompt telling it to call this first; that keeps the
// (potentially huge) task text out of the shell command line entirely. Returns
// the full task plus a standard working envelope. The task was already consumed
// from handoff.json on boot (state.task).
export function readTaskTool(state: DelegateState) {
  return tool({
    description:
      "Read your delegated task. Call this FIRST, before doing anything else. Returns the full " +
      "task brief you must carry out in this worktree.",
    args: {},
    async execute(_args, ctx) {
      const c = state.consumed;
      const task = state.task;
      if (!task) {
        return "No task found (handoff not consumed). Ask the coordinator to re-delegate.";
      }
      if (c?.mode === "interactive") {
        const session = await readInteractiveSession(state, ctx?.sessionID);
        if (session.sessionID === undefined) {
          if (session.status !== "active") throw new Error("peer-delegate: interactive session is not active");
          session.sessionID = ctx.sessionID;
          await atomicWriteJSON(path.join(state.jobDir, FILES.session), session);
        }
        state.interactiveGeneration = session.generation;
        return `You are an interactive delegated peer. The user steers your work in this worktree.\n\n` +
          `## Task\n${task}\n\n` +
          `## Current control\nStatus: ${session.status}. Generation: ${session.generation}.\n` +
          (session.status === "active" ? `Work with the user on their instructions.\n` :
            session.status === "completed" ? `This task is completed. Use a new request or \`open_session\` for further work.\n` :
            `Do not continue work until the coordinator resumes this session. ` +
            (session.status === "paused" ?
              `An explicit user instruction to complete, commit or discard may be handed back without resuming.\n` :
              `Ask the coordinator to resolve the existing hand-back or use \`open_session\` for further work.\n`)) +
          `Call \`read_task\` again to reread current control, especially after a resume.\n\n` +
          `## Hand-back\nDo not call \`complete\` or \`ask\`. Ask the user directly when you need guidance. ` +
          `When the active task is finished and there is nothing to commit for this task, automatically call ` +
          `\`hand_back\` with disposition="completed", the deliverable in summary, checks and risks. ` +
          `Do not ask for confirmation or invent a userInstruction. Verify that no task changes need committing; ` +
          `a clean checkout alone does not establish that the task is finished. Respect an explicit instruction to keep the session open. ` +
          `If the user asks to hand back finished work with nothing to commit, use completed directly. ` +
          `Call \`hand_back\` with pause, commit or discard only after the user explicitly instructs you to do so. ` +
          `Quote that instruction in userInstruction. Paused work requires explicit user direction to complete.\n` +
          `Do not automatically commit or clean up. A commit or discard hand-back is a request to the ` +
          `coordinator, not permission to commit, delete the worktree, or close this session yourself.`;
      }
      const outputContract = c?.outputContract ?? "advisory";
      const envelope =
        `You are a delegated peer worker. Carry out the following task in this worktree.\n\n` +
        `## Task\n${task}\n\n` +
        (outputContract === "code-change" ? `Assigned base commit: ${c?.baseCommit}. Target branch: ${c?.targetBranch || "not specified"}.\n\n` : "") +
        `## When done\n` +
        `Call the \`complete\` tool with a status ("success" or "failure") and a one-sentence summary` +
        (outputContract === "code-change"
          ? `, plus branch, baseCommit and headCommit for your commit.`
          : ` (this is an advisory task — do NOT commit; return your deliverable in the summary/evidence).`) +
        `\n` +
        `If you get blocked and need a decision from the coordinator, call the \`ask\` tool.`;
      return envelope;
    },
  });
}

export function handBackTool(state: DelegateState) {
  const args = {
    disposition: z.enum(["pause", "completed", "commit", "discard"]),
    summary: z.string().describe("Summarise the work and its current state."),
    checks: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    userInstruction: z.string().min(1).refine((value) => value.trim().length > 0).optional()
      .describe("For pause, commit, discard or completing paused work, quote the user's explicit instruction. Omit for automatic completed hand-back."),
  };
  return tool({
    description: "Automatically hand back completed work with nothing to commit using disposition=completed. " +
      "Pause, commit and discard require explicit user direction. Include the deliverable in summary. " +
      "Publishes the report without committing or cleaning up. Argument validation cannot verify task completion or natural-language consent.",
    args,
    async execute(input, ctx) {
      const request = z.object(args).parse(input);
      if (request.disposition !== "completed" && !request.userInstruction) {
        throw new Error("userInstruction is required for pause, commit or discard");
      }
      if (!state.consumed) throw new Error("peer-delegate: no interactive job auth");
      return withSessionLock(state.consumed.jobId, async () => {
      const session = await readInteractiveSession(state, ctx?.sessionID);
      if (session.sessionID !== ctx.sessionID) {
        throw new Error("peer-delegate: call read_task to bind this interactive session first");
      }
      if (session.generation !== (state.interactiveGeneration ?? state.consumed!.generation)) {
        throw new Error("peer-delegate: interactive session generation changed; reread read_task first");
      }
      const status = request.disposition === "pause" ? "paused" : request.disposition;
      const { summary, checks, risks, userInstruction } = request;
      if (session.status !== "active") {
        if (session.handbackID && session.status === status) {
          await lifecycle(session.jobId, "handback_duplicate", { generation: session.generation, disposition: status });
          return `Hand-back already reported for job ${session.jobId} (generation ${session.generation}, ` +
            `disposition ${request.disposition}). The original report is unchanged; no new hand-back was published.`;
        }
        if (session.status !== "paused") {
          throw new Error(`peer-delegate: interactive session is ${session.status} ` +
            `(generation ${session.generation}); cannot report ${request.disposition}. ` +
            `Ask the coordinator to resolve the existing hand-back, resume commit-ready work, or use open_session for a new task.`);
        }
        if (status === "completed" && !userInstruction) {
          throw new Error("userInstruction is required to complete paused work");
        }
      }
      await atomicWriteJSON(path.join(state.jobDir, FILES.session), {
        ...session, status, summary, checks, risks, userInstruction, handbackID: rand(),
      } satisfies InteractiveSession);
      await lifecycle(session.jobId, "handback", { generation: session.generation, disposition: status });
      return `Reported ${request.disposition} hand-back for job ${session.jobId} (generation ${session.generation}).`;
      }, 100);
    },
  });
}

// The `complete` tool exposed to the delegate agent.
export function completeTool(state: DelegateState) {
  return tool({
    description:
      "Report completion of your delegated job. Publishes result.json (token-authenticated). " +
      "For code-change jobs you MUST pass branch, baseCommit and headCommit.",
    args: {
      status: z.enum(["success", "failure"]).describe("Did you complete the task?"),
      summary: z.string().describe("One crisp human-readable sentence."),
      evidence: z.array(z.string()).optional().describe("References/observations the coordinator can spot-check."),
      risks: z.array(z.string()).optional(),
      followUps: z.array(z.string()).optional(),
      branch: z.string().optional().describe("Required for code-change."),
      baseCommit: z.string().optional().describe("Required for code-change."),
      headCommit: z.string().optional().describe("Required for code-change."),
    },
    async execute(args) {
      const c = state.consumed;
      if (!c) throw new Error("peer-delegate: no job auth (handoff not consumed)");

      const resultPath = path.join(state.jobDir, FILES.result);
      if (await exists(resultPath)) {
        const prev = await readJSON<Result>(resultPath);
        if (prev.generation === c.generation) {
          throw new Error(`peer-delegate: generation ${c.generation} already completed`);
        }
      }

      if (c.outputContract === "code-change" && args.status === "success") {
        if (!args.branch || !args.baseCommit || !args.headCommit) {
          throw new Error("peer-delegate: code-change success requires branch, baseCommit, headCommit");
        }
      }

      const result: Result = {
        protocolVersion: PROTOCOL_VERSION,
        jobId: c.jobId,
        generation: c.generation,
        completionToken: c.completionToken,
        origin: "delegate",
        status: args.status,
        outputContract: c.outputContract,
        summary: args.summary,
        evidence: args.evidence ?? [],
        checksPerformed: [],
        risks: args.risks ?? [],
        followUps: args.followUps ?? [],
        ...(c.outputContract === "code-change"
          ? { branch: args.branch, baseCommit: args.baseCommit, headCommit: args.headCommit }
          : {}),
      };
      await atomicWriteJSON(resultPath, result);
      return `Reported ${args.status} for job ${c.jobId} (generation ${c.generation}).`;
    },
  });
}

// The `ask` tool: delegate poses a question to the coordinator mid-task, writing
// block.json and blocking (polling) until reply.json appears (spec §13).
export function askTool(state: DelegateState) {
  return tool({
    description:
      "Ask the coordinator a question when you are blocked and need input to continue. " +
      "Blocks until the coordinator replies, then returns their answer.",
    args: {
      question: z.string().describe("Your question for the coordinator."),
    },
    async execute(args, ctx) {
      const c = state.consumed;
      if (!c) throw new Error("peer-delegate: no job auth (handoff not consumed)");
      const dir = state.jobDir;
      const blockPath = path.join(dir, FILES.block);
      const replyPath = path.join(dir, FILES.reply);

      const block: Block = {
        protocolVersion: PROTOCOL_VERSION,
        jobId: c.jobId,
        generation: c.generation,
        completionToken: c.completionToken,
        question: args.question,
        at: Date.now(),
      };
      await atomicWriteJSON(blockPath, block);

      // Poll for reply (fs.watch is racy for the delegate's short wait; poll).
      const deadlineMs = Date.now() + 10 * 60 * 1000; // 10 min max block
      while (Date.now() < deadlineMs) {
        if (ctx.abort.aborted) throw new Error("aborted while blocked");
        if (await exists(replyPath)) {
          const reply = await readJSON<Reply>(replyPath);
          if (reply.protocolVersion === PROTOCOL_VERSION && reply.jobId === c.jobId && reply.generation === c.generation) {
            await fs.unlink(replyPath).catch(() => {});
            await fs.unlink(blockPath).catch(() => {});
            return reply.answer;
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      await fs.unlink(blockPath).catch(() => {});
      throw new Error("peer-delegate: no reply within 10 minutes");
    },
  });
}
