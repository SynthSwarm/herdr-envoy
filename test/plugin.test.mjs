import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import PeerDelegate, { PeerDelegate as namedPlugin } from "../dist/index.js";
import { Coordinator } from "../dist/coordinator.js";
import { DELEGATE_COMMAND_NAME, delegateCommand } from "../dist/command.js";
import { FILES, JOBDIR_ENV, PROTOCOL_VERSION } from "../dist/protocol.js";
import { provisionSkill, SKILL_NAME } from "../dist/skill.js";

// These tests mutate process-wide environment and timer functions. Keep them serial.
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-plugin-test-"));
  const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "HERDR_PANE_ID", JOBDIR_ENV];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const hooks = [];
  t.after(async () => {
    try {
      for (const hook of hooks) await hook.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  process.env.HOME = path.join(dir, "home");
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  process.env.XDG_RUNTIME_DIR = path.join(dir, "runtime");
  process.env.HERDR_PANE_ID = "test-coordinator-pane";
  delete process.env[JOBDIR_ENV];

  // Capture callbacks rather than waiting 10 seconds or starting real background work.
  const intervals = [];
  t.mock.method(globalThis, "setInterval", (callback, ms) => {
    const timer = { callback, ms, unref: t.mock.fn(), cleared: false };
    intervals.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => { timer.cleared = true; });
  const unexpected = t.mock.fn(() => { throw new Error("Unexpected external operation"); });
  const input = {
    directory: dir,
    $: unexpected,
    client: { session: { message: unexpected, status: unexpected, promptAsync: unexpected } },
  };
  t.after(() => assert.equal(unexpected.mock.callCount(), 0));
  const load = async () => {
    const hook = await PeerDelegate(input);
    hooks.push(hook);
    return hook;
  };
  return {
    dir, load, intervals,
    skill: path.join(process.env.XDG_CONFIG_HOME, "opencode", "skills", SKILL_NAME, "SKILL.md"),
  };
}

async function handoff(f, overrides = {}) {
  const jobDir = path.join(f.dir, "delegate-job");
  await fs.mkdir(jobDir);
  process.env[JOBDIR_ENV] = jobDir;
  const brief = {
    protocolVersion: PROTOCOL_VERSION,
    jobId: "a".repeat(32),
    generation: 1,
    completionToken: "test-only-token",
    agent: "worker",
    task: "Inspect the supplied fixture.\nReturn evidence, without committing.",
    outputContract: "advisory",
    targetBranch: "main",
    baseCommit: "b".repeat(40),
    mergePolicy: "manual",
    checks: [],
    startupTimeoutSeconds: 30,
    ...overrides,
  };
  await fs.writeFile(path.join(jobDir, FILES.handoff), JSON.stringify(brief));
  return { jobDir, brief };
}

async function waitForHeartbeat(jobDir) {
  // The first beat is fire-and-forget. Let it finish before disposal or fixture removal.
  const file = path.join(jobDir, FILES.heartbeat);
  for (let attempt = 0; attempt < 200; attempt++) {
    const content = await fs.readFile(file, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    if (/^\d+$/.test(content)) return;
    await delay(10);
  }
  assert.fail("Initial delegate heartbeat was not written");
}

test("coordinator initialises recovery, provisions guidance and exposes only coordinator tools", async (t) => {
  const f = await fixture(t);
  const recover = t.mock.method(Coordinator.prototype, "recover");
  const dispose = t.mock.method(Coordinator.prototype, "dispose");
  assert.equal(PeerDelegate, namedPlugin);
  const hooks = await f.load();
  assert.equal(recover.mock.callCount(), 1);
  assert.deepEqual(Object.keys(hooks).sort(), ["config", "dispose", "tool"]);
  assert.deepEqual(Object.keys(hooks.tool).sort(), ["delegate", "reap_delegate", "reply_delegate"]);
  assert.match(await fs.readFile(f.skill, "utf8"), /name: envoy/);
  assert.equal(f.intervals.length, 1);
  const timer = f.intervals[0];
  assert.equal(timer.ms, 2000);
  assert.equal(timer.unref.mock.callCount(), 1);
  await hooks.dispose();
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(dispose.mock.calls[0].this, recover.mock.calls[0].this);
  assert.equal(timer.cleared, true);
  await hooks.dispose();
});

test("coordinator config injects /envoy idempotently without replacing user commands", async (t) => {
  const f = await fixture(t);
  const hooks = await f.load();
  assert.equal(DELEGATE_COMMAND_NAME, "envoy");
  const config = { model: "user-model" };
  await hooks.config(config);
  const commands = config.command;
  assert.equal(commands.envoy, delegateCommand);
  await hooks.config(config);
  assert.equal(config.command, commands);
  assert.equal(config.model, "user-model");
  assert.deepEqual(Object.keys(commands), ["envoy"]);

  const userCommand = { template: "User-owned envoy command", description: "Keep this" };
  const otherCommand = { template: "Unrelated command" };
  const existing = { command: { envoy: userCommand, other: otherCommand } };
  const original = existing.command;
  await hooks.config(existing);
  assert.equal(existing.command, original);
  assert.equal(existing.command.envoy, userCommand);
  assert.equal(existing.command.other, otherCommand);
  const unrelated = { command: { other: otherCommand } };
  await hooks.config(unrelated);
  assert.equal(unrelated.command.envoy, delegateCommand);
  assert.equal(unrelated.command.other, otherCommand);
});

test("delegate consumes the handoff, recovers its task on reload and reports using consumed auth", async (t) => {
  const f = await fixture(t);
  const { jobDir, brief } = await handoff(f);
  const recover = t.mock.method(Coordinator.prototype, "recover");
  const hooks = await f.load();
  assert.deepEqual(Object.keys(hooks).sort(), ["dispose", "tool"]);
  assert.deepEqual(Object.keys(hooks.tool).sort(), ["ask", "complete", "read_task"]);
  assert.equal(recover.mock.callCount(), 0);
  await assert.rejects(fs.access(f.skill), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(jobDir, FILES.handoff)), { code: "ENOENT" });
  const consumed = JSON.parse(await fs.readFile(path.join(jobDir, FILES.consumed), "utf8"));
  const { startupTimeoutSeconds, ...expected } = brief;
  assert.deepEqual(consumed, expected);
  const task = await hooks.tool.read_task.execute({});
  assert.ok(task.includes(brief.task));
  assert.match(task, /advisory task.*do NOT commit/);
  assert.match(task, /`complete`/);
  assert.match(task, /`ask`/);
  await waitForHeartbeat(jobDir);
  await hooks.dispose();
  await fs.unlink(path.join(jobDir, FILES.heartbeat));

  const reloaded = await f.load();
  assert.equal(await reloaded.tool.read_task.execute({}), task);
  await waitForHeartbeat(jobDir);
  await reloaded.tool.complete.execute({ status: "success", summary: "Fixture inspected" });
  const result = JSON.parse(await fs.readFile(path.join(jobDir, FILES.result), "utf8"));
  assert.equal(result.jobId, brief.jobId);
  assert.equal(result.generation, brief.generation);
  assert.equal(result.completionToken, brief.completionToken);
  assert.equal(result.outputContract, "advisory");
  assert.equal(result.summary, "Fixture inspected");
});

test("delegate dispose clears and disables the heartbeat, including repeated disposal", async (t) => {
  const f = await fixture(t);
  const { jobDir } = await handoff(f);
  const hooks = await f.load();
  await waitForHeartbeat(jobDir);
  assert.equal(f.intervals.length, 1);
  const timer = f.intervals[0];
  assert.equal(timer.ms, 10_000);
  assert.equal(timer.unref.mock.callCount(), 1);
  const heartbeat = path.join(jobDir, FILES.heartbeat);
  await fs.writeFile(heartbeat, "before tick");
  await timer.callback();
  assert.match(await fs.readFile(heartbeat, "utf8"), /^\d+$/);
  await hooks.dispose();
  await hooks.dispose();
  assert.equal(timer.cleared, true);
  await fs.writeFile(heartbeat, "after disposal");
  await timer.callback();
  assert.equal(await fs.readFile(heartbeat, "utf8"), "after disposal");
});

test("delegate consume failures leave usable read_task but no completion or question authority", async (t) => {
  for (const failure of ["missing handoff", "invalid JSON", "protocol mismatch", "corrupt consumed snapshot"]) {
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      const { jobDir } = await handoff(f, failure === "protocol mismatch" ? { protocolVersion: -1 } : {});
      const file = path.join(jobDir, FILES.handoff);
      if (failure === "missing handoff") await fs.unlink(file);
      if (failure === "invalid JSON") await fs.writeFile(file, "{invalid");
      if (failure === "corrupt consumed snapshot") {
        await fs.writeFile(path.join(jobDir, FILES.consumed), "{invalid");
      }
      const errors = t.mock.method(console, "error", () => {});
      const hooks = await f.load();
      assert.equal(errors.mock.callCount(), failure === "missing handoff" ? 0 : 1);
      if (errors.mock.callCount()) assert.match(errors.mock.calls[0].arguments[0], /^peer-delegate\(delegate\): /);
      assert.match(await hooks.tool.read_task.execute({}), /No task found.*re-delegate/);
      await assert.rejects(hooks.tool.complete.execute({ status: "success", summary: "Not authorised" }), /no job auth/);
      await assert.rejects(hooks.tool.ask.execute({ question: "Can I proceed?" }), /no job auth/);
      await assert.rejects(fs.access(path.join(jobDir, FILES.result)), { code: "ENOENT" });
      await assert.rejects(fs.access(path.join(jobDir, FILES.block)), { code: "ENOENT" });
      if (failure !== "missing handoff") await fs.access(file);
      await waitForHeartbeat(jobDir);
      await hooks.dispose();
      assert.equal(f.intervals[0].cleared, true);
    });
  }
});

test("skill provisioning creates fresh guidance and leaves it untouched on repeat", async (t) => {
  const f = await fixture(t);
  assert.equal(SKILL_NAME, "envoy");
  await provisionSkill();
  const content = await fs.readFile(f.skill, "utf8");
  assert.match(content, /^---\nname: envoy\n/);
  assert.match(content, /# envoy \(coordinator\)/);
  assert.equal((await fs.stat(f.skill)).mode & 0o777, 0o644 & ~process.umask());
  const timestamp = new Date("2000-01-01T00:00:00Z");
  await fs.utimes(f.skill, timestamp, timestamp);
  const before = await fs.stat(f.skill);
  await provisionSkill();
  assert.equal(await fs.readFile(f.skill, "utf8"), content);
  assert.equal((await fs.stat(f.skill)).mtimeMs, before.mtimeMs);
});

test("skill provisioning preserves arbitrary existing user content, including an empty file", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.skill), { recursive: true });
  for (const content of ["# My envoy skill\nDo not replace my instructions.\n", ""]) {
    await fs.writeFile(f.skill, content);
    await provisionSkill();
    assert.equal(await fs.readFile(f.skill, "utf8"), content);
  }
});

test("skill provisioning falls back to a temporary HOME when XDG_CONFIG_HOME is unset or empty", async (t) => {
  const f = await fixture(t);
  assert.equal(os.homedir(), process.env.HOME);
  const fallback = path.join(process.env.HOME, ".config", "opencode", "skills", SKILL_NAME, "SKILL.md");
  for (const value of [undefined, ""]) {
    if (value === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = value;
    await provisionSkill();
    assert.match(await fs.readFile(fallback, "utf8"), /name: envoy/);
    await assert.rejects(fs.access(f.skill), { code: "ENOENT" });
    await fs.unlink(fallback);
  }
});

test("a non-directory config path does not prevent coordinator initialisation", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(process.env.XDG_CONFIG_HOME, "not a directory");
  await assert.doesNotReject(provisionSkill());
  const hooks = await f.load();
  assert.equal(typeof hooks.config, "function");
  assert.equal(await fs.readFile(process.env.XDG_CONFIG_HOME, "utf8"), "not a directory");
});

test("skill write failures are best-effort and can be retried", async (t) => {
  const f = await fixture(t);
  const write = t.mock.method(fs, "writeFile", async () => {
    throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
  });
  await assert.doesNotReject(provisionSkill());
  assert.equal(write.mock.callCount(), 1);
  assert.equal(write.mock.calls[0].arguments[0], f.skill);
  await assert.rejects(fs.access(f.skill), { code: "ENOENT" });
  write.mock.restore();
  await provisionSkill();
  assert.match(await fs.readFile(f.skill, "utf8"), /name: envoy/);
});

test("skill provisioning preserves user content created between existence check and write", async (t) => {
  const f = await fixture(t);
  const mkdir = fs.mkdir;
  t.mock.method(fs, "mkdir", async (...args) => {
    const result = await mkdir(...args);
    await fs.writeFile(f.skill, "User guidance created concurrently");
    return result;
  });
  await provisionSkill();
  assert.equal(await fs.readFile(f.skill, "utf8"), "User guidance created concurrently");
});

test("command and provisioned skill agree on delegation, recovery, review and safe cleanup", async (t) => {
  const f = await fixture(t);
  await provisionSkill();
  assert.equal(DELEGATE_COMMAND_NAME, SKILL_NAME);
  assert.match(delegateCommand.description, /real peer opencode agent.*git worktree/);
  assert.equal(delegateCommand.template.split("$ARGUMENTS").length - 1, 1);
  const sharedGuidance = [
    /NOT a subagent/i,
    /USER'S OWN agents/,
    /`agent`/, /`task`/, /`repo`/, /`branch`/, /`outputContract`/,
    /`advisory`/, /`code-change`/, /`targetBranch`/, /`baseCommit`/,
    /`mergePolicy: "manual"`/,
    /`auto-after-checks` is explicitly rejected/,
    /without waiting for completion/,
    /Do not block/i,
    /<repo>\/\.herdr-envoy\/worktrees\/<job-id>\//,
    /`sessionID`/, /`coordinator.json`/, /`HERDR_PANE_ID`/,
    /2-second reconciliation/,
    /readback and retries/,
    /not (?:an |promise )exactly-once delivery/i,
    /not code correctness/,
    /USER approval before merging/,
    /Completion is terminal/,
    /`delegate`/, /`reply_delegate`/, /`reap_delegate`/,
    /closes the pane first/,
    /clean checkout without force/,
    /errors retain the tracked job for retry/i,
    /`git branch -d`, not `-D`/,
    /distinct branches/,
  ];
  for (const [name, text] of [
    ["command", delegateCommand.template],
    ["skill", await fs.readFile(f.skill, "utf8")],
  ]) {
    const normalised = text.replace(/\s+/g, " ");
    for (const rule of sharedGuidance) assert.match(normalised, rule, `${name}: ${rule}`);
  }
});
