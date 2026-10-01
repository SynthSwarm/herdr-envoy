import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";
import { listMachinesTool } from "./discovery.js";
import { FILES, readJSON, root, sessionRoot } from "./protocol.js";

export function agentRef(name: string, id: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/g, "") || "agent";
  return `${slug}-${id.slice(0, 12)}`;
}

// Labels and directories are attributes, not identity. Never use a mutable label to derive this ID.
export function conversationRef(machine: string, sessionID: string): string {
  return `agent-${createHash("sha256").update(JSON.stringify([machine, sessionID])).digest("hex").slice(0, 16)}`;
}

export function listAgentsTool(run = promisify(execFile)) {
  return tool({
    description: "Discover live OpenCode agent identities, locations and states. Includes local Git context and verified Envoy-owned references. Read-only; discovery never grants cleanup authority. Refresh before targeting; ambiguous matches must not be guessed.",
    args: {},
    async execute(_args, ctx) {
      const raw = await listMachinesTool(run).execute({}, ctx);
      const inventory = JSON.parse(typeof raw === "string" ? raw : raw.output);
      const jobs: Record<string, unknown>[] = [];
      for (const directory of [root(), sessionRoot()]) {
        const entries = await fs.readdir(directory).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const id of entries.filter((entry) => /^[a-f0-9]{32}$/.test(entry))) {
          const job = await readJSON<Record<string, unknown>>(path.join(directory, id, FILES.coordinator)).catch(() => null);
          if (job?.jobId !== id || job.existing || typeof job.identity !== "string" || (!job.worktreeCreated && job.placement !== "workspace")) continue;
          const binding = await readJSON<{ sessionID: string }>(path.join(directory, id, "agent-session.json")).catch(() => null);
          job.agentSessionID = binding?.sessionID;
          jobs.push(job);
        }
      }
      for (const machine of inventory.machines) {
        for (const agent of machine.agents ?? []) {
          const machineKey = machine.id === null ? process.env.HERDR_SOCKET_PATH : `${machine.id}:${machine.session}`;
          agent.identity = machineKey && agent.sessionId ? conversationRef(machineKey, agent.sessionId) : null;
          agent.ownership = "discovered";
          if (machine.id === null) {
            const matches = jobs.filter((job) => job.socket === process.env.HERDR_SOCKET_PATH && job.terminalID === agent.terminalId &&
              job.agentSessionID === agent.sessionId && agent.sessionId && job.worktree === agent.cwd && job.terminalID);
            if (matches.length === 1) {
              agent.identity = matches[0].identity;
              agent.ownership = "envoy";
              agent.jobId = matches[0].jobId;
            }
          }
          agent.git = null;
          agent.gitStatus = machine.id === null ? "unavailable" : "not_inspected";
          if (machine.id === null && agent.cwd) {
            try {
              const options = { timeout: 5000, maxBuffer: 1024 * 1024, signal: ctx.abort };
              const repo = String((await run("git", ["-C", agent.cwd, "rev-parse", "--show-toplevel"], options)).stdout).trim();
              const remotes = String((await run("git", ["-C", agent.cwd, "remote", "-v"], options)).stdout);
              agent.git = { root: repo, remotes: [...new Set(remotes.split("\n").filter(Boolean).map((line) => {
                // Do not expose credentials, query parameters or fragments embedded in remote URLs.
                const [name, url = ""] = line.split(/\s+/);
                return `${name} ${url.replace(/(\w+:\/\/)[^/@]+@/, "$1").split(/[?#]/)[0]}`;
              }))] };
              agent.gitStatus = "available";
            } catch {
              ctx.abort.throwIfAborted();
            }
          }
        }
      }
      return JSON.stringify({ ...inventory, observedAt: new Date().toISOString() });
    },
  });
}
