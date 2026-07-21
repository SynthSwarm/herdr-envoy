// verify.ts — coordinator-side verification (§5/§6) + synthetic merge (§7).
// TS port of hd-verify + hd-merge, using the Bun $ shell for git plumbing.
import * as path from "node:path";
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
  for (const f of ["jobId", "generation", "completionToken", "outputContract"] as const) {
    if ((result as any)[f] !== (consumed as any)[f]) {
      return { ok: false, reason: `${f} mismatch: result=${(result as any)[f]} job=${(consumed as any)[f]}` };
    }
  }
  if (result.protocolVersion !== PROTOCOL_VERSION) return { ok: false, reason: "protocol mismatch" };

  if (result.outputContract !== "code-change" || result.status !== "success") {
    return { ok: true }; // advisory / failure: trusted (finding §11a.1), no git checks
  }

  // §5 code-change invariants.
  if (!repo) return { ok: false, reason: "code-change verify needs repo path" };
  const { branch, baseCommit: base, headCommit: head } = result;
  if (!branch || !base || !head) return { ok: false, reason: "missing branch/base/head" };
  const g = (args: string[]) => $`git -C ${repo} ${args}`;

  // clean worktree
  const status = (await g(["status", "--porcelain"]).text()).trim();
  if (status) return { ok: false, reason: "worktree not clean" };
  // >=1 commit past base
  const count = parseInt((await g(["rev-list", "--count", `${base}..${head}`]).text()).trim() || "0", 10);
  if (count < 1) return { ok: false, reason: "no commits past base" };
  // head reachable from branch
  const reachable = await g(["merge-base", "--is-ancestor", head, branch]).then(() => true).catch(() => false);
  if (!reachable) return { ok: false, reason: `head not reachable from ${branch}` };
  // base ancestor of head
  const descends = await g(["merge-base", "--is-ancestor", base, head]).then(() => true).catch(() => false);
  if (!descends) return { ok: false, reason: "base not ancestor of head" };
  // no protocol artifacts committed
  const objects = await g(["rev-list", `${base}..${head}`, "--objects"]).text();
  if (/(handoff|result)\.json|\/complete$/i.test(objects)) {
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
// (finding §11a.2) — caller passes a non-occupied target.
export async function synthMerge(
  $: Shell,
  repo: string,
  branch: string,
  target: string,
  checks: { command: string; expectedExitCode: number }[],
): Promise<MergeOutcome> {
  const g = (args: string[]) => $`git -C ${repo} ${args}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const targetHead = (await g(["rev-parse", target]).text()).trim();
    const ig = (await $`mktemp -d`.text()).trim();
    const cleanup = async () => {
      await g(["worktree", "remove", "--force", ig]).catch(async () => {
        await $`rm -rf ${ig}`.catch(() => {});
      });
    };
    await g(["worktree", "add", "--quiet", "--detach", ig, targetHead]);

    const merged = await $`git -C ${ig} merge --no-ff --no-edit ${branch}`
      .then(() => true)
      .catch(() => false);
    if (!merged) {
      await $`git -C ${ig} merge --abort`.catch(() => {});
      await cleanup();
      return { ok: false, reason: `merge conflict: ${branch} into ${target} — manual merge required` };
    }
    const mergeCommit = (await $`git -C ${ig} rev-parse HEAD`.text()).trim();

    // declared checks in the integration worktree
    for (const c of checks) {
      const rc = await $`sh -c ${c.command}`.cwd(ig).then(() => 0).catch((e: any) => e.exitCode ?? 1);
      if (rc !== c.expectedExitCode) {
        await cleanup();
        return { ok: false, reason: `check failed (rc=${rc} want=${c.expectedExitCode}): ${c.command}` };
      }
    }

    // drift guard
    const now = (await g(["rev-parse", target]).text()).trim();
    if (now !== targetHead) {
      await cleanup();
      if (attempt >= 3) return { ok: false, reason: "target kept drifting after 2 retries — manual merge" };
      continue;
    }
    // fast-forward the real target ref to the validated merge
    await g(["update-ref", `refs/heads/${target}`, mergeCommit, targetHead]);
    await cleanup();
    return { ok: true, mergeCommit };
  }
  return { ok: false, reason: "unreachable" };
}
