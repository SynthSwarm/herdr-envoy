import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

export interface QueueEntry {
  jobId: string;
  createdAt: number;
  directory?: unknown;
  coordinatorPane?: unknown;
  existing: { delivered?: boolean; attemptedAt?: number };
}

// Display metadata never grants authority or changes herdr's execution state.
export function queueDisplay(run = promisify(execFile)) {
  let previous = "";
  let refreshed = 0;
  return async (paneId: string, sessionID: string, executionState: string, requests: QueueEntry[]) => {
    const active = requests.filter((r) => r.existing.delivered);
    const uncertain = requests.filter((r) => !r.existing.delivered && r.existing.attemptedAt);
    const queued = requests.filter((r) => !r.existing.delivered && !r.existing.attemptedAt);
    const first = active[0] ?? uncertain[0] ?? queued[0];
    const sender = first && typeof first.directory === "string" ? path.basename(first.directory) : "";
    const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 80);
    const tokens = first ? {
      envoy_queue: `Req ${active.length} active ${queued.length} queued${uncertain.length ? ` ${uncertain.length}?` : ""}`,
      envoy_request: `${first.jobId.slice(0, 8)}${sender ? ` from ${clean(sender)}` : ""}`,
      envoy_wait: uncertain.length && !active.length ? "Delivery unconfirmed" :
        active.length ? (queued.length ? "Awaiting handback" : "Request outstanding") :
          ["idle", "done"].includes(executionState) ? "Checking delivery" : "Waiting for idle",
      envoy_active: String(active.length), envoy_queued: String(queued.length), envoy_uncertain: String(uncertain.length),
      envoy_request_id: first.jobId,
      envoy_sender: clean(typeof first.coordinatorPane === "string" ? first.coordinatorPane : ""),
      envoy_since: new Date(first.createdAt).toISOString(),
    } : null;
    const key = JSON.stringify([paneId, sessionID, tokens]);
    if ((!previous && !tokens) || (key === previous && Date.now() - refreshed < 10_000)) return;
    const names = ["envoy_queue", "envoy_request", "envoy_wait", "envoy_active", "envoy_queued", "envoy_uncertain", "envoy_request_id", "envoy_sender", "envoy_since"];
    const args = ["pane", "report-metadata", paneId, "--source", "herdr-envoy", "--agent", "opencode",
      "--applies-to-source", "herdr:opencode", "--ttl-ms", "30000"];
    for (const name of names) {
      if (tokens) args.push("--token", `${name}=${tokens[name as keyof typeof tokens]}`);
      else args.push("--clear-token", name);
    }
    try {
      await run("herdr", args, { timeout: 5000, maxBuffer: 256 * 1024 });
      previous = key;
      refreshed = Date.now();
    } catch {
      // UI failures must not block the queue. An unrefreshed report expires in herdr.
    }
  };
}
