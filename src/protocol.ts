// protocol.ts — the disk-transport contract shared by both roles.
// Separate OS processes => disk is the ONLY channel. All comms are job-dir files.
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PROTOCOL_VERSION = 1;

// Env marker the coordinator sets when spawning a delegate; its presence flips
// the plugin into the delegate role (spec §12 role detection).
export const JOBDIR_ENV = "PEER_DELEGATE_JOBDIR";

export type OutputContract = "advisory" | "code-change";
export type MergePolicy = "manual" | "auto-after-checks";
export type Placement = "pane" | "subworkspace";
export type SessionDisposition = "active" | "paused" | "commit" | "discard";

export interface InteractiveSession {
  protocolVersion: number;
  jobId: string;
  generation: number;
  completionToken: string;
  sessionID?: string;
  status: SessionDisposition;
  summary?: string;
  checks?: string[];
  risks?: string[];
  userInstruction?: string;
  handbackID?: string;
}

export function sessionRoot(): string {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "herdr-envoy", "sessions");
}

export async function withSessionLock<T>(jobId: string, action: () => Promise<T>, retries = 0): Promise<T> {
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("Invalid session lock identity");
  const locks = path.join(sessionRoot(), ".locks");
  await fs.mkdir(locks, { recursive: true, mode: 0o700 });
  const lock = path.join(locks, jobId);
  let handle;
  try {
    handle = await fs.open(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return withSessionLock(jobId, action, retries - 1);
    }
    const pid = Number(await fs.readFile(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Session lock is incomplete; inspect before recovery");
    try { process.kill(pid, 0); }
    catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
      await fs.unlink(lock);
      return withSessionLock(jobId, action);
    }
    throw new Error("Session is being updated by another coordinator; retry later");
  }
  try {
    await handle.writeFile(String(process.pid));
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}

export interface Check {
  command: string;
  expectedExitCode: number;
}

export interface Handoff {
  protocolVersion: number;
  jobId: string;
  generation: number;
  completionToken: string;
  agent: string;
  task: string;
  outputContract: OutputContract;
  targetBranch: string;
  baseCommit: string;
  mergePolicy: MergePolicy;
  checks: Check[];
  startupTimeoutSeconds: number;
  mode?: "interactive";
}

export interface Result {
  protocolVersion: number;
  jobId: string;
  generation: number;
  completionToken: string;
  origin: "delegate" | "controller";
  status: "success" | "failure";
  outputContract: OutputContract;
  summary: string;
  evidence: string[];
  checksPerformed: { command: string; exitCode: number; summary: string }[];
  risks: string[];
  followUps: string[];
  branch?: string;
  baseCommit?: string;
  headCommit?: string;
}

// Delegate asks the coordinator a question mid-task (§13). Written by the
// delegate, watched by the coordinator.
export interface Block {
  protocolVersion: number;
  jobId: string;
  generation: number;
  completionToken: string;
  question: string;
  at: number;
}

// Coordinator's answer to a block. Written by the coordinator, watched by the
// delegate; consumed (unlinked) by the delegate after reading.
export interface Reply {
  protocolVersion: number;
  jobId: string;
  generation: number;
  answer: string;
  at: number;
}

// Auth snapshot the delegate leaves after consuming (unlinking) handoff.json so
// completion can still authenticate. Holds ids/tokens + the task (persisted so a
// restarted delegate can recover its instructions — finding §11a.5).
export interface Consumed {
  protocolVersion: number;
  jobId: string;
  generation: number;
  completionToken: string;
  agent: string;
  task: string;
  outputContract: OutputContract;
  targetBranch: string;
  baseCommit: string;
  mergePolicy: MergePolicy;
  checks: Check[];
  mode?: "interactive";
}

// $XDG_RUNTIME_DIR/herdr (fallback /tmp/herdr-$uid) — outside Git, per-user (spec §1).
export function root(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.tmpdir(), `herdr-${process.getuid?.() ?? "0"}`);
  return path.join(base, "herdr");
}

export function jobDir(jobId: string): string {
  return path.join(root(), jobId);
}

export function rand(): string {
  return randomBytes(16).toString("hex");
}

// Atomic publish: write to a temp file in the same dir, then rename (spec §4).
export async function atomicWriteJSON(dest: string, value: unknown): Promise<void> {
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `.tmp.${rand()}`);
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, dest);
}

export async function readJSON<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// Canonical file names within a job-dir (the whole transport surface).
export const FILES = {
  handoff: "handoff.json",
  consumed: ".consumed.json",
  coordinator: "coordinator.json",
  result: "result.json",
  block: "block.json",
  reply: "reply.json",
  heartbeat: "heartbeat",
  session: "session.json",
} as const;

export function filePath(jobId: string, name: keyof typeof FILES): string {
  return path.join(jobDir(jobId), FILES[name]);
}
