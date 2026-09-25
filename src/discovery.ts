import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;
const machinesSchema = z.array(z.object({
  id: z.string().min(1),
  label: z.string(),
  target: z.string(),
  session: z.string(),
  enabled: z.boolean(),
}));
const agentsSchema = z.object({ result: z.object({ agents: z.array(z.object({
  agent: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  pane_id: z.string().min(1),
  workspace_id: z.string(),
  agent_status: z.enum(["idle", "working", "blocked", "done", "unknown"]),
  cwd: z.string().nullable().optional(),
  terminal_title: z.string().nullable().optional(),
  agent_session: z.object({
    agent: z.string(), kind: z.string(), value: z.string(),
  }).nullable().optional(),
})) }) });

export function listMachinesTool(run = promisify(execFile)) {
  return tool({
    description: "List Local and saved herdr machines with their live OpenCode agents, including idle, working, blocked, done and unknown states. Read-only discovery, not delegation authority. Disabled machines are not contacted; unavailable machines are not reported as empty. Requires herdr machine forwarding support (0.9.1).",
    args: {},
    async execute(_args, ctx) {
      if (process.env.HERDR_ENV !== "1") throw new Error("Machine discovery requires a herdr-managed pane (HERDR_ENV=1)");
      const query = async (args: string[]) => {
        const result = await run("herdr", args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, signal: ctx.abort });
        return JSON.parse(String(result.stdout));
      };
      const inspect = async (id: string | null, enabled: boolean) => {
        if (!enabled) return { status: "disabled" as const, agents: null };
        try {
          const result = agentsSchema.parse(await query(id === null ? ["agent", "list"] : ["--machine", id, "agent", "list"]));
          return {
            status: "available" as const,
            agents: result.result.agents.filter((agent) => agent.agent === "opencode").map((agent) => ({
              paneId: agent.pane_id,
              workspaceId: agent.workspace_id,
              name: agent.name ?? null,
              state: agent.agent_status,
              cwd: agent.cwd ?? null,
              title: agent.terminal_title ?? null,
              sessionId: agent.agent_session?.agent === "opencode" && agent.agent_session.kind === "id"
                ? agent.agent_session.value : null,
            })),
          };
        } catch {
          ctx.abort.throwIfAborted();
          return { status: "unavailable" as const, agents: null, error: "Could not query agents. Check the connection, server compatibility and herdr agent list response." };
        }
      };
      let profiles: ReturnType<typeof machinesSchema.parse> = [];
      let error: string | undefined;
      try {
        profiles = machinesSchema.parse(await query(["machine", "list", "--json"]));
      } catch {
        ctx.abort.throwIfAborted();
        error = "Could not list saved machines. Only Local was inspected; check herdr machine list --json.";
      }
      // Keep pane/session identities scoped to their machine; never fall back to Local.
      const local = { id: null, label: "Local", target: null, session: null, enabled: true };
      const machines = [];
      for (const profile of [local, ...profiles]) {
        ctx.abort.throwIfAborted();
        machines.push({ ...profile, ...await inspect(profile.id, profile.enabled) });
      }
      return JSON.stringify({ machines, error });
    },
  });
}
