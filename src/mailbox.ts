import { promises as fs } from "node:fs";
import path from "node:path";
import { FILES, readJSON, root, sessionRoot } from "./protocol.js";

export interface MailItem {
  id: string;
  direction: "inbox" | "outbox";
  state: string;
  label: string;
  folder: string;
  createdAt: number;
  summary?: string;
  checks: string[];
  risks: string[];
}

export const displayText = (value: unknown, limit = 1000): string =>
  typeof value === "string" ? value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, limit) : "";

// Read-only projection. Never return auth tokens or use a folder match as session authority.
export async function readMailbox(sessionID: string, directory: string): Promise<{ items: MailItem[]; incomplete: boolean }> {
  const items: MailItem[] = [];
  let incomplete = false;
  if (!sessionID || !directory) return { items, incomplete };
  for (const base of [root(), sessionRoot()]) {
    const entries = await fs.readdir(base).catch((error) => {
      if (error.code !== "ENOENT") incomplete = true;
      return [];
    });
    for (const id of entries.filter((entry) => /^[a-f0-9]{32}$/.test(entry))) {
      try {
        const dir = path.join(base, id);
        const job = await readJSON<Record<string, any>>(path.join(dir, FILES.coordinator));
        if (job.jobId !== id) continue;
        const outgoing = job.sessionID === sessionID && job.directory === directory;
        const control = await readJSON<Record<string, any>>(path.join(dir, FILES.session)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        const binding = job.mode === "interactive" ? control : await readJSON<{ sessionID?: string }>(path.join(dir, "agent-session.json")).catch(() => null);
        const incoming = (job.existing?.sessionID ?? binding?.sessionID) === sessionID && job.worktree === directory;
        if (!outgoing && !incoming) continue;
        let state = control?.status ?? job.phase;
        let report = control;
        if (job.existing?.cancelled) state = "cancelled";
        else if (state === "active" && job.existing) state = job.existing.delivered ? "active" : job.existing.attemptedAt ? "unconfirmed" : "queued";
        if (job.mode !== "interactive") {
          const result = await readJSON<Record<string, any>>(path.join(dir, FILES.result)).catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return null;
          });
          if (result) { state = result.status; report = result; }
        }
        const strings = (value: unknown) => Array.isArray(value) ? value.filter((s) => typeof s === "string").slice(0, 20).map((s) => displayText(s)) : [];
        items.push({ id, direction: outgoing ? "outbox" : "inbox", state: displayText(state, 40),
          label: displayText(outgoing ? job.identity ?? job.name ?? job.agent : path.basename(job.directory ?? ""), 120),
          folder: displayText(job.worktree, 500), createdAt: Number.isFinite(job.createdAt) ? job.createdAt : 0,
          summary: displayText(report?.summary, 8000), checks: strings(report?.checks), risks: strings(report?.risks) });
      } catch {
        incomplete = true;
      }
    }
  }
  const terminal = new Set(["completed", "success", "failure", "cancelled", "discard", "commit", "paused"]);
  items.sort((a, b) => Number(terminal.has(a.state)) - Number(terminal.has(b.state)) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  return { items, incomplete };
}
