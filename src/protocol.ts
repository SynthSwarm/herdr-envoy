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
} as const;

export function filePath(jobId: string, name: keyof typeof FILES): string {
  return path.join(jobDir(jobId), FILES[name]);
}
