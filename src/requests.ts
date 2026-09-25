import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { tool, type PluginInput } from "@opencode-ai/plugin";
import { consume, handBackTool, readTaskTool, type DelegateState } from "./delegate.js";
import { atomicWriteJSON, FILES, readJSON, sessionRoot, withSessionLock, type InteractiveSession } from "./protocol.js";

const z = tool.schema;
const metadata = z.object({
  jobId: z.string().regex(/^[a-f0-9]{32}$/), pane: z.string(), worktree: z.string(), createdAt: z.number(),
  existing: z.object({ sessionID: z.string(), messageID: z.string(), socket: z.string(), terminalID: z.string(), delivered: z.boolean().optional(), attemptedAt: z.number().optional(), cancelled: z.boolean().optional() }),
}).passthrough();

export function existingRequests($: PluginInput["$"], client: PluginInput["client"], directory: string, delegate?: DelegateState) {
  let stopped = false;
  let scan: Promise<void> | undefined;
  const load = async (jobId: string, sessionID: string) => {
    if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error("Invalid request ID");
    const dir = path.join(sessionRoot(), jobId);
    const job = metadata.parse(await readJSON(path.join(dir, FILES.coordinator)));
    if (job.jobId !== jobId || job.pane !== process.env.HERDR_PANE_ID || job.worktree !== directory ||
        job.existing.socket !== process.env.HERDR_SOCKET_PATH ||
        job.existing.sessionID !== sessionID || (!job.existing.delivered && !job.existing.attemptedAt)) throw new Error("Request is not delivered to this pane and conversation");
    if (!job.existing.delivered) {
      const receipt = await client.session.message({ path: { id: sessionID, messageID: job.existing.messageID }, query: { directory }, signal: AbortSignal.timeout(15_000) });
      if (!receipt.data?.parts.some((p) => p.type === "text" && p.text.startsWith(`[envoy request ${jobId}]`))) throw new Error("Request delivery is not confirmed");
      await withSessionLock(jobId, async () => {
        const file = path.join(dir, FILES.coordinator);
        const current = metadata.parse(await readJSON(file));
        current.existing.delivered = true;
        await atomicWriteJSON(file, current);
      }, 100);
    }
    return consume(dir);
  };
  const read = tool({
    description: "Read a delivered local request without replacing your existing task or conversation. Use the exact jobId from its notification.",
    args: { jobId: z.string().optional().describe("Exact existing-agent request ID. Omit only for your original Envoy delegation.") },
    async execute({ jobId }, ctx) {
      if (!jobId && !delegate) throw new Error("Specify the jobId from the queued request");
      const state = jobId ? await load(jobId, ctx.sessionID) : delegate!;
      const text = await readTaskTool(state).execute({}, ctx);
      return jobId ? `This is a request alongside your existing work, not a transfer of your conversation or checkout. Keep the request scoped to its brief. Use jobId=${jobId} for its hand_back.\n\n${text}` : text;
    },
  });
  const handback = handBackTool({ jobDir: "", task: null, consumed: null });
  const handBack = tool({
    description: "Hand back a delivered local request only on explicit user direction. This never transfers ownership of your existing conversation or checkout.",
    args: { ...handback.args, jobId: z.string().optional().describe("Exact existing-agent request ID. Omit only for your original Envoy delegation.") },
    async execute({ jobId, ...input }, ctx) {
      if (!jobId && !delegate) throw new Error("Specify the jobId from the queued request");
      return handBackTool(jobId ? await load(jobId, ctx.sessionID) : delegate!).execute(input, ctx);
    },
  });
  const tick = () => {
    if (stopped || scan) return scan;
    scan = (async () => {
      if (!process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) return;
      const lockID = "inbox-" + createHash("sha256").update(process.env.HERDR_SOCKET_PATH + "\0" + process.env.HERDR_PANE_ID).digest("hex");
      await withSessionLock(lockID, async () => {
      const entries = await fs.readdir(sessionRoot()).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const jobs = [];
      for (const id of entries.filter((id) => /^[a-f0-9]{32}$/.test(id))) {
        const parsed = metadata.safeParse(await readJSON(path.join(sessionRoot(), id, FILES.coordinator)).catch(() => null));
        if (parsed.success && parsed.data.jobId === id && parsed.data.pane === process.env.HERDR_PANE_ID &&
            parsed.data.existing.socket === process.env.HERDR_SOCKET_PATH && parsed.data.worktree === directory) jobs.push(parsed.data);
      }
      jobs.sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId));
      if (!jobs.length) return;
      const panes = JSON.parse(await $`herdr agent list`.text()).result?.agents;
      const pane = Array.isArray(panes) ? panes.find((p) => p.pane_id === process.env.HERDR_PANE_ID) : undefined;
      if (pane?.agent !== "opencode" || pane.agent_session?.agent !== "opencode" || pane.agent_session?.kind !== "id") return;
      for (const job of jobs) {
        if (job.existing.sessionID !== pane.agent_session.value || job.existing.terminalID !== pane.terminal_id) continue;
        if (job.existing.cancelled) continue;
        const state = await readJSON<InteractiveSession>(path.join(sessionRoot(), job.jobId, FILES.session));
        if (state.status !== "active") continue;
        // One outstanding request per target. Handback releases the next queued request.
        if (job.existing.delivered) return;
        await withSessionLock(job.jobId, async () => {
          const file = path.join(sessionRoot(), job.jobId, FILES.coordinator);
          const current = metadata.parse(await readJSON(file));
          if (current.existing.delivered || current.existing.cancelled || stopped) return;
          if (pane.agent_session.value !== current.existing.sessionID || !["idle", "done"].includes(pane.agent_status)) return;
          const id = current.existing.sessionID;
          const options = { query: { directory }, signal: AbortSignal.timeout(15_000) };
          const conversation = await client.session.get({ ...options, path: { id }, throwOnError: true });
          if (conversation.data?.id !== id || conversation.data.directory !== directory) return;
          const text = `[envoy request ${current.jobId}] A coordinator queued a request for this existing conversation. ` +
            `Call read_task with jobId="${current.jobId}". Preserve your existing work and instructions. ` +
            `For this request use hand_back with the same jobId only when the user explicitly asks to pause, commit or discard. ` +
            "Do not infer handback permission from finishing the request. No automatic commit, cleanup or conversation takeover is authorised.";
          const receipt = await client.session.message({ ...options, path: { id, messageID: current.existing.messageID } });
          if (receipt.error && receipt.response.status !== 404) return;
          if (receipt.data?.parts.some((p) => p.type === "text" && p.text === text)) {
            current.existing.delivered = true;
            await atomicWriteJSON(file, current);
            return;
          }
          // A lost submission response is not permission to send the request twice.
          if (current.existing.attemptedAt || receipt.data) return;
          const status = await client.session.status({ ...options, throwOnError: true });
          if (status.data?.[id] && status.data[id].type !== "idle") return;
          const messages = await client.session.messages({ ...options, path: { id }, query: { directory, limit: 20 }, throwOnError: true });
          const user = messages.data?.findLast((m) => m.info.role === "user")?.info;
          if (!user || user.role !== "user") return;
          const statusNow = await client.session.status({ ...options, throwOnError: true });
          if (stopped || (statusNow.data?.[id] && statusNow.data[id].type !== "idle")) return;
          // Assign ordering at delivery, not enqueue time, after the preceding turn.
          current.existing.messageID = `msg_${(BigInt(Date.now()) * 0x1000n & 0xffffffffffffn).toString(16).padStart(12, "0")}${current.jobId.slice(0, 14)}`;
          current.existing.attemptedAt = Date.now();
          await atomicWriteJSON(file, current);
          // Keep the target's current persona/model; never inject input into its terminal.
          await client.session.promptAsync({ ...options, path: { id }, body: {
            messageID: current.existing.messageID, agent: user.agent, model: user.model,
            parts: [{ type: "text", text }],
          }, throwOnError: true });
          const submitted = await client.session.message({ ...options, path: { id, messageID: current.existing.messageID } });
          if (submitted.data?.parts.some((p) => p.type === "text" && p.text === text)) {
            current.existing.delivered = true;
            await atomicWriteJSON(file, current);
          }
        });
        return;
      }
      });
    })().catch(() => {
      // Preserve queued state on contention, unavailable inventory or transport failure.
    }).finally(() => { scan = undefined; });
    return scan;
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  return { read_task: read, hand_back: handBack, tick, async dispose() {
    stopped = true;
    clearInterval(timer);
    await scan;
  } };
}
