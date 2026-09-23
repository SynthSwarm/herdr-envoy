import assert from "node:assert/strict";
import { test } from "node:test";
import nodeFs, { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Coordinator, delegateTool, reapTool, replyTool } from "../dist/coordinator.js";
import { consume, completeTool } from "../dist/delegate.js";
import { atomicWriteJSON, FILES, PROTOCOL_VERSION, root } from "../dist/protocol.js";
import { createOpencodeClient } from "@opencode-ai/sdk";

const exec = promisify(execFile);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-test-"));
  const env = { ...process.env };
  process.env.XDG_RUNTIME_DIR = path.join(dir, "runtime");
  process.env.XDG_STATE_HOME = path.join(dir, "state");
  process.env.HERDR_PANE_ID = "coordinator-pane";
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  await exec("git", ["init", "-q", repo]);
  const git = (...args) => exec("git", ["-C", repo, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  });
  await git("commit", "-q", "--allow-empty", "-m", "base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  const calls = [];
  const options = {
    agents: "worker (primary)\n",
    agentError: null,
    layout: "{}",
    layoutError: false,
    paneList: null,
    waitFailure: false,
    direnvFailure: false,
    readbackStatus: null,
    receiptParts: null,
    sessionStatus: null,
    toastFailure: false,
  };
  let failClose = false;
  let failRename = false;
  let pane = 0;
  const panes = new Set();
  const shell = (strings, ...values) => {
    // Bun parses literal shell syntax before interpolation. execFile alone misses this.
    assert.ok(strings.every((literal) => !literal.includes("%(refname)")), "Git format parentheses must be passed through interpolation, not literal shell syntax");
    // Preserve interpolation boundaries just like Bun's tagged shell.
    const words = [];
    strings.forEach((literal, i) => {
      words.push(...literal.trim().split(/\s+/).filter(Boolean));
      if (i < values.length) words.push(...(Array.isArray(values[i]) ? values[i] : [String(values[i])]));
    });
    let cwd;
    let promise;
    const run = () => promise ??= (async () => {
      calls.push(words);
      if (words[0] === "opencode") {
        if (options.agentError) throw options.agentError;
        assert.equal(cwd, repo, "agent discovery runs in the target repository");
        return { stdout: options.agents };
      }
      if (words[0] === "direnv") {
        if (options.direnvFailure) throw new Error("direnv unavailable");
        return { stdout: "" };
      }
      if (words[0] === "herdr") {
        if (words[1] === "wait" && options.waitFailure) throw new Error("shell readiness timeout");
        if (words[2] === "layout") {
          if (options.layoutError) throw new Error("layout unavailable");
          return { stdout: options.layout };
        }
        if (words[2] === "list") return { stdout: options.paneList ?? JSON.stringify({ result: { panes: [...panes].map((pane_id) => ({ pane_id })) } }) };
        if (words[2] === "close" && failClose) throw new Error("pane close failed");
        if (words[2] === "close") panes.delete(words[3]);
        if (words[2] === "rename" && failRename) throw new Error("pane rename failed");
        if (words[2] === "split") {
          const pane_id = `pane-${++pane}`;
          panes.add(pane_id);
          return { stdout: JSON.stringify({ result: { pane: { pane_id } } }) };
        }
        return { stdout: "{}" };
      }
      return exec(words[0], words.slice(1), { cwd });
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
  const messages = new Map();
  const posts = [];
  const toasts = [];
  let httpFailure = false;
  let loseResponse = false;
  let busy = false;
  const sdk = createOpencodeClient({ baseUrl: "http://envoy.invalid", fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/session/status") return Response.json(options.sessionStatus ?? (busy ? { owner: { type: "busy" } } : {}));
    if (url.pathname.endsWith("/prompt_async")) {
      const body = await request.json();
      posts.push({ path: url.pathname, ...body });
      if (httpFailure) return Response.json({ error: "unavailable" }, { status: 503 });
      messages.set(body.messageID, { parts: options.receiptParts ?? body.parts });
      if (loseResponse) throw new Error("lost response after acceptance");
      return new Response(null, { status: 204 });
    }
    if (options.readbackStatus) return Response.json({ error: "read-back unavailable" }, { status: options.readbackStatus });
    const message = messages.get(url.pathname.split("/").at(-1));
    return Response.json(message ?? { error: "missing" }, { status: message ? 200 : 404 });
  } });
  const client = { session: sdk.session, tui: { showToast: async ({ body }) => {
    toasts.push(body);
    if (options.toastFailure) throw new Error("TUI unavailable");
    return {};
  } } };
  const coordinators = [];
  const coordinator = (directory = repo) => {
    const c = new Coordinator(shell, client, directory);
    coordinators.push(c);
    return c;
  };
  const c = coordinator();
  const input = { agent: "worker", task: "test task", repo, branch: "delegate/test", outputContract: "advisory", sessionID: "owner", baseCommit: base };
  const publish = async (job, overrides = {}) => {
    const state = await consume(job.jobDir);
    await completeTool(state).execute({ status: "success", summary: "Test completed", evidence: [], risks: [], followUps: [], ...overrides });
  };
  const metadata = async (job) => JSON.parse(await fs.readFile(path.join(job.jobDir, "coordinator.json"), "utf8"));
  t.after(async () => {
    for (const coord of coordinators) await coord.dispose();
    await fs.rm(dir, { recursive: true, force: true });
    for (const key of ["XDG_RUNTIME_DIR", "XDG_STATE_HOME", "HERDR_PANE_ID"]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });
  return { c, coordinator, repo, base, git, input, calls, posts, publish, metadata, panes, options, messages, toasts,
    failure: (value) => { httpFailure = value; }, lost: (value) => { loseResponse = value; },
    busy: (value) => { busy = value; }, closeFailure: (value) => { failClose = value; }, renameFailure: (value) => { failRename = value; } };
}

test("HTTP error retains pending result; restart retries the original session without a watch event", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  await f.publish(job);
  f.failure(true);
  await f.c.reconcile(job.jobId);
  const failed = await f.metadata(job);
  assert.deepEqual(failed.delivered, []);
  assert.equal(f.posts.length, 1);
  const pendingID = failed.pending.messageID;
  await f.c.dispose();
  // Advance the persisted retry clock without a wall-clock sleep.
  failed.pending.attemptedAt = 1;
  await fs.writeFile(path.join(job.jobDir, "coordinator.json"), JSON.stringify(failed));
  f.failure(false);
  const recovered = f.coordinator();
  await recovered.recover();
  await recovered.reconcile(job.jobId);
  assert.deepEqual((await f.metadata(job)).delivered, ["result"]);
  assert.equal(f.posts[1].messageID, pendingID);
  assert.equal(f.posts[1].path, "/session/owner/prompt_async");
  await recovered.reconcile(job.jobId);
  assert.equal(f.posts.length, 2);
});

test("ambiguous transport failure is recovered by message read-back without resending", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  await f.publish(job);
  f.lost(true);
  await f.c.reconcile(job.jobId);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);
  assert.deepEqual((await f.metadata(job)).delivered, ["result"]);
});

test("busy session defers delivery and concurrent scans only deliver once", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  await f.publish(job);
  f.busy(true);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 0);
  const queuedID = (await f.metadata(job)).pending.messageID;
  f.busy(false);
  await Promise.all(Array.from({ length: 5 }, () => f.c.reconcile(job.jobId)));
  assert.equal(f.posts.length, 1);
  assert.notEqual(f.posts[0].messageID, queuedID);
});

test("recovery excludes other coordinator panes and tools bind the invoking session", async (t) => {
  const f = await fixture(t);
  const tool = delegateTool(f.c);
  await tool.execute(f.input, { sessionID: "actual-owner" });
  const split = f.calls.find((args) => args[2] === "split");
  const jobID = path.basename(split[split.indexOf("--cwd") + 1]);
  const job = { jobId: jobID, jobDir: path.join(process.env.XDG_RUNTIME_DIR, "herdr", jobID) };
  assert.equal((await f.metadata(job)).sessionID, "actual-owner");
  assert.equal(f.c.resolveJobId(jobID, "another-session"), undefined);
  await f.c.dispose();
  process.env.HERDR_PANE_ID = "another-pane";
  const other = f.coordinator();
  await other.recover();
  assert.equal(other.resolveJobId(jobID), undefined);
});

test("colliding branch slugs have distinct worktrees at the declared base", async (t) => {
  const f = await fixture(t);
  await f.git("commit", "-q", "--allow-empty", "-m", "unrelated change");
  const first = await f.c.createJob({ ...f.input, branch: "delegate/foo" });
  const second = await f.c.createJob({ ...f.input, branch: "delegate-foo" });
  const a = await f.c.spawnDelegate(first.jobId, f.input);
  const b = await f.c.spawnDelegate(second.jobId, f.input);
  assert.notEqual(a.worktree, b.worktree);
  assert.equal((await exec("git", ["-C", a.worktree, "rev-parse", "HEAD"])).stdout.trim(), f.base);
  assert.equal((await exec("git", ["-C", b.worktree, "rev-parse", "HEAD"])).stdout.trim(), f.base);
  await assert.rejects(f.c.createJob({ ...f.input, branch: "delegate/foo" }), /already exists/);
  await f.c.reap(first.jobId);
  await fs.access(b.worktree);
});

test("failed pane close preserves checkout and retry completes cleanup", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  const spawned = await f.c.spawnDelegate(job.jobId, f.input);
  f.closeFailure(true);
  await assert.rejects(f.c.reap(job.jobId), /close failed/);
  await fs.access(spawned.worktree);
  assert.equal(f.c.resolveJobId(job.jobId), job.jobId);
  f.closeFailure(false);
  await f.c.reap(job.jobId);
  assert.equal(f.c.resolveJobId(job.jobId), undefined);
  await f.c.reap(job.jobId);
});

test("dirty checkout survives cleanup and remains retryable", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  const spawned = await f.c.spawnDelegate(job.jobId, f.input);
  const unsaved = path.join(spawned.worktree, "unsaved.txt");
  await fs.writeFile(unsaved, "preserve me");
  await assert.rejects(f.c.reap(job.jobId));
  assert.equal(await fs.readFile(unsaved, "utf8"), "preserve me");
  assert.equal(f.c.resolveJobId(job.jobId), job.jobId);
  await fs.unlink(unsaved);
  await f.c.reap(job.jobId);
});

test("failed spawn rolls back its pane, checkout and branch", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  f.renameFailure(true);
  await assert.rejects(f.c.spawnDelegate(job.jobId, f.input), /rename failed/);
  assert.equal(f.c.resolveJobId(job.jobId), undefined);
  await assert.rejects(f.git("show-ref", "--verify", "refs/heads/delegate/test"));
  assert.ok(f.calls.some((args) => args[2] === "close"));
});

test("unsupported auto-merge and missing pane fail before resources are allocated", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.c.createJob({ ...f.input, mergePolicy: "auto-after-checks" }), /not implemented/);
  delete process.env.HERDR_PANE_ID;
  await assert.rejects(f.c.createJob(f.input), /HERDR_PANE_ID/);
  assert.equal(f.calls.length, 0);
});

test("invalid token is rejected without exposing token values", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  await f.publish(job);
  const resultFile = path.join(job.jobDir, "result.json");
  const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
  result.completionToken = "forged-token";
  await fs.writeFile(resultFile, JSON.stringify(result));
  await f.c.reconcile(job.jobId);
  assert.match(f.posts[0].parts[0].text, /REJECTED.*completionToken mismatch/);
  assert.doesNotMatch(f.posts[0].parts[0].text, /forged-token/);
});

test("notification message IDs use OpenCode timestamp ordering", async (t) => {
  const f = await fixture(t);
  const before = Date.now();
  const job = await f.c.createJob(f.input);
  await f.publish(job);
  await f.c.reconcile(job.jobId);
  const id = f.posts[0].messageID;
  assert.match(id, /^msg_[0-9a-f]{26}$/);
  const packed = BigInt(`0x${id.slice(4, 16)}`);
  const expected = (BigInt(before) * 0x1000n) & 0xffffffffffffn;
  assert.ok(packed >= expected);
  assert.ok(packed <= (BigInt(Date.now() + 1) * 0x1000n & 0xffffffffffffn));
});

test("concurrent reaps close a pane only once", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  await f.c.spawnDelegate(job.jobId, f.input);
  await Promise.all([f.c.reap(job.jobId), f.c.reap(job.jobId)]);
  assert.equal(f.calls.filter((args) => args[2] === "close").length, 1);
});

test("cleanup recovers resources deleted before a persisted checkpoint", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  const spawned = await f.c.spawnDelegate(job.jobId, f.input);
  await f.c.dispose();
  f.panes.delete(spawned.pane);
  await f.git("worktree", "remove", spawned.worktree);
  await f.git("branch", "-d", f.input.branch);
  const recovered = f.coordinator();
  await recovered.recover();
  await recovered.reap(job.jobId, { deleteBranch: true });
  assert.equal(recovered.resolveJobId(job.jobId), undefined);
});

test("nonexistent completion commit produces a rejection notification", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob({ ...f.input, outputContract: "code-change" });
  await f.c.spawnDelegate(job.jobId, f.input);
  await f.publish(job, { branch: f.input.branch, baseCommit: f.base, headCommit: "nonexistent-commit" });
  // The first call can join a watch scan that started before result publication.
  await f.c.reconcile(job.jobId);
  await f.c.reconcile(job.jobId);
  assert.match(f.posts[0].parts[0].text, /REJECTED.*invalid revision/);
});

test("blocked notifications authenticate identity, deduplicate each question and reply only for the owning session", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  const { consumed } = await consume(job.jobDir);
  const block = {
    protocolVersion: PROTOCOL_VERSION, jobId: job.jobId, generation: consumed.generation,
    completionToken: consumed.completionToken, question: "Which target should I use?", at: 1,
  };
  f.options.toastFailure = true;
  await atomicWriteJSON(path.join(job.jobDir, FILES.block), block);
  await f.c.reconcile(job.jobId);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].parts[0].text, /BLOCKED.*\n"Which target should I use\?"/);
  assert.match(f.posts[0].parts[0].text, /reply_delegate/);
  assert.deepEqual(f.toasts, [{ message: `delegate ${job.jobId.slice(0, 8)}: BLOCKED`, variant: "warning" }]);
  assert.deepEqual((await f.metadata(job)).delivered, ["block:1"]);
  assert.equal((await f.metadata(job)).consumed, undefined, "auth must not enter coordinator metadata");

  const reply = replyTool(f.c);
  const short = job.jobId.slice(0, 8);
  assert.equal(f.c.resolveJobId(short.slice(0, 7)), undefined);
  assert.equal(await reply.execute({ jobId: short, answer: "wrong owner" }, { sessionID: "other" }), `No tracked job matching '${short}'.`);
  await assert.rejects(fs.access(path.join(job.jobDir, FILES.reply)));
  assert.match(await reply.execute({ jobId: short, answer: "Use staging" }, { sessionID: "owner" }), /Replied to job/);
  const answer = JSON.parse(await fs.readFile(path.join(job.jobDir, FILES.reply), "utf8"));
  assert.deepEqual({ ...answer, at: 0 }, {
    protocolVersion: PROTOCOL_VERSION, jobId: job.jobId, generation: consumed.generation, answer: "Use staging", at: 0,
  });
  assert.ok(answer.at > 0);

  await atomicWriteJSON(path.join(job.jobDir, FILES.block), { ...block, at: 2, question: "May I continue?" });
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 2);
  assert.match(f.posts[1].parts[0].text, /May I continue\?/);
  assert.deepEqual((await f.metadata(job)).delivered, ["block:1", "block:2"]);
});

test("invalid block identities are retained for inspection without notifying", async (t) => {
  const f = await fixture(t);
  const errors = t.mock.method(console, "error", () => {});
  const job = await f.c.createJob(f.input);
  const handoff = JSON.parse(await fs.readFile(path.join(job.jobDir, FILES.handoff), "utf8"));
  const block = { ...handoff, question: "Proceed?", at: 1 };
  await atomicWriteJSON(path.join(job.jobDir, FILES.block), block);
  await f.c.reconcile(job.jobId);
  await consume(job.jobDir);
  for (const overrides of [{ jobId: "another-job" }, { generation: 2 }, { completionToken: "invalid" }]) {
    await atomicWriteJSON(path.join(job.jobDir, FILES.block), { ...block, ...overrides });
    await f.c.reconcile(job.jobId);
  }
  assert.equal(errors.mock.callCount(), 1, "repeated failures are rate-limited");
  for (const call of errors.mock.calls) assert.match(String(call.arguments[1]), /invalid block identity/);
  assert.equal(f.posts.length, 0);
  assert.deepEqual((await f.metadata(job)).delivered, []);
  await fs.access(path.join(job.jobDir, FILES.block));
});

test("missing consumed handoff rejects result and reply, while a vanished block is best-effort", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  f.options.toastFailure = true;
  await assert.rejects(f.c.notifyResult(job.jobId, { status: "success" }), /without consumed handoff/);
  assert.match(await replyTool(f.c).execute({ jobId: job.jobId, answer: "Proceed" }, { sessionID: "owner" }), /Could not reply.*no job/);
  assert.equal(f.posts.length, 0);
  await f.c.notifyBlock(job.jobId, "block:vanished");
  await f.c.notifyBlock(job.jobId, "block:vanished");
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].parts[0].text, /asks:\n""/);
});

test("reap tool filters sessions and removes only the selected job", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  const spawned = await f.c.spawnDelegate(job.jobId, f.input);
  const reap = reapTool(f.c);
  const short = job.jobId.slice(0, 8);
  assert.equal(await reap.execute({ jobId: short }, { sessionID: "other" }), `No tracked job matching '${short}'.`);
  await fs.access(spawned.worktree);
  assert.match(await reap.execute({ jobId: short, deleteBranch: true }, { sessionID: "owner" }), /Reaped job.*pane closed/);
  await assert.rejects(fs.access(spawned.worktree));
  await assert.rejects(fs.access(job.jobDir));
  await assert.rejects(f.git("show-ref", "--verify", `refs/heads/${f.input.branch}`));
  assert.equal(f.panes.has(spawned.pane), false);
});

test("startup timeout uses the configured deadline and notifies only once without reaping", async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const job = await f.c.createJob({ ...f.input, startupTimeoutSeconds: 5 });
  f.options.toastFailure = true;
  t.mock.timers.tick(5000);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 0);
  t.mock.timers.tick(1);
  await f.c.reconcile(job.jobId);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].parts[0].text, /failed to start.*\(\?\)/);
  assert.equal(f.toasts[0].variant, "warning");
  assert.deepEqual((await f.metadata(job)).delivered, ["startup-timeout"]);
  assert.equal(f.c.resolveJobId(job.jobId), job.jobId);
});

test("heartbeat freshness wins over old consumed metadata and missing heartbeat falls back to consumed time", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  await consume(job.jobDir);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(job.jobDir, FILES.consumed), old, old);
  await fs.writeFile(path.join(job.jobDir, FILES.heartbeat), "alive");
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 0);
  await fs.unlink(path.join(job.jobDir, FILES.heartbeat));
  f.options.toastFailure = true;
  await f.c.reconcile(job.jobId);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].parts[0].text, /STALLED.*no heartbeat for >30s/);
  assert.match(f.posts[0].parts[0].text, /herdr pane run <pane>/);
  assert.equal(f.toasts[0].message, `delegate ${job.jobId.slice(0, 8)}: STALLED`);
  assert.deepEqual((await f.metadata(job)).delivered, ["stalled"]);
});

test("an old heartbeat reports its running delegate pane without closing it", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  const spawned = await f.c.spawnDelegate(job.jobId, f.input);
  await consume(job.jobDir);
  await fs.writeFile(path.join(job.jobDir, FILES.heartbeat), "old");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(job.jobDir, FILES.heartbeat), old, old);
  await f.c.reconcile(job.jobId);
  await f.c.reconcile(job.jobId);
  assert.match(f.posts[0].parts[0].text, new RegExp(`Read its pane \\(${spawned.pane}\\)`));
  assert.equal(f.panes.has(spawned.pane), true);
  await fs.access(spawned.worktree);
});

test("recovery skips legacy, corrupt, invalid and unrelated runtime entries", async (t) => {
  const f = await fixture(t);
  const errors = t.mock.method(console, "error", () => {});
  await f.c.recover(); // The runtime root does not exist yet.
  const valid = await f.c.createJob(f.input);
  const metadata = await f.metadata(valid);
  for (const [suffix, value] of [
    ["1", undefined], ["2", "not json"], ["3", { ...metadata, jobId: "mismatch" }],
    ["4", { ...metadata, sessionID: "" }], ["5", { ...metadata, delivered: null }],
    ["6", { ...metadata, directory: path.join(f.repo, "other") }],
  ]) {
    const id = suffix.repeat(32);
    const dir = path.join(root(), id);
    await fs.mkdir(dir);
    if (value !== undefined) await fs.writeFile(path.join(dir, FILES.coordinator), typeof value === "string" ? value : JSON.stringify({ ...value, jobId: suffix === "3" ? "mismatch" : id }));
  }
  await fs.mkdir(path.join(root(), "not-a-job"));
  await fs.writeFile(path.join(root(), "7".repeat(32)), "not a directory");
  await f.c.dispose();
  const recovered = f.coordinator();
  await recovered.recover();
  await recovered.recover();
  assert.equal(recovered.resolveJobId(valid.jobId, "owner"), valid.jobId);
  for (let i = 1; i <= 7; i++) assert.equal(recovered.resolveJobId(String(i).repeat(32)), undefined);
  assert.equal(errors.mock.callCount(), 8);
  const other = f.coordinator(path.join(f.repo, "different-directory"));
  await other.recover();
  assert.equal(other.resolveJobId(valid.jobId), undefined);
});

test("recovery propagates unreadable runtime roots instead of silently ignoring them", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(root()), { recursive: true });
  await fs.writeFile(root(), "not a directory");
  await assert.rejects(f.c.recover(), { code: "ENOTDIR" });
});

test("periodic reconciliation delivers a missed watch event and survives watch failure", async (t) => {
  const f = await fixture(t);
  const errors = t.mock.method(console, "error", () => {});
  const watchers = [];
  let unavailable = false;
  const watch = t.mock.method(nodeFs, "watch", () => {
    if (unavailable) throw new Error("watch limit reached");
    const watcher = new EventEmitter();
    watcher.close = t.mock.fn();
    watchers.push(watcher);
    return watcher;
  });
  syncBuiltinESMExports();
  t.after(() => { watch.mock.restore(); syncBuiltinESMExports(); });
  let tick;
  const timer = { unref: t.mock.fn() };
  const interval = t.mock.method(globalThis, "setInterval", (callback, ms) => {
    assert.equal(ms, 2000);
    tick = callback;
    return timer;
  });
  const clear = t.mock.method(globalThis, "clearInterval", () => {});
  const job = await f.c.createJob(f.input);
  await f.c.recover();
  await f.c.reconcile(job.jobId);
  await f.c.recover();
  assert.equal(watchers.length, 1, "recovery does not duplicate active watches");
  assert.equal(interval.mock.callCount(), 1);
  assert.ok(timer.unref.mock.callCount() > 0);
  await f.publish(job);
  assert.equal(f.posts.length, 0, "the fake watcher emits no completion event");
  const reconcile = t.mock.method(f.c, "reconcile");
  tick();
  assert.equal(reconcile.mock.calls[0].arguments[0], job.jobId);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);

  watchers[0].emit("error", new Error("watch disconnected"));
  assert.equal(watchers[0].close.mock.callCount(), 1);
  unavailable = true;
  await f.c.recover();
  assert.equal(errors.mock.callCount(), 2);
  assert.match(errors.mock.calls[0].arguments[0], /watch failed/);
  assert.match(errors.mock.calls[1].arguments[0], /watch unavailable/);
  tick();
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);
  await f.c.dispose();
  assert.equal(clear.mock.calls.at(-1).arguments[0], timer);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);
});

test("read-back errors retain pending delivery and HTTP retries honour the throttle", async (t) => {
  const f = await fixture(t);
  const errors = t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const job = await f.c.createJob(f.input);
  await f.publish(job);
  f.options.readbackStatus = 503;
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 0);
  const pending = (await f.metadata(job)).pending;
  assert.equal(pending.attemptedAt, undefined);
  assert.match(String(errors.mock.calls[0].arguments[1]), /message read-back failed: 503/);
  f.options.readbackStatus = null;
  f.failure(true);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);
  f.failure(false);
  t.mock.timers.tick(9999);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);
  assert.deepEqual((await f.metadata(job)).delivered, []);
  f.options.sessionStatus = { owner: { type: "idle" } };
  t.mock.timers.tick(1);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[1].messageID, f.posts[0].messageID);
  assert.deepEqual((await f.metadata(job)).delivered, ["result"]);
});

test("read-back must contain the exact submitted text before delivery is acknowledged", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  await f.publish(job);
  f.options.receiptParts = [{ type: "file", url: "file:///unrelated" }, { type: "text", text: "different message" }];
  await f.c.reconcile(job.jobId);
  const metadata = await f.metadata(job);
  assert.deepEqual(metadata.delivered, []);
  assert.ok(metadata.pending);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1, "an existing but mismatched receipt must not cause a duplicate post");
  f.messages.set(metadata.pending.messageID, { parts: f.posts[0].parts });
  await f.c.reconcile(job.jobId);
  assert.deepEqual((await f.metadata(job)).delivered, ["result"]);
  assert.equal((await f.metadata(job)).pending, undefined);
});

test("failed delivery checkpoint restores pending state and retries without reposting", async (t) => {
  const f = await fixture(t);
  const errors = t.mock.method(console, "error", () => {});
  const job = await f.c.createJob(f.input);
  await f.publish(job);
  const rename = fs.rename;
  let failCheckpoint = true;
  t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === path.join(job.jobDir, FILES.coordinator) && f.posts.length && failCheckpoint) {
      failCheckpoint = false;
      throw new Error("checkpoint write failed");
    }
    return rename(source, destination);
  });
  await f.c.reconcile(job.jobId);
  const failed = await f.metadata(job);
  assert.deepEqual(failed.delivered, []);
  assert.equal(failed.pending.messageID, f.posts[0].messageID);
  assert.match(String(errors.mock.calls[0].arguments[1]), /checkpoint write failed/);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);
  assert.deepEqual((await f.metadata(job)).delivered, ["result"]);
  assert.equal((await f.metadata(job)).pending, undefined);
});

test("split selection uses the largest pane and falls back on missing, malformed or failed layouts", async (t) => {
  const f = await fixture(t);
  for (const [panes, expected] of [
    [[{ pane_id: "small", rect: { width: 10, height: 10 } }, { pane_id: "wide", rect: { width: 100, height: 40 } }], { targetPane: "wide", direction: "right" }],
    [[{ pane_id: "tall", rect: { width: 30, height: 100 } }, { pane_id: "small", rect: { width: 20, height: 20 } }], { targetPane: "tall", direction: "down" }],
    [[{ pane_id: "square", rect: { width: 40, height: 40 } }], { targetPane: "square", direction: "right" }],
    [[], { targetPane: "current", direction: "right" }],
  ]) {
    f.options.layout = JSON.stringify({ result: { layout: { panes } } });
    assert.deepEqual(await f.c.chooseSplitTarget("current"), expected);
  }
  for (const layout of ["null", "{}", "not JSON", '{"result":{"layout":{"panes":[{}]}}}']) {
    f.options.layout = layout;
    assert.deepEqual(await f.c.chooseSplitTarget("current"), { targetPane: "current", direction: "right" });
  }
  f.options.layoutError = true;
  assert.deepEqual(await f.c.chooseSplitTarget("current"), { targetPane: "current", direction: "right" });
  assert.ok(f.calls.every((args) => args.join(" ") === "herdr pane layout --pane current"));
});

test("agent discovery rejects missing names and list failures before allocating resources", async (t) => {
  const f = await fixture(t);
  f.options.agents = " zeta (subagent)\nalpha (primary)\nworker (unknown)\nnot an agent\n";
  await f.c.assertAgentExists("zeta", f.repo);
  await assert.rejects(f.c.createJob(f.input), /agent 'worker' not found. Available agents: alpha, zeta/);
  f.options.agents = "no agents here";
  await assert.rejects(f.c.createJob(f.input), /Available agents: \(none found\)/);
  for (const error of [new Error("discovery failed"), "plain rejection"]) {
    f.options.agentError = error;
    await assert.rejects(f.c.createJob(f.input), /could not list opencode agents in .*: (discovery failed|plain rejection)/);
  }
  assert.ok(f.calls.every((args) => args[0] === "opencode"));
  await assert.rejects(fs.access(root()));
});

test("invalid owners and relative repositories fail before agent discovery", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.c.createJob({ ...f.input, sessionID: "" }), /session owner and absolute repo/);
  await assert.rejects(f.c.createJob({ ...f.input, repo: "relative" }), /session owner and absolute repo/);
  await assert.rejects(f.c.spawnDelegate("missing-job", f.input), /Unknown job/);
  assert.equal(f.calls.length, 0);
  const job = await f.c.createJob(f.input);
  delete process.env.HERDR_PANE_ID;
  await assert.rejects(f.c.spawnDelegate(job.jobId, f.input), /HERDR_PANE_ID missing/);
  await assert.rejects(f.metadata(job), { code: "ENOENT" });
});

test("agent discovery accepts all-mode agents without silently choosing another agent", async (t) => {
  const f = await fixture(t);
  f.options.agents = "scout (all)\nworker (primary)\n";
  await f.c.assertAgentExists("scout", f.repo);
  await assert.rejects(f.c.assertAgentExists("sisyphus", f.repo), /not found.*scout, worker/);
});

test("spawn authorises .envrc and uses a mocked readiness fallback before launching a shell-safe tiny prompt", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, ".envrc"), "export EXAMPLE=1\n");
  await f.git("add", ".envrc");
  await f.git("commit", "-q", "-m", "environment");
  const input = { ...f.input, baseCommit: undefined, agent: "work'er", task: "DO NOT PUT THIS TASK IN THE SHELL\n$(exit 1)" };
  f.options.agents = "work'er (primary)\n";
  f.options.waitFailure = true;
  f.options.direnvFailure = true;
  const delays = [];
  t.mock.method(globalThis, "setTimeout", (callback, ms) => {
    delays.push(ms);
    queueMicrotask(callback);
    return { unref() {} };
  });
  const job = await f.c.createJob(input);
  const spawned = await f.c.spawnDelegate(job.jobId, input);
  assert.deepEqual(delays, [1500]);
  assert.equal(await fs.readFile(path.join(spawned.worktree, ".envrc"), "utf8"), "export EXAMPLE=1\n");
  const allowIndex = f.calls.findIndex((args) => args[0] === "direnv");
  const waitIndex = f.calls.findIndex((args) => args[1] === "wait");
  const runIndex = f.calls.findIndex((args) => args[2] === "run");
  assert.ok(allowIndex < waitIndex && waitIndex < runIndex);
  assert.deepEqual(f.calls[allowIndex], ["direnv", "allow", spawned.worktree]);
  assert.deepEqual(f.calls[waitIndex], ["herdr", "wait", "output", spawned.pane, "--match", job.jobId, "--timeout", "10000"]);
  const command = f.calls[runIndex][4];
  assert.ok(command.includes("--agent 'work'\\''er' --auto --prompt '"));
  assert.match(command, /read_task.*complete.*ask/);
  assert.doesNotMatch(command, /DO NOT PUT|exit 1/);
  const metadata = await f.metadata(job);
  assert.equal(metadata.phase, "running");
  assert.equal(metadata.baseCommit, (await f.git("rev-parse", "HEAD")).stdout.trim());
});

test("failed launch with failed cleanup retains all resources for a later reap", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  f.renameFailure(true);
  f.closeFailure(true);
  await assert.rejects(f.c.spawnDelegate(job.jobId, f.input), /failed to launch:.*rename failed.*Cleanup failed and remains tracked.*close failed/);
  const metadata = await f.metadata(job);
  assert.equal(metadata.phase, "cleanup");
  assert.equal(metadata.deleteBranch, true);
  assert.equal(f.c.resolveJobId(job.jobId), job.jobId);
  assert.equal(f.panes.has(metadata.pane), true);
  await fs.access(metadata.worktree);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 0);
  f.closeFailure(false);
  await f.c.reap(job.jobId);
  await assert.rejects(fs.access(metadata.worktree));
  await assert.rejects(f.git("show-ref", "--verify", `refs/heads/${f.input.branch}`));
});

test("verified code-change success reports evidence and leaves merging and cleanup explicit", async (t) => {
  const f = await fixture(t);
  const target = (await f.git("branch", "--show-current")).stdout.trim();
  const input = { ...f.input, outputContract: "code-change", targetBranch: target, checks: [{ command: "node --test", expectedExitCode: 0 }] };
  const job = await f.c.createJob(input);
  const spawned = await f.c.spawnDelegate(job.jobId, input);
  await f.git("-C", spawned.worktree, "commit", "-q", "--allow-empty", "-m", "delegate change");
  const head = (await f.git("rev-parse", input.branch)).stdout.trim();
  await f.publish(job, { branch: input.branch, baseCommit: f.base, headCommit: head, evidence: ["tests pass", "reviewed diff"], risks: ["manual rollout"], followUps: ["review then merge"] });
  f.options.toastFailure = true;
  await f.c.reconcile(job.jobId);
  await f.c.reconcile(job.jobId);
  assert.equal(f.posts.length, 1);
  const text = f.posts[0].parts[0].text;
  assert.match(text, /reported: success \(code-change\)/);
  assert.match(text, /Evidence:\n- tests pass\n- reviewed diff/);
  assert.match(text, /Risks:\n- manual rollout/);
  assert.match(text, /Follow-ups:\n- review then merge/);
  assert.ok(text.includes(`branch=${input.branch} base=${f.base} head=${head} targetBranch=${target} mergePolicy=manual`));
  assert.ok(text.includes(`Delegate pane ${spawned.pane} is still OPEN; worktree: ${spawned.worktree}`));
  assert.match(text, /No merge or cleanup has been performed/);
  assert.equal((await f.git("rev-parse", target)).stdout.trim(), f.base);
  assert.equal(f.panes.has(spawned.pane), true);
  await fs.access(spawned.worktree);
});

test("valid Git report for a different branch is rejected against the assignment", async (t) => {
  const f = await fixture(t);
  const input = { ...f.input, outputContract: "code-change" };
  const job = await f.c.createJob(input);
  const spawned = await f.c.spawnDelegate(job.jobId, input);
  await f.git("-C", spawned.worktree, "commit", "-q", "--allow-empty", "-m", "delegate change");
  const head = (await f.git("rev-parse", input.branch)).stdout.trim();
  await f.git("branch", "delegate/other", head);
  await f.publish(job, { branch: "delegate/other", baseCommit: f.base, headCommit: head });
  await f.c.reconcile(job.jobId);
  await f.c.reconcile(job.jobId);
  assert.match(f.posts[0].parts[0].text, /REJECTED \(assigned branch\/base mismatch\). No merge performed/);
  assert.equal(f.c.resolveJobId(job.jobId), job.jobId);
  assert.equal((await f.git("rev-parse", "HEAD")).stdout.trim(), f.base);
});

test("code-change failure can report unavailable revisions without attempting a merge", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob({ ...f.input, outputContract: "code-change" });
  await f.publish(job, { status: "failure", summary: "Could not finish" });
  await f.c.reconcile(job.jobId);
  assert.match(f.posts[0].parts[0].text, /reported: failure \(code-change\)/);
  assert.match(f.posts[0].parts[0].text, /branch=\? base=\? head=\? mergePolicy=manual/);
  assert.doesNotMatch(f.posts[0].parts[0].text, /targetBranch=/);
});

test("cleanup refuses keepPane and uncertain pane inventory before touching the checkout", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  const spawned = await f.c.spawnDelegate(job.jobId, f.input);
  await assert.rejects(f.c.reap(job.jobId, { keepPane: true }), /retaining its delegate pane/);
  assert.equal((await f.metadata(job)).phase, "running");
  f.options.paneList = "{}";
  await assert.rejects(f.c.reap(job.jobId), /Cannot establish whether delegate pane exists/);
  await fs.access(spawned.worktree);
  assert.equal(f.panes.has(spawned.pane), true);
  f.options.paneList = null;
  await f.c.reap(job.jobId);
  assert.equal(f.c.resolveJobId(job.jobId), undefined);
  await f.git("show-ref", "--verify", `refs/heads/${f.input.branch}`);
});

test("cleanup preserves an unmerged branch and resumes from checkpoints after it is merged", async (t) => {
  const f = await fixture(t);
  const job = await f.c.createJob(f.input);
  const spawned = await f.c.spawnDelegate(job.jobId, f.input);
  await f.git("-C", spawned.worktree, "commit", "-q", "--allow-empty", "-m", "unmerged work");
  const head = (await f.git("rev-parse", f.input.branch)).stdout.trim();
  await assert.rejects(f.c.reap(job.jobId, { deleteBranch: true }), /not fully merged/);
  const metadata = await f.metadata(job);
  assert.equal(metadata.pane, undefined);
  assert.equal(metadata.worktreeCreated, false);
  assert.equal(metadata.branchCreated, true);
  assert.equal((await f.git("rev-parse", f.input.branch)).stdout.trim(), head);
  assert.equal(f.c.resolveJobId(job.jobId), job.jobId);
  await f.git("merge", "--ff-only", f.input.branch);
  await f.c.reap(job.jobId);
  assert.equal(f.calls.filter((args) => args[2] === "close").length, 1);
  await assert.rejects(fs.access(job.jobDir));
  await assert.rejects(f.git("show-ref", "--verify", `refs/heads/${f.input.branch}`));
});
