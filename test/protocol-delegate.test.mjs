import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldIO } from "node:timers/promises";
import { test } from "node:test";
import {
  FILES, JOBDIR_ENV, PROTOCOL_VERSION, atomicWriteJSON, exists,
  filePath, jobDir, rand, readJSON, root,
} from "../dist/protocol.js";
import {
  askTool, completeTool, consume, readTaskTool, startHeartbeat,
} from "../dist/delegate.js";

const NOW = 1_800_000_000_000;

function handoff(overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    jobId: "test-job",
    generation: 3,
    completionToken: "test-completion-token",
    agent: "worker",
    task: "Inspect the implementation.\nReport concrete findings, including 'quoted' text.",
    outputContract: "advisory",
    targetBranch: "main",
    baseCommit: "a".repeat(40),
    mergePolicy: "manual",
    checks: [{ command: "npm test", expectedExitCode: 0 }],
    startupTimeoutSeconds: 30,
    ...overrides,
  };
}

async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-protocol-delegate-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  const cleanup = [];
  t.after(async () => {
    try {
      for (const dispose of cleanup.reverse()) await dispose();
    } finally {
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  process.env.XDG_RUNTIME_DIR = dir;
  const h = handoff(overrides);
  const job = jobDir(h.jobId);
  await fs.mkdir(job, { recursive: true, mode: 0o700 });
  const { startupTimeoutSeconds, ...consumed } = h;
  return {
    dir, h, consumed, cleanup,
    state: { jobDir: job, task: h.task, consumed },
    file: (name) => path.join(job, FILES[name]),
    write: (name, value) => atomicWriteJSON(path.join(job, FILES[name]), value),
  };
}

async function privateFile(file) {
  // Windows does not expose POSIX permission bits reliably.
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
}

// Yield to real filesystem callbacks, not wall-clock sleeps. Mocked clocks only
// advance the delegate's timers, while this real-time bound catches stuck tests.
async function until(predicate, message) {
  const deadline = performance.now() + 5_000;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, message);
    await yieldIO();
  }
}

function startAsk(t, f, question = "Which approach should I use?", controller = new AbortController()) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const timeouts = t.mock.method(globalThis, "setTimeout");
  let outcome;
  const promise = askTool(f.state).execute({ question }, { abort: controller.signal });
  // Attach rejection handling immediately, including for failures before polling.
  const settled = promise.then(
    (value) => { outcome = { value }; },
    (error) => { outcome = { error }; },
  );
  f.cleanup.push(async () => {
    controller.abort();
    await until(() => {
      t.mock.timers.tick(2_000);
      return outcome !== undefined;
    }, "ask did not settle during cleanup");
    await settled;
  });
  return {
    controller, promise,
    timeoutCount: () => timeouts.mock.callCount(),
    async poll(count = 1) {
      await until(() => outcome !== undefined || timeouts.mock.callCount() >= count,
        "ask did not poll or settle");
      assert.equal(outcome, undefined, "ask must keep waiting for a valid reply");
      assert.equal(timeouts.mock.callCount(), count);
      assert.equal(timeouts.mock.calls[count - 1].arguments[1], 2_000);
    },
  };
}

test("protocol constants and canonical paths use the configured runtime root", async (t) => {
  const f = await fixture(t);
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(JOBDIR_ENV, "PEER_DELEGATE_JOBDIR");
  assert.equal(root(), path.join(f.dir, "herdr"));
  assert.equal(jobDir("another-job"), path.join(f.dir, "herdr", "another-job"));
  assert.deepEqual(FILES, {
    handoff: "handoff.json", consumed: ".consumed.json", coordinator: "coordinator.json",
    result: "result.json", block: "block.json", reply: "reply.json", heartbeat: "heartbeat",
  });
  for (const [name, filename] of Object.entries(FILES)) {
    assert.equal(filePath("another-job", name), path.join(f.dir, "herdr", "another-job", filename));
  }
});

for (const value of [undefined, ""]) {
  test(`root falls back to the per-user temporary path when XDG_RUNTIME_DIR is ${String(value)}`, async (t) => {
    await fixture(t);
    if (value === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = value;
    assert.equal(root(), path.join(os.tmpdir(), `herdr-${process.getuid?.() ?? "0"}`, "herdr"));
  });
}

test("root uses uid zero on platforms without getuid", async (t) => {
  await fixture(t);
  delete process.env.XDG_RUNTIME_DIR;
  const original = Object.getOwnPropertyDescriptor(process, "getuid");
  Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
  t.after(() => {
    if (original) Object.defineProperty(process, "getuid", original);
    else delete process.getuid;
  });
  assert.equal(root(), path.join(os.tmpdir(), "herdr-0", "herdr"));
});

test("rand produces distinct 128-bit lowercase hexadecimal identifiers", () => {
  const values = Array.from({ length: 64 }, () => rand());
  for (const value of values) assert.match(value, /^[0-9a-f]{32}$/);
  assert.equal(new Set(values).size, values.length);
});

test("atomicWriteJSON publishes complete private JSON through a same-directory rename", async (t) => {
  const f = await fixture(t);
  const dest = f.file("result");
  const before = { summary: "previous" };
  const after = { summary: "replacement", evidence: ["line one\nline two"], nested: { ok: true } };
  await fs.writeFile(dest, JSON.stringify(before), { mode: 0o644 });
  const rename = fs.rename;
  const spy = t.mock.method(fs, "rename", async (source, target) => {
    assert.equal(target, dest);
    assert.equal(path.dirname(source), path.dirname(dest));
    assert.match(path.basename(source), /^\.tmp\.[0-9a-f]{32}$/);
    assert.deepEqual(await readJSON(dest), before, "destination must remain intact until publication");
    assert.equal(await fs.readFile(source, "utf8"), JSON.stringify(after, null, 2));
    await privateFile(source);
    await rename(source, target);
  });
  await atomicWriteJSON(dest, after);
  assert.equal(spy.mock.callCount(), 1);
  assert.deepEqual(await readJSON(dest), after);
  await privateFile(dest);
  assert.deepEqual(await fs.readdir(f.state.jobDir), [FILES.result]);
});

test("atomicWriteJSON creates a new file and supports repeated replacement without temporary leftovers", async (t) => {
  const f = await fixture(t);
  for (const value of [null, [1, "two"], { revision: 3 }]) {
    await f.write("result", value);
    assert.deepEqual(await readJSON(f.file("result")), value);
    await privateFile(f.file("result"));
    assert.deepEqual(await fs.readdir(f.state.jobDir), [FILES.result]);
  }
});

test("atomicWriteJSON leaves the old destination intact on serialisation or write failure", async (t) => {
  const f = await fixture(t);
  await f.write("result", { preserved: true });
  const circular = {};
  circular.self = circular;
  await assert.rejects(f.write("result", circular), TypeError);
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  t.mock.method(fs, "writeFile", async () => { throw failure; });
  const rename = t.mock.method(fs, "rename");
  await assert.rejects(f.write("result", {}), (error) => error === failure);
  assert.equal(rename.mock.callCount(), 0);
  assert.deepEqual(await readJSON(f.file("result")), { preserved: true });
  assert.deepEqual(await fs.readdir(f.state.jobDir), [FILES.result]);
});

test("atomicWriteJSON propagates rename failure without overwriting the destination", async (t) => {
  const f = await fixture(t);
  await f.write("result", { preserved: true });
  const failure = Object.assign(new Error("rename denied"), { code: "EACCES" });
  t.mock.method(fs, "rename", async () => { throw failure; });
  await assert.rejects(f.write("result", {}), (error) => error === failure);
  assert.deepEqual(await readJSON(f.file("result")), { preserved: true });
});

test("JSON reads and existence checks handle present, missing and malformed files", async (t) => {
  const f = await fixture(t);
  assert.equal(await exists(f.file("result")), false);
  await assert.rejects(readJSON(f.file("result")), { code: "ENOENT" });
  await assert.rejects(atomicWriteJSON(path.join(f.dir, "missing", "result.json"), {}), { code: "ENOENT" });
  await fs.writeFile(f.file("result"), "not JSON");
  assert.equal(await exists(f.file("result")), true);
  await assert.rejects(readJSON(f.file("result")), SyntaxError);
  t.mock.method(fs, "access", async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  assert.equal(await exists(f.file("result")), false);
});

test("consume snapshots all identity and task fields before unlinking the handoff", async (t) => {
  const f = await fixture(t);
  await f.write("handoff", f.h);
  const unlink = fs.unlink;
  const spy = t.mock.method(fs, "unlink", async (file) => {
    assert.equal(file, f.file("handoff"));
    assert.deepEqual(await readJSON(f.file("consumed")), f.consumed);
    await privateFile(f.file("consumed"));
    await unlink(file);
  });
  assert.deepEqual(await consume(f.state.jobDir), f.state);
  assert.equal(spy.mock.callCount(), 1);
  assert.equal(await exists(f.file("handoff")), false);
  assert.deepEqual(await fs.readdir(f.state.jobDir), [FILES.consumed]);
});

test("consume recovers the same task and auth after restart without rewriting the snapshot", async (t) => {
  const f = await fixture(t);
  await f.write("handoff", f.h);
  const first = await consume(f.state.jobDir);
  const write = t.mock.method(fs, "writeFile");
  const unlink = t.mock.method(fs, "unlink");
  assert.deepEqual(await consume(f.state.jobDir), first);
  assert.equal(write.mock.callCount(), 0);
  assert.equal(unlink.mock.callCount(), 0);
});

test("consume prefers an existing snapshot over a different handoff", async (t) => {
  const f = await fixture(t);
  await f.write("consumed", f.consumed);
  const replacement = { ...f.h, task: "Different task", generation: f.h.generation + 1 };
  await f.write("handoff", replacement);
  assert.deepEqual(await consume(f.state.jobDir), f.state);
  assert.deepEqual(await readJSON(f.file("handoff")), replacement);
});

test("consume returns an unauthenticated empty state when no handoff exists", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await consume(f.state.jobDir), { jobDir: f.state.jobDir, task: null, consumed: null });
  assert.deepEqual(await fs.readdir(f.state.jobDir), []);
});

test("consume recovers auth but no task from a snapshot without task text", async (t) => {
  const f = await fixture(t);
  const { task, ...snapshot } = f.consumed;
  await f.write("consumed", snapshot);
  assert.deepEqual(await consume(f.state.jobDir), { jobDir: f.state.jobDir, task: null, consumed: snapshot });
});

test("consume rejects an unsupported handoff version without changing files", async (t) => {
  const f = await fixture(t, { protocolVersion: PROTOCOL_VERSION + 1 });
  await f.write("handoff", f.h);
  await assert.rejects(consume(f.state.jobDir), /protocol mismatch 2/);
  assert.deepEqual(await readJSON(f.file("handoff")), f.h);
  assert.equal(await exists(f.file("consumed")), false);
});

test("consume rejects an unsupported persisted snapshot version", async (t) => {
  const f = await fixture(t, { protocolVersion: PROTOCOL_VERSION + 1 });
  await f.write("consumed", f.consumed);
  await assert.rejects(consume(f.state.jobDir), /protocol mismatch 2/);
  assert.deepEqual(await readJSON(f.file("consumed")), f.consumed);
});

for (const name of ["handoff", "consumed"]) {
  test(`consume rejects malformed ${name} JSON without removing it`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.file(name), "{broken");
    await assert.rejects(consume(f.state.jobDir), SyntaxError);
    assert.equal(await fs.readFile(f.file(name), "utf8"), "{broken");
    assert.deepEqual(await fs.readdir(f.state.jobDir), [FILES[name]]);
  });
}

test("consume preserves the handoff if snapshot publication fails", async (t) => {
  const f = await fixture(t);
  await f.write("handoff", f.h);
  const failure = new Error("snapshot write failed");
  t.mock.method(fs, "writeFile", async () => { throw failure; });
  await assert.rejects(consume(f.state.jobDir), (error) => error === failure);
  assert.deepEqual(await readJSON(f.file("handoff")), f.h);
  assert.equal(await exists(f.file("consumed")), false);
});

for (const task of [null, ""]) {
  test(`read_task reports a missing ${task === null ? "null" : "empty"} task`, async (t) => {
    const f = await fixture(t, { task });
    assert.equal(await readTaskTool(f.state).execute({}),
      "No task found (handoff not consumed). Ask the coordinator to re-delegate.");
  });
}

test("read_task advisory envelope preserves the brief and forbids commits", async (t) => {
  const f = await fixture(t);
  const tool = readTaskTool(f.state);
  assert.deepEqual(tool.args, {});
  const text = await tool.execute({});
  assert.ok(text.includes(`## Task\n${f.h.task}\n\n`));
  assert.match(text, /Call the `complete` tool.*status \("success" or "failure"\)/);
  assert.match(text, /advisory task.*do NOT commit; return your deliverable in the summary\/evidence/);
  assert.match(text, /call the `ask` tool/);
  assert.doesNotMatch(text, /Assigned base commit|headCommit/);
  assert.doesNotMatch(text, /test-completion-token/);
});

test("read_task defaults to advisory instructions when auth is absent", async (t) => {
  const f = await fixture(t);
  const text = await readTaskTool({ ...f.state, consumed: null }).execute({});
  assert.ok(text.includes(f.h.task));
  assert.match(text, /advisory task.*do NOT commit/);
});

for (const targetBranch of ["main", ""]) {
  test(`read_task code-change envelope includes base and ${targetBranch ? "target" : "unspecified target"}`, async (t) => {
    const f = await fixture(t, { outputContract: "code-change", targetBranch });
    const text = await readTaskTool(f.state).execute({});
    assert.ok(text.includes(`Assigned base commit: ${f.h.baseCommit}. Target branch: ${targetBranch || "not specified"}.`));
    assert.match(text, /plus branch, baseCommit and headCommit for your commit/);
    assert.ok(text.includes(f.h.task));
    assert.doesNotMatch(text, /do NOT commit/);
  });
}

for (const status of ["success", "failure"]) {
  test(`complete publishes authenticated advisory ${status} with default arrays`, async (t) => {
    const f = await fixture(t);
    const summary = `Task ${status}`;
    assert.equal(await completeTool(f.state).execute({ status, summary }),
      `Reported ${status} for job ${f.h.jobId} (generation ${f.h.generation}).`);
    assert.deepEqual(await readJSON(f.file("result")), {
      protocolVersion: PROTOCOL_VERSION, jobId: f.h.jobId, generation: f.h.generation,
      completionToken: f.h.completionToken, origin: "delegate", status,
      outputContract: "advisory", summary, evidence: [], checksPerformed: [], risks: [], followUps: [],
    });
    await privateFile(f.file("result"));
    assert.deepEqual(await fs.readdir(f.state.jobDir), [FILES.result]);
  });
}

test("complete preserves evidence, risks and follow-ups but omits advisory commit fields", async (t) => {
  const f = await fixture(t);
  const args = {
    status: "success", summary: "Reviewed", evidence: ["src/protocol.ts:109"],
    risks: ["No isolation"], followUps: ["Review auth"],
    branch: "ignored", baseCommit: "ignored", headCommit: "ignored",
  };
  await completeTool(f.state).execute(args);
  const result = await readJSON(f.file("result"));
  for (const name of ["evidence", "risks", "followUps"]) assert.deepEqual(result[name], args[name]);
  for (const name of ["branch", "baseCommit", "headCommit"]) assert.equal(Object.hasOwn(result, name), false);
  assert.deepEqual(result.checksPerformed, []);
});

test("complete publishes all successful code-change commit fields", async (t) => {
  const f = await fixture(t, { outputContract: "code-change" });
  const fields = { branch: "delegate/fix", baseCommit: f.h.baseCommit, headCommit: "b".repeat(40) };
  await completeTool(f.state).execute({ status: "success", summary: "Implemented", ...fields });
  const result = await readJSON(f.file("result"));
  assert.equal(result.outputContract, "code-change");
  for (const [key, value] of Object.entries(fields)) assert.equal(result[key], value);
});

for (const field of ["branch", "baseCommit", "headCommit"]) {
  for (const value of [undefined, ""]) {
    test(`complete rejects code-change success with ${field} ${value === undefined ? "missing" : "empty"}`, async (t) => {
      const f = await fixture(t, { outputContract: "code-change" });
      await assert.rejects(completeTool(f.state).execute({
        status: "success", summary: "Incomplete", branch: "delegate/fix",
        baseCommit: f.h.baseCommit, headCommit: "b".repeat(40), [field]: value,
      }), /code-change success requires branch, baseCommit, headCommit/);
      assert.equal(await exists(f.file("result")), false);
    });
  }
}

test("complete allows code-change failure without commits", async (t) => {
  const f = await fixture(t, { outputContract: "code-change" });
  await completeTool(f.state).execute({ status: "failure", summary: "Unable to proceed" });
  const result = await readJSON(f.file("result"));
  assert.equal(result.status, "failure");
  assert.equal(result.outputContract, "code-change");
  for (const name of ["branch", "baseCommit", "headCommit"]) assert.equal(Object.hasOwn(result, name), false);
});

test("complete rejects duplicate generation without changing the original result", async (t) => {
  const f = await fixture(t);
  await completeTool(f.state).execute({ status: "success", summary: "Original" });
  const original = await fs.readFile(f.file("result"), "utf8");
  await assert.rejects(completeTool(f.state).execute({ status: "failure", summary: "Duplicate" }),
    /generation 3 already completed/);
  assert.equal(await fs.readFile(f.file("result"), "utf8"), original);
});

test("complete replaces an older generation's result", async (t) => {
  const f = await fixture(t);
  await f.write("result", { generation: f.h.generation - 1, summary: "Old" });
  await completeTool(f.state).execute({ status: "success", summary: "Current" });
  const result = await readJSON(f.file("result"));
  assert.equal(result.generation, f.h.generation);
  assert.equal(result.summary, "Current");
});

test("complete fails closed when the existing result is malformed", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file("result"), "{broken");
  await assert.rejects(completeTool(f.state).execute({ status: "success", summary: "Current" }), SyntaxError);
  assert.equal(await fs.readFile(f.file("result"), "utf8"), "{broken");
});

test("complete rejects missing auth before publishing anything", async (t) => {
  const f = await fixture(t);
  await assert.rejects(completeTool({ ...f.state, consumed: null }).execute({ status: "success", summary: "No auth" }),
    /no job auth \(handoff not consumed\)/);
  assert.deepEqual(await fs.readdir(f.state.jobDir), []);
});

test("complete propagates publication errors", async (t) => {
  const f = await fixture(t);
  const failure = new Error("result write failed");
  t.mock.method(fs, "writeFile", async () => { throw failure; });
  await assert.rejects(completeTool(f.state).execute({ status: "failure", summary: "Failed" }),
    (error) => error === failure);
  assert.equal(await exists(f.file("result")), false);
});

async function heartbeatFixture(t, intervalMs) {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  const pending = [];
  const setInterval = globalThis.setInterval;
  const interval = t.mock.method(globalThis, "setInterval", (beat, ms) =>
    setInterval(() => { pending.push(beat()); }, ms));
  const writes = [];
  const writeFile = fs.writeFile;
  t.mock.method(fs, "writeFile", async (...args) => {
    await writeFile(...args);
    if (args[0] === f.file("heartbeat")) writes.push(args);
  });
  let stop;
  f.cleanup.push(async () => {
    stop?.();
    await Promise.all(pending);
  });
  return {
    ...f, writes, interval,
    start: () => { stop = startHeartbeat(f.state.jobDir, intervalMs); return stop; },
    async tick(ms) {
      t.mock.timers.tick(ms);
      await Promise.all(pending.splice(0));
    },
  };
}

test("heartbeat writes immediately, repeats every default interval, and disposes idempotently", async (t) => {
  const f = await heartbeatFixture(t);
  const stop = f.start();
  await until(() => f.writes.length === 1, "initial heartbeat was not written");
  assert.equal(await fs.readFile(f.file("heartbeat"), "utf8"), String(NOW));
  await privateFile(f.file("heartbeat"));
  assert.equal(f.interval.mock.calls[0].arguments[1], 10_000);
  await f.tick(9_999);
  assert.equal(f.writes.length, 1);
  await f.tick(1);
  assert.equal(f.writes.length, 2);
  assert.equal(await fs.readFile(f.file("heartbeat"), "utf8"), String(NOW + 10_000));
  stop();
  stop();
  await f.tick(30_000);
  assert.equal(f.writes.length, 2);
});

test("heartbeat honours custom intervals and permanently stops after a result appears", async (t) => {
  const f = await heartbeatFixture(t, 50);
  f.start();
  await until(() => f.writes.length === 1, "initial heartbeat was not written");
  await f.tick(50);
  assert.equal(f.writes.length, 2);
  await f.write("result", { status: "success" });
  await f.tick(50);
  assert.equal(f.writes.length, 2);
  await fs.unlink(f.file("result"));
  await f.tick(50);
  assert.equal(f.writes.length, 2, "removing a result must not resume a stopped heartbeat");
});

test("heartbeat does not create a file for an already completed job", async (t) => {
  const f = await heartbeatFixture(t, 50);
  await f.write("result", { status: "failure" });
  f.start();
  await f.tick(50);
  assert.equal(f.writes.length, 0);
  assert.equal(await exists(f.file("heartbeat")), false);
});

test("heartbeat disposal during result lookup prevents the pending write", async (t) => {
  const f = await fixture(t);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const access = fs.access;
  const lookup = t.mock.method(fs, "access", async (file) => {
    if (file === f.file("result")) await blocked;
    return access(file);
  });
  const write = t.mock.method(fs, "writeFile");
  const stop = startHeartbeat(f.state.jobDir);
  f.cleanup.push(stop);
  assert.equal(lookup.mock.callCount(), 1);
  stop();
  release();
  await lookup.mock.calls[0].result.catch(() => {});
  await yieldIO();
  assert.equal(write.mock.callCount(), 0);
});

test("heartbeat treats write failures as best-effort and retries on the next interval", async (t) => {
  const f = await heartbeatFixture(t, 50);
  const writeFile = fs.writeFile;
  let attempts = 0;
  t.mock.method(fs, "writeFile", async (...args) => {
    if (args[0] === f.file("heartbeat") && ++attempts === 1) throw new Error("temporary write failure");
    return writeFile(...args);
  });
  f.start();
  await until(() => attempts === 1, "initial heartbeat write was not attempted");
  assert.equal(await exists(f.file("heartbeat")), false);
  await f.tick(50);
  assert.equal(attempts, 2);
  assert.equal(await fs.readFile(f.file("heartbeat"), "utf8"), String(NOW + 50));
});

function reply(f, overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION, jobId: f.h.jobId, generation: f.h.generation,
    answer: "Use the smaller change.", at: NOW + 1_000, ...overrides,
  };
}

test("ask publishes a private authenticated block and consumes a valid reply", async (t) => {
  const f = await fixture(t);
  const question = "Which implementation?\nPlease include the constraints.";
  const run = startAsk(t, f, question);
  await run.poll();
  assert.deepEqual(await readJSON(f.file("block")), {
    protocolVersion: PROTOCOL_VERSION, jobId: f.h.jobId, generation: f.h.generation,
    completionToken: f.h.completionToken, question, at: NOW,
  });
  await privateFile(f.file("block"));
  await f.write("reply", reply(f));
  t.mock.timers.tick(2_000);
  assert.equal(await run.promise, "Use the smaller change.");
  assert.equal(await exists(f.file("block")), false);
  assert.equal(await exists(f.file("reply")), false);
});

test("ask accepts an already available matching reply, including an empty answer", async (t) => {
  const f = await fixture(t);
  await f.write("reply", reply(f, { answer: "" }));
  const run = startAsk(t, f);
  assert.equal(await run.promise, "");
  assert.deepEqual(await fs.readdir(f.state.jobDir), []);
});

test("ask returns a valid answer even when reply and block cleanup fail", async (t) => {
  const f = await fixture(t);
  await f.write("reply", reply(f));
  const unlink = t.mock.method(fs, "unlink", async () => { throw new Error("cleanup denied"); });
  const run = startAsk(t, f);
  assert.equal(await run.promise, "Use the smaller change.");
  assert.deepEqual(unlink.mock.calls.map((call) => call.arguments[0]), [f.file("reply"), f.file("block")]);
  assert.equal(await exists(f.file("reply")), true);
  assert.equal(await exists(f.file("block")), true);
});

for (const [label, overrides] of [
  ["another job", { jobId: "other-job" }],
  ["another generation", { generation: 4 }],
  ["a string generation", { generation: "3" }],
]) {
  test(`ask ignores a reply for ${label} until a matching reply arrives`, async (t) => {
    const f = await fixture(t);
    const invalid = reply(f, overrides);
    await f.write("reply", invalid);
    const run = startAsk(t, f);
    await run.poll();
    assert.deepEqual(await readJSON(f.file("reply")), invalid);
    assert.equal(await exists(f.file("block")), true);
    t.mock.timers.tick(2_000);
    await run.poll(2);
    await f.write("reply", reply(f));
    t.mock.timers.tick(2_000);
    assert.equal(await run.promise, "Use the smaller change.");
    assert.deepEqual(await fs.readdir(f.state.jobDir), []);
  });
}

test("ask ignores an unsupported reply version until a supported reply arrives", async (t) => {
  const f = await fixture(t);
  await f.write("reply", reply(f, { protocolVersion: PROTOCOL_VERSION + 1 }));
  const run = startAsk(t, f);
  await run.poll();
  await f.write("reply", reply(f));
  t.mock.timers.tick(2_000);
  assert.equal(await run.promise, "Use the smaller change.");
});

test("ask rejects malformed reply JSON instead of returning an answer", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file("reply"), "{broken");
  const run = startAsk(t, f);
  await assert.rejects(run.promise, SyntaxError);
  assert.equal(await fs.readFile(f.file("reply"), "utf8"), "{broken");
});

test("ask rejects missing auth without writing a block or scheduling polling", async (t) => {
  const f = await fixture(t);
  f.state.consumed = null;
  const run = startAsk(t, f);
  await assert.rejects(run.promise, /no job auth \(handoff not consumed\)/);
  assert.equal(run.timeoutCount(), 0);
  assert.deepEqual(await fs.readdir(f.state.jobDir), []);
});

test("ask rejects an already aborted context without consuming an available reply", async (t) => {
  const f = await fixture(t);
  const valid = reply(f);
  await f.write("reply", valid);
  const controller = new AbortController();
  controller.abort();
  const run = startAsk(t, f, "Already cancelled", controller);
  await assert.rejects(run.promise, /aborted while blocked/);
  assert.deepEqual(await readJSON(f.file("reply")), valid);
});

test("ask observes abort while polling on the next timer tick", async (t) => {
  const f = await fixture(t);
  const run = startAsk(t, f);
  await run.poll();
  run.controller.abort();
  t.mock.timers.tick(2_000);
  await assert.rejects(run.promise, /aborted while blocked/);
  assert.equal(await exists(f.file("reply")), false);
});

test("ask times out at ten minutes and removes the block without consuming an unrelated reply", async (t) => {
  const f = await fixture(t);
  const invalid = reply(f, { jobId: "other-job" });
  await f.write("reply", invalid);
  const run = startAsk(t, f);
  await run.poll();
  t.mock.timers.tick(598_000);
  await run.poll(2);
  assert.equal(await exists(f.file("block")), true);
  t.mock.timers.tick(2_000);
  await assert.rejects(run.promise, /no reply within 10 minutes/);
  assert.equal(await exists(f.file("block")), false);
  assert.deepEqual(await readJSON(f.file("reply")), invalid);
});

test("ask propagates block publication errors without polling", async (t) => {
  const f = await fixture(t);
  const failure = new Error("block write failed");
  t.mock.method(fs, "writeFile", async () => { throw failure; });
  const run = startAsk(t, f);
  await assert.rejects(run.promise, (error) => error === failure);
  assert.equal(run.timeoutCount(), 0);
  assert.equal(await exists(f.file("block")), false);
});

test("ask reports timeout rather than masking it with a block cleanup error", async (t) => {
  const f = await fixture(t);
  const run = startAsk(t, f);
  await run.poll();
  const unlink = t.mock.method(fs, "unlink", async () => { throw new Error("cleanup denied"); });
  t.mock.timers.tick(600_000);
  await assert.rejects(run.promise, /no reply within 10 minutes/);
  assert.equal(unlink.mock.callCount(), 1);
  assert.equal(unlink.mock.calls[0].arguments[0], f.file("block"));
  assert.equal(await exists(f.file("block")), true);
});
