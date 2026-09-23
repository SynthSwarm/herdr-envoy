import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { sessionRoot } from "./protocol.js";

const events = ["created", "recovered", "launch_started", "launch_failed",
  "notification_queued", "notification_deferred", "notification_attempted",
  "notification_delivered", "notification_superseded", "reconciliation_failed",
  "resume_started", "resume_completed", "resume_failed", "handback", "handback_duplicate",
  "cleanup_started", "cleanup_completed", "cleanup_failed", "creation_reconciled"] as const;

export type LifecycleEvent = typeof events[number];

interface Details {
  generation?: number;
  disposition?: "active" | "paused" | "commit" | "discard";
  reason?: "busy" | "retry_delay" | "readback" | "transport" | "state" | "resume" | "new_handback";
  httpStatus?: number;
}

export function logRoot(): string {
  return path.join(path.dirname(sessionRoot()), "logs");
}

const cleanups = new Map<string, { day: string; done: Promise<void> }>();

// No free-form text, paths, prompts, summaries, credentials or exception messages.
// Keep today and the previous 29 UTC dates, independently of job cleanup.
export async function lifecycle(jobId: string, event: LifecycleEvent, details: Details = {}): Promise<void> {
  try {
    if (typeof jobId !== "string" || jobId.length !== 32 || !/^[a-f0-9]{32}$/.test(jobId) || !events.includes(event)) return;
    const directory = logRoot();
    const now = new Date();
    const time = now.toISOString();
    const day = time.slice(0, 10);
    const { generation, disposition, reason, httpStatus } = details ?? {};
    const record = {
      time, jobId, event,
      generation: Number.isSafeInteger(generation) ? generation : undefined,
      disposition: ["active", "paused", "commit", "discard"].includes(disposition ?? "") ? disposition : undefined,
      reason: ["busy", "retry_delay", "readback", "transport", "state", "resume", "new_handback"].includes(reason ?? "") ? reason : undefined,
      httpStatus: Number.isSafeInteger(httpStatus) ? httpStatus : undefined,
    };
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(directory)).isDirectory()) return;
    await fs.chmod(directory, 0o700);
    const file = await fs.open(path.join(directory, `${day}.jsonl`),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return;
      await file.chmod(0o600);
      // Bound normal daily volume; concurrent writers can overshoot by a few records.
      if (stat.size < 8 * 1024 * 1024) await file.writeFile(JSON.stringify(record) + "\n");
    } finally {
      await file.close();
    }
    let cleanup = cleanups.get(directory);
    if (cleanup?.day !== day) {
      const cutoff = Date.parse(day) - 30 * 24 * 60 * 60 * 1000;
      cleanup = { day, done: (async () => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name.length !== 16 || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
          const date = entry.name.slice(0, 10);
          const timestamp = Date.parse(date);
          if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date || timestamp > cutoff) continue;
          try {
            await fs.unlink(path.join(directory, entry.name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      })() };
      cleanups.set(directory, cleanup);
    }
    try {
      await cleanup.done;
    } catch {
      // A failed scan must remain retryable, including within the same day.
      if (cleanups.get(directory) === cleanup) cleanups.delete(directory);
    }
  } catch {
    // Logging must never block handback or resource preservation.
  }
}
