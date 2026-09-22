// verify.ts — coordinator-side verification (§5/§6) + synthetic merge (§7).
// TS port of hd-verify + hd-merge, using the Bun $ shell for git plumbing.
import * as path from "node:path";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import type { PluginInput } from "@opencode-ai/plugin";
import { PROTOCOL_VERSION, type Consumed, type Result } from "./protocol.js";

type Shell = PluginInput["$"];

export interface VerifyOutcome {
  ok: boolean;
  reason?: string;
  commits?: number;
}

// §6 identity + §5 code-change invariants. `repo` = the delegate's worktree.
export async function verify(
  $: Shell,
  result: Result,
  consumed: Consumed,
  repo?: string,
): Promise<VerifyOutcome> {
  // §6 identity/token/contract must match the job snapshot.
  if (!result || !["success", "failure"].includes(result.status) ||
      typeof result.jobId !== "string" || !Number.isInteger(result.generation) ||
      typeof result.completionToken !== "string" ||
      !["advisory", "code-change"].includes(result.outputContract) ||
      !["delegate", "controller"].includes(result.origin) ||
      typeof result.summary !== "string" ||
      !Array.isArray(result.checksPerformed) || result.checksPerformed.some((check) =>
        !check || typeof check.command !== "string" || !Number.isInteger(check.exitCode) || typeof check.summary !== "string") ||
      ![result.evidence, result.risks, result.followUps].every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"))) {
    return { ok: false, reason: "invalid result schema" };
  }
  for (const f of ["jobId", "generation", "completionToken", "outputContract"] as const) {
    if ((result as any)[f] !== (consumed as any)[f]) {
      return { ok: false, reason: `${f} mismatch` };
    }
  }
  if (result.protocolVersion !== PROTOCOL_VERSION || consumed.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, reason: "protocol mismatch" };
  }

  if (result.outputContract !== "code-change" || result.status !== "success") {
    return { ok: true }; // advisory / failure: trusted (finding §11a.1), no git checks
  }

  // §5 code-change invariants.
  if (!repo) return { ok: false, reason: "code-change verify needs repo path" };
  const { branch, baseCommit, headCommit } = result;
  if (!branch || !baseCommit || !headCommit) return { ok: false, reason: "missing branch/base/head" };
  if (baseCommit !== consumed.baseCommit) return { ok: false, reason: "assigned base mismatch" };
  const g = (args: string[]) => $`git -C ${repo} ${args}`;
  let base: string, head: string, branchHead: string;
  try {
    if (![branch, baseCommit, headCommit].every((value) => typeof value === "string")) throw new Error();
    await g(["check-ref-format", `refs/heads/${branch}`]);
    const resolve = async (rev: string) => (await g(["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]).text()).trim();
    base = await resolve(baseCommit);
    head = await resolve(headCommit);
    branchHead = await resolve(`refs/heads/${branch}`);
  } catch {
    return { ok: false, reason: "invalid revision" };
  }

  // clean worktree
  const status = (await g(["status", "--porcelain"]).text()).trim();
  if (status) return { ok: false, reason: "worktree not clean" };
  // >=1 commit past base
  const count = parseInt((await g(["rev-list", "--count", `${base}..${head}`]).text()).trim() || "0", 10);
  if (count < 1) return { ok: false, reason: "no commits past base" };
  // head reachable from branch
  const reachable = await g(["merge-base", "--is-ancestor", head, branchHead]).then(() => true).catch(() => false);
  if (!reachable) return { ok: false, reason: "head not reachable from branch" };
  // base ancestor of head
  const descends = await g(["merge-base", "--is-ancestor", base, head]).then(() => true).catch(() => false);
  if (!descends) return { ok: false, reason: "base not ancestor of head" };
  // no protocol artifacts committed
  const objects = await g(["rev-list", `${base}..${head}`, "--objects"]).text();
  if (objects.split("\n").some((line) => /(?:^|\/)(?:handoff\.json|result\.json|complete)$/i.test(line.slice(line.indexOf(" ") + 1)))) {
    return { ok: false, reason: "protocol artifact committed" };
  }
  return { ok: true, commits: count };
}

export interface MergeOutcome {
  ok: boolean;
  reason?: string;
  mergeCommit?: string;
}

// §7 synthetic merge in an isolated integration worktree + declared checks +
// drift retry (<=2). Never merges into a branch checked out by a live worktree
// (finding §11a.2). This dormant helper pins its source at entry; it does not verify it.
export async function synthMerge(
  $: Shell,
  repo: string,
  branch: string,
  target: string,
  checks: { command: string; expectedExitCode: number }[],
): Promise<MergeOutcome> {
  const g = (args: string[]) => $`git -C ${repo} ${args}`;
  const sourceRef = `refs/heads/${branch}`;
  const targetRef = `refs/heads/${target}`;
  const resolve = async (ref: string) => (await g(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).text()).trim();
  const occupied = async () => (await g(["worktree", "list", "--porcelain", "-z"]).text()).split("\0").includes(`branch ${targetRef}`);
  let sourceHead: string;
  try {
    await g(["check-ref-format", sourceRef]);
    await g(["check-ref-format", targetRef]);
    sourceHead = await resolve(sourceRef);
    await resolve(targetRef);
  } catch {
    return { ok: false, reason: "invalid revision" };
  }

  for (let attempt = 0; attempt <= 2; attempt++) {
    if (await occupied()) return { ok: false, reason: "target branch is checked out" };
    const targetHead = await resolve(targetRef);
    const ig = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-merge-"));
    try {
      await g(["worktree", "add", "--quiet", "--detach", ig, targetHead]);
      const merged = await $`git -C ${ig} merge --no-ff --no-edit ${sourceHead}`
        .then(() => true).catch(() => false);
      if (!merged) return { ok: false, reason: "merge conflict: manual merge required" };
      const mergeCommit = (await $`git -C ${ig} rev-parse HEAD`.text()).trim();

      for (const c of checks) {
        const rc = await $`sh -c ${c.command}`.cwd(ig).then(() => 0).catch((e: any) => e.exitCode ?? 1);
        if (rc !== c.expectedExitCode) {
          return { ok: false, reason: `check failed (rc=${rc} want=${c.expectedExitCode})` };
        }
      }

      if (await resolve(sourceRef) !== sourceHead) return { ok: false, reason: "source branch changed: manual merge required" };
      if (await occupied()) return { ok: false, reason: "target branch is checked out" };
      // Compare-and-swap also catches drift between the read and the update.
      if (await resolve(targetRef) === targetHead) {
        try {
          await g(["update-ref", targetRef, mergeCommit, targetHead]);
          return { ok: true, mergeCommit };
        } catch (error) {
          if (await resolve(targetRef) === targetHead) throw error;
        }
      }
      if (attempt === 2) return { ok: false, reason: "target kept drifting after 2 retries: manual merge" };
    } finally {
      await g(["worktree", "remove", "--force", ig]).catch(async () => {
        await fs.rm(ig, { recursive: true, force: true });
        await g(["worktree", "prune", "--expire", "now"]);
      });
    }
  }
  return { ok: false, reason: "unreachable" };
}
