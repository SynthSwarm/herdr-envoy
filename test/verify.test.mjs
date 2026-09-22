import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verify, synthMerge } from "../dist/verify.js";
import { PROTOCOL_VERSION } from "../dist/protocol.js";

const exec = promisify(execFile);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-verify-"));
  const repo = path.join(dir, "repo with spaces");
  const integrations = new Set();
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    for (const worktree of integrations) await fs.rm(worktree, { recursive: true, force: true });
  });
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no",
  };
  await exec("git", ["init", "-q", "-b", "trunk", repo], { env });
  const git = async (...args) => (await exec("git", ["-C", repo, ...args], { env })).stdout.trim();
  const commit = async (name, content = name) => {
    await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await fs.writeFile(path.join(repo, name), content);
    await git("add", "--", name);
    await git("commit", "-q", "-m", name);
    return git("rev-parse", "HEAD");
  };
  const base = await commit("shared.txt", "base\n");
  await git("branch", "integration");
  await git("switch", "-q", "-c", "delegate/test");
  const head = await commit("feature.txt");
  const consumed = {
    protocolVersion: PROTOCOL_VERSION, jobId: "job-id", generation: 1,
    completionToken: "private-completion-token", outputContract: "code-change",
    agent: "worker", task: "test", targetBranch: "integration", baseCommit: base,
    mergePolicy: "manual", checks: [],
  };
  const result = {
    protocolVersion: PROTOCOL_VERSION, jobId: consumed.jobId, generation: 1,
    completionToken: consumed.completionToken, outputContract: "code-change",
    origin: "delegate", status: "success", summary: "Completed", evidence: [],
    risks: [], followUps: [], checksPerformed: [], branch: "delegate/test", baseCommit: base, headCommit: head,
  };
  const calls = [];
  let before = async () => {};
  let after = async () => {};
  const shell = (strings, ...values) => {
    // Preserve interpolation boundaries, including array arguments, as Bun does.
    const words = [];
    strings.forEach((literal, i) => {
      words.push(...literal.trim().split(/\s+/).filter(Boolean));
      if (i < values.length) words.push(...(Array.isArray(values[i]) ? values[i] : [String(values[i])]));
    });
    let cwd;
    let promise;
    const run = () => promise ??= (async () => {
      calls.push(words);
      if (words[3] === "worktree" && words[4] === "add") integrations.add(words[7]);
      await before(words, cwd);
      let output;
      try {
        output = await exec(words[0], words.slice(1), { cwd, env });
      } catch (error) {
        // Bun exposes exitCode, whereas execFile exposes code.
        error.exitCode = error.code;
        throw error;
      }
      await after(words, cwd);
      return output;
    })();
    const command = {
      cwd(value) { cwd = value; return command; },
      quiet() { return command; },
      text: async () => (await run()).stdout,
      then: (...args) => run().then(...args),
      catch: (...args) => run().catch(...args),
    };
    return command;
  };
  const clean = async () => {
    assert.equal((await git("worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
    for (const worktree of integrations) await assert.rejects(fs.access(worktree), { code: "ENOENT" });
  };
  let serial = 0;
  const advance = async (branch = "integration") => {
    const parent = await git("rev-parse", `refs/heads/${branch}`);
    const tree = await git("rev-parse", `${parent}^{tree}`);
    const next = await git("commit-tree", tree, "-p", parent, "-m", `drift-${++serial}`);
    await git("update-ref", `refs/heads/${branch}`, next, parent);
    return next;
  };
  return {
    repo, dir, git, commit, base, head, result, consumed, shell, calls, integrations, clean, advance,
    before(fn) { before = fn; }, after(fn) { after = fn; },
    verify: (overrides = {}, snapshot = consumed) => verify(shell, { ...result, ...overrides }, snapshot, repo),
    merge: (checks = []) => synthMerge(shell, repo, "delegate/test", "integration", checks),
  };
}

test("verify accepts a clean code-change and counts commits", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.verify(), { ok: true, commits: 1 });
  const headCommit = await f.commit("second.txt");
  assert.deepEqual(await f.verify({ headCommit }), { ok: true, commits: 2 });
  // A reachable reported head need not be the current branch tip.
  assert.deepEqual(await f.verify(), { ok: true, commits: 1 });
});

test("verify rejects identity mismatches without disclosing values", async (t) => {
  const f = await fixture(t);
  for (const [field, value] of [["jobId", "other-job"], ["generation", 2], ["completionToken", "forged-token"], ["outputContract", "advisory"]]) {
    const outcome = await f.verify({ [field]: value });
    assert.deepEqual(outcome, { ok: false, reason: `${field} mismatch` });
    assert.doesNotMatch(JSON.stringify(outcome), /private-completion-token|forged-token|other-job/);
  }
  assert.equal(f.calls.length, 0);
});

test("verify validates result schema and both protocol versions before Git", async (t) => {
  const f = await fixture(t);
  for (const value of [null, [], "result", 1]) {
    assert.deepEqual(await verify(f.shell, value, f.consumed, f.repo), { ok: false, reason: "invalid result schema" });
  }
  const invalid = {
    status: [undefined, "done"], summary: [null, 1], origin: [undefined, "unknown"],
    jobId: [null, 1], generation: [undefined, 1.5, "1"], completionToken: [undefined, 1],
    outputContract: [undefined, "unknown"], evidence: [undefined, "text", [1]],
    risks: [null, [false]], followUps: [undefined, [{}]],
    checksPerformed: [undefined, {}, [null], [{ command: "true", exitCode: "0", summary: "ok" }],
      [{ command: 1, exitCode: 0, summary: "ok" }], [{ command: "true", exitCode: 0, summary: null }]],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) assert.deepEqual(await f.verify({ [field]: value }), { ok: false, reason: "invalid result schema" }, field);
  }
  for (const protocolVersion of [undefined, "1", PROTOCOL_VERSION + 1]) {
    assert.deepEqual(await f.verify({ protocolVersion }), { ok: false, reason: "protocol mismatch" });
  }
  assert.deepEqual(await f.verify({}, { ...f.consumed, protocolVersion: 99 }), { ok: false, reason: "protocol mismatch" });
  assert.equal(f.calls.length, 0);
});

test("advisory and failure reports skip Git, but not authentication", async (t) => {
  const f = await fixture(t);
  for (const outputContract of ["advisory", "code-change"]) {
    for (const status of ["success", "failure"]) {
      if (outputContract === "code-change" && status === "success") continue;
      const result = { ...f.result, outputContract, status, origin: "controller", checksPerformed: [{ command: "true", exitCode: 0, summary: "ok" }] };
      const consumed = { ...f.consumed, outputContract };
      assert.deepEqual(await verify(f.shell, result, consumed), { ok: true });
      assert.deepEqual(await verify(f.shell, { ...result, completionToken: "forged" }, consumed), { ok: false, reason: "completionToken mismatch" });
    }
  }
  assert.equal(f.calls.length, 0);
});

test("verify requires repo, declared fields and the assigned base", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await verify(f.shell, f.result, f.consumed), { ok: false, reason: "code-change verify needs repo path" });
  for (const field of ["branch", "baseCommit", "headCommit"]) {
    for (const value of [undefined, ""]) assert.deepEqual(await f.verify({ [field]: value }), { ok: false, reason: "missing branch/base/head" });
  }
  assert.deepEqual(await f.verify({ baseCommit: f.head }), { ok: false, reason: "assigned base mismatch" });
  assert.equal(f.calls.length, 0);
});

test("invalid revisions are rejections, not exceptions or Git options", async (t) => {
  const f = await fixture(t);
  for (const field of ["branch", "baseCommit", "headCommit"]) {
    for (const value of ["does-not-exist", "--all", "--output=private-completion-token", "HEAD:shared.txt", 7, {}, [f.head]]) {
      const snapshot = field === "baseCommit" ? { ...f.consumed, baseCommit: value } : f.consumed;
      assert.deepEqual(await f.verify({ [field]: value }, snapshot), { ok: false, reason: "invalid revision" }, `${field}: ${JSON.stringify(value)}`);
    }
  }
  assert.ok(f.calls.filter((args) => args[3] === "rev-parse").every((args) => args[4] === "--verify" && args[5] === "--end-of-options"));
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("verify rejects untracked, unstaged and staged changes", async (t) => {
  for (const kind of ["untracked", "unstaged", "staged"]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      await fs.writeFile(path.join(f.repo, kind === "untracked" ? "new.txt" : "feature.txt"), "dirty");
      if (kind === "staged") await f.git("add", "feature.txt");
      assert.deepEqual(await f.verify(), { ok: false, reason: "worktree not clean" });
    });
  }
});

test("verify rejects no commits, unreachable heads and unrelated ancestry", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.verify({ headCommit: f.base }), { ok: false, reason: "no commits past base" });
  const other = await f.advance("integration");
  assert.deepEqual(await f.verify({ headCommit: other }), { ok: false, reason: "head not reachable from branch" });
  const unrelated = await f.git("commit-tree", `${f.head}^{tree}`, "-m", "unrelated root");
  await f.git("branch", "unrelated", unrelated);
  assert.deepEqual(await f.verify({ branch: "unrelated", headCommit: unrelated }), { ok: false, reason: "base not ancestor of head" });
});

test("verify detects protocol artefacts anywhere in the commit range", async (t) => {
  for (const file of ["handoff.json", "nested/result.json", "complete", "nested/complete", "nested/HANDOFF.JSON"]) {
    await t.test(file, async (t) => {
      const f = await fixture(t);
      await f.commit(file);
      // Removing an artefact from the final tree must not hide the earlier commit.
      await f.git("rm", "--", file);
      await f.git("commit", "-q", "-m", "remove artefact");
      const headCommit = await f.git("rev-parse", "HEAD");
      assert.deepEqual(await f.verify({ headCommit }), { ok: false, reason: "protocol artifact committed" });
    });
  }
});

test("verify does not mistake ordinary filenames for protocol artefacts", async (t) => {
  const f = await fixture(t);
  for (const file of ["myresult.json", "handoff.json.md", "incomplete", "nested/complete.txt"]) await f.commit(file);
  assert.deepEqual(await f.verify({ headCommit: await f.git("rev-parse", "HEAD") }), { ok: true, commits: 5 });
});

test("synthMerge checks the isolated merge and accepts declared nonzero exit codes", async (t) => {
  const f = await fixture(t);
  const outcome = await f.merge([
    { command: "test -f shared.txt && test -f feature.txt && test -z \"$(git symbolic-ref -q HEAD)\"", expectedExitCode: 0 },
    { command: "exit 7", expectedExitCode: 7 },
  ]);
  assert.equal(outcome.ok, true);
  assert.equal(await f.git("rev-parse", "integration"), outcome.mergeCommit);
  assert.equal(await f.git("show", "-s", "--format=%P", outcome.mergeCommit), `${f.base} ${f.head}`);
  assert.equal(await f.git("rev-parse", "HEAD"), f.head);
  assert.equal(await f.git("status", "--porcelain"), "");
  const checks = f.calls.filter((args) => args[0] === "sh");
  assert.equal(checks.length, 2);
  await f.clean();
});

test("synthMerge rejects failed checks without leaking commands or updating target", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.merge([{ command: "# private-completion-token\nexit 7", expectedExitCode: 0 }]), { ok: false, reason: "check failed (rc=7 want=0)" });
  assert.equal(await f.git("rev-parse", "integration"), f.base);
  await f.clean();
  f.before(async (args) => { if (args[0] === "sh") throw new Error("no exit code"); });
  assert.deepEqual(await f.merge([{ command: "true", expectedExitCode: 0 }]), { ok: false, reason: "check failed (rc=1 want=0)" });
  await f.clean();
});

test("synthMerge rejects conflicts and removes the conflicted worktree", async (t) => {
  const f = await fixture(t);
  await f.commit("shared.txt", "delegate\n");
  await f.git("switch", "-q", "integration");
  const targetHead = await f.commit("shared.txt", "target\n");
  await f.git("switch", "-q", "delegate/test");
  assert.deepEqual(await f.merge(), { ok: false, reason: "merge conflict: manual merge required" });
  assert.equal(await f.git("rev-parse", "integration"), targetHead);
  await f.clean();
});

test("synthMerge rejects invalid source and target revisions before allocating worktrees", async (t) => {
  const f = await fixture(t);
  for (const [branch, target] of [["missing", "integration"], ["delegate/test", "missing"], ["--help", "integration"], ["delegate/test", "../bad"]]) {
    assert.deepEqual(await synthMerge(f.shell, f.repo, branch, target, []), { ok: false, reason: "invalid revision" });
  }
  assert.equal(f.integrations.size, 0);
});

test("synthMerge never updates a target occupied by the main or a linked worktree", async (t) => {
  for (const linked of [false, true]) {
    await t.test(linked ? "linked" : "main", async (t) => {
      const f = await fixture(t);
      const worktree = path.join(f.dir, "occupied");
      if (linked) await f.git("worktree", "add", "-q", worktree, "integration");
      else await f.git("switch", "-q", "integration");
      assert.deepEqual(await f.merge(), { ok: false, reason: "target branch is checked out" });
      assert.equal(await f.git("rev-parse", "integration"), f.base);
      assert.equal(f.integrations.size, 0);
      if (linked) await f.git("worktree", "remove", worktree);
      await f.clean();
    });
  }
});

test("synthMerge rechecks occupancy after running checks", async (t) => {
  const f = await fixture(t);
  f.before(async (args) => { if (args[0] === "sh") await f.git("switch", "-q", "integration"); });
  assert.deepEqual(await f.merge([{ command: "true", expectedExitCode: 0 }]), { ok: false, reason: "target branch is checked out" });
  assert.equal(await f.git("rev-parse", "integration"), f.base);
  await f.clean();
});

test("synthMerge pins source and rejects source drift before merge or during checks", async (t) => {
  for (const phase of ["merge", "checks"]) {
    await t.test(phase, async (t) => {
      const f = await fixture(t);
      f.before(async (args) => {
        if ((phase === "merge" && args[3] === "merge") || (phase === "checks" && args[0] === "sh")) await f.advance("delegate/test");
      });
      assert.deepEqual(await f.merge([{ command: "true", expectedExitCode: 0 }]), { ok: false, reason: "source branch changed: manual merge required" });
      const merge = f.calls.find((args) => args[3] === "merge");
      assert.equal(merge.at(-1), f.head);
      assert.equal(await f.git("rev-parse", "integration"), f.base);
      await f.clean();
    });
  }
});

test("synthMerge retries target drift at most twice, including compare-and-swap races", async (t) => {
  for (const phase of ["checks", "update-ref"]) {
    for (const drifts of [1, 2, 3]) {
      await t.test(`${phase}: ${drifts} drifts`, async (t) => {
        const f = await fixture(t);
        let attempts = 0;
        let targetHead = f.base;
        f.before(async (args) => {
          if ((phase === "checks" && args[0] === "sh") || (phase === "update-ref" && args[3] === "update-ref")) {
            if (++attempts <= drifts) targetHead = await f.advance();
          }
        });
        const outcome = await f.merge([{ command: "true", expectedExitCode: 0 }]);
        assert.equal(attempts, Math.min(drifts + 1, 3));
        assert.equal(f.integrations.size, Math.min(drifts + 1, 3));
        if (drifts < 3) {
          assert.equal(outcome.ok, true);
          assert.equal(await f.git("rev-parse", "integration"), outcome.mergeCommit);
          assert.equal(await f.git("show", "-s", "--format=%P", outcome.mergeCommit), `${targetHead} ${f.head}`);
        } else {
          assert.deepEqual(outcome, { ok: false, reason: "target kept drifting after 2 retries: manual merge" });
          assert.equal(await f.git("rev-parse", "integration"), targetHead);
        }
        await f.clean();
      });
    }
  }
});

test("synthMerge cleans temporary directories and registrations on exceptions", async (t) => {
  for (const phase of ["add-before", "add-after", "merge-head", "target-read", "update-ref"]) {
    await t.test(phase, async (t) => {
      const f = await fixture(t);
      const fail = async (args) => {
        const add = args[3] === "worktree" && args[4] === "add";
        if ((phase.startsWith("add-") && add) ||
            (phase === "merge-head" && args[2] !== f.repo && args[3] === "rev-parse") ||
            (phase === "target-read" && f.integrations.size > 0 && args[3] === "rev-parse" && args.at(-1) === "refs/heads/integration^{commit}") ||
            (phase === "update-ref" && args[3] === "update-ref")) throw new Error("injected failure");
      };
      if (phase === "add-after") f.after(fail);
      else f.before(fail);
      await assert.rejects(f.merge(), /injected failure/);
      assert.equal(await f.git("rev-parse", "integration"), f.base);
      await f.clean();
    });
  }
});

test("synthMerge falls back to filesystem removal and prunes stale registrations", async (t) => {
  for (const outcome of ["success", "check failure", "exception"]) {
    await t.test(outcome, async (t) => {
      const f = await fixture(t);
      f.before(async (args) => {
        if (args[3] === "worktree" && args[4] === "remove") throw new Error("remove failed");
        if (outcome === "exception" && args[3] === "update-ref") throw new Error("update failed");
      });
      if (outcome === "exception") await assert.rejects(f.merge(), /update failed/);
      else if (outcome === "check failure") assert.equal((await f.merge([{ command: "exit 1", expectedExitCode: 0 }])).ok, false);
      else assert.equal((await f.merge()).ok, true);
      await f.clean();
    });
  }
});

test("synthMerge surfaces cleanup exceptions after removing the temporary directory", async (t) => {
  const f = await fixture(t);
  f.before(async (args) => {
    if (args[3] === "worktree" && ["remove", "prune"].includes(args[4])) throw new Error("cleanup unavailable");
  });
  await assert.rejects(f.merge([{ command: "exit 1", expectedExitCode: 0 }]), /cleanup unavailable/);
  assert.equal(await f.git("rev-parse", "integration"), f.base);
  for (const worktree of f.integrations) await assert.rejects(fs.access(worktree), { code: "ENOENT" });
  // Failed Git metadata cleanup is observable, rather than reported as success.
  await f.git("worktree", "prune", "--expire", "now");
  await f.clean();
});
