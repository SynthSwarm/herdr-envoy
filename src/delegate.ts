// delegate.ts — delegate-role behavior (spec §3, §4). Active when JOBDIR_ENV is set.
// On boot: read handoff.json in-process, snapshot auth, UNLINK handoff (ephemeral).
// Bounded delegates publish result.json; interactive delegates hand back session control.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { tool } from "@opencode-ai/plugin";
const z = tool.schema;
import {
  PROTOCOL_VERSION,
  FILES,
  atomicWriteJSON,
  exists,
  rand,
  readJSON,
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
  if (!["active", "paused", "commit", "discard"].includes(session.status)) {
    throw new Error("peer-delegate: invalid interactive session status");
  }
  if (session.sessionID !== undefined && session.sessionID !== sessionID) {
    throw new Error("peer-delegate: interactive session is bound to another sessionID");
  }
  return session;
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
            `Do not continue work or submit another hand-back until the coordinator resumes this session.\n`) +
          `Call \`read_task\` again to reread current control, especially after a resume.\n\n` +
          `## Hand-back\nDo not call \`complete\` or \`ask\`, or automatically report completion. ` +
          `Ask the user directly when you need guidance. Call \`hand_back\` only after the user explicitly ` +
          `instructs you to pause, commit, or discard. Quote that explicit instruction in userInstruction ` +
          `and include a summary, checks and risks. Never invent or infer permission from task completion.\n` +
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
    disposition: z.enum(["pause", "commit", "discard"]),
    summary: z.string().describe("Summarise the work and its current state."),
    checks: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    userInstruction: z.string().min(1).refine((value) => value.trim().length > 0)
      .describe("Mandatory: quote the user's explicit instruction to pause, commit, or discard. Do not infer consent."),
  };
  return tool({
    description: "Hand control back only when the user explicitly asks to pause, commit, or discard. " +
      "Publishes the request without committing or cleaning up. Argument validation cannot verify natural-language consent.",
    args,
    async execute(input, ctx) {
      const request = z.object(args).parse(input);
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
        if (session.handbackID && session.status === status && session.summary === summary &&
            session.userInstruction === userInstruction &&
            JSON.stringify(session.checks) === JSON.stringify(checks) &&
            JSON.stringify(session.risks) === JSON.stringify(risks)) {
          return `Hand-back already reported for job ${session.jobId} (generation ${session.generation}).`;
        }
        throw new Error("peer-delegate: interactive session is not active");
      }
      await atomicWriteJSON(path.join(state.jobDir, FILES.session), {
        ...session, status, summary, checks, risks, userInstruction, handbackID: rand(),
      } satisfies InteractiveSession);
      return `Reported ${request.disposition} hand-back for job ${session.jobId} (generation ${session.generation}).`;
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
