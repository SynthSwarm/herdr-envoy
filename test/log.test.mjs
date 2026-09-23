import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { lifecycle, logRoot } from "../dist/log.js";

const jobId = "0123456789abcdef0123456789abcdef";
const events = ["created", "recovered", "launch_started", "launch_failed",
  "notification_queued", "notification_deferred", "notification_attempted",
  "notification_delivered", "notification_superseded", "reconciliation_failed",
  "resume_started", "resume_completed", "resume_failed", "handback", "handback_duplicate",
  "cleanup_started", "cleanup_completed", "cleanup_failed"];

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-log-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  t.after(async () => {
    t.mock.restoreAll();
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(logRoot(), path.join(root, "herdr-envoy", "logs"));
  return logRoot();
}

async function records(directory) {
  const files = await fs.readdir(directory);
  const texts = await Promise.all(files.map(name => fs.readFile(path.join(directory, name), "utf8")));
  return texts.flatMap(text => {
    assert.ok(text.endsWith("\n"));
    return text.slice(0, -1).split("\n").map(line => JSON.parse(line));
  });
}

test("log root falls back to the user's state directory without XDG_STATE_HOME", t => {
  const previous = process.env.XDG_STATE_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  for (const value of [undefined, ""]) {
    if (value === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = value;
    assert.equal(logRoot(), path.join(os.homedir(), ".local", "state", "herdr-envoy", "logs"));
  }
});

test("runtime event and job ID allowlists reject invalid inputs without creating logs", async t => {
  const directory = await fixture(t);
  const hostile = { toString() { throw new Error("must not coerce"); } };
  for (const id of ["", "../secret", "a".repeat(31), "a".repeat(33), "A".repeat(32), `${jobId}\n`, null, undefined, 123, hostile]) {
    await assert.doesNotReject(lifecycle(id, "created"));
  }
  for (const event of ["secret-token", "CREATED", "toString", "__proto__", "", null, undefined, 1, hostile]) {
    await assert.doesNotReject(lifecycle(jobId, event));
  }
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("all lifecycle events are logged with only allowlisted metadata", async t => {
  const directory = await fixture(t);
  const details = { generation: 2, disposition: "active", reason: "busy", httpStatus: 503 };
  for (const key of ["summary", "task", "token", "exception", "repo", "path", "message", "event", "jobId", "time", "toJSON"]) {
    Object.defineProperty(details, key, { enumerable: true, get() { throw new Error(`must not read ${key}`); } });
  }
  for (const event of events) await lifecycle(jobId, event, details);
  const rows = await records(directory);
  assert.deepEqual(rows.map(row => row.event), events);
  for (const row of rows) {
    assert.equal(row.time, new Date(row.time).toISOString());
    assert.deepEqual(row, { time: row.time, jobId, event: row.event,
      generation: 2, disposition: "active", reason: "busy", httpStatus: 503 });
  }
});

test("only enum values and safe integer numbers survive runtime detail validation", async t => {
  const directory = await fixture(t);
  for (const value of ["private-content", "200", {}, [], null, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, 1n, true]) {
    await lifecycle(jobId, "created", { generation: value, disposition: value, reason: value, httpStatus: value });
  }
  await lifecycle(jobId, "created", null);
  for (const row of await records(directory)) {
    assert.deepEqual(Object.keys(row).sort(), ["event", "jobId", "time"]);
  }
  for (const disposition of ["active", "paused", "commit", "discard"]) {
    await lifecycle(jobId, "handback", { disposition });
  }
  for (const reason of ["busy", "retry_delay", "readback", "transport", "state", "resume", "new_handback"]) {
    await lifecycle(jobId, "notification_deferred", { reason });
  }
  const rows = await records(directory);
  assert.deepEqual(rows.filter(row => row.disposition).map(row => row.disposition), ["active", "paused", "commit", "discard"]);
  assert.deepEqual(rows.filter(row => row.reason).map(row => row.reason), ["busy", "retry_delay", "readback", "transport", "state", "resume", "new_handback"]);
});

test("validated fields are read once and arbitrary content fields never reach JSON", async t => {
  const directory = await fixture(t);
  let reads = 0;
  await lifecycle(jobId, "created", {
    get reason() { return ++reads === 1 ? "busy" : "private-exception"; },
    summary: "private-summary", task: "private-task", token: "private-token",
    exception: new Error("private-exception"), repo: "/private/repo",
  });
  assert.equal(reads, 1);
  const [row] = await records(directory);
  assert.deepEqual(row, { time: row.time, jobId, event: "created", reason: "busy" });
});

test("directory and daily file permissions are private, including existing paths", async t => {
  const directory = await fixture(t);
  await lifecycle(jobId, "created");
  const [name] = await fs.readdir(directory);
  assert.match(name, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const file = path.join(directory, name);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.chmod(directory, 0o777);
  await fs.chmod(file, 0o666);
  await lifecycle(jobId, "recovered");
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await records(directory)).length, 2);
});

test("retention removes only own regular files outside the 30 UTC dates", async t => {
  const directory = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-23T12:00:00Z") });
  await fs.mkdir(directory, { recursive: true });
  const keep = ["2026-08-25.jsonl", "2026-09-22.jsonl", "2026-09-24.jsonl",
    "notes.txt", "2020-01-01.jsonl.bak", "prefix-2020-01-01.jsonl", "2020-02-30.jsonl", "2020-99-99.jsonl", "2020-01-01.jsonl\n"];
  const remove = ["2026-08-24.jsonl", "2026-08-23.jsonl", "2020-01-01.jsonl"];
  for (const name of [...keep, ...remove]) await fs.writeFile(path.join(directory, name), "untouched");
  await fs.mkdir(path.join(directory, "2020-01-02.jsonl"));
  await fs.symlink(path.join(directory, "notes.txt"), path.join(directory, "2020-01-03.jsonl"));
  await lifecycle(jobId, "created");
  assert.deepEqual((await fs.readdir(directory)).sort(), [...keep, "2020-01-02.jsonl", "2020-01-03.jsonl", "2026-09-23.jsonl"].sort());
  for (const name of keep) assert.equal(await fs.readFile(path.join(directory, name), "utf8"), "untouched");
});

test("daily logging stops at 8 MiB, allows one boundary-crossing record and resumes on the next UTC date", async t => {
  const directory = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-23T23:59:59Z") });
  await lifecycle(jobId, "created");
  const file = path.join(directory, "2026-09-23.jsonl");
  const line = await fs.readFile(file, "utf8");
  const cap = 8 * 1024 * 1024;
  await fs.truncate(file, cap);
  await lifecycle(jobId, "created");
  assert.equal((await fs.stat(file)).size, cap, "a file already at the cap must not grow");
  await fs.truncate(file, cap - 1);
  await lifecycle(jobId, "created");
  const size = cap - 1 + Buffer.byteLength(line);
  assert.equal((await fs.stat(file)).size, size, "a final complete record may cross the cap");
  const contents = await fs.readFile(file);
  assert.equal(contents.subarray(cap - 1).toString(), line);
  await lifecycle(jobId, "recovered");
  assert.equal((await fs.stat(file)).size, size, "later records must be dropped once over the cap");
  t.mock.timers.tick(1000);
  await lifecycle(jobId, "recovered");
  assert.equal((await fs.stat(file)).size, size);
  const nextDay = JSON.parse(await fs.readFile(path.join(directory, "2026-09-24.jsonl"), "utf8"));
  assert.deepEqual(nextDay, { time: "2026-09-24T00:00:00.000Z", jobId, event: "recovered" });
});

test("cleanup is shared for concurrent calls, cached by directory and day, and reruns at UTC midnight", async t => {
  const directory = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-23T23:59:59Z") });
  const scan = t.mock.method(fs, "readdir");
  await Promise.all(Array.from({ length: 30 }, () => lifecycle(jobId, "created")));
  await lifecycle(jobId, "recovered");
  assert.equal(scan.mock.callCount(), 1);
  await fs.writeFile(path.join(directory, "2026-08-25.jsonl"), "old");
  t.mock.timers.tick(1000);
  await lifecycle(jobId, "created");
  assert.equal(scan.mock.callCount(), 2);
  await assert.rejects(fs.stat(path.join(directory, "2026-08-25.jsonl")), { code: "ENOENT" });
  process.env.XDG_STATE_HOME = path.join(process.env.XDG_STATE_HOME, "other");
  await lifecycle(jobId, "created");
  assert.equal(scan.mock.callCount(), 3);
});

test("failed cleanup is non-fatal and retried in the same day", async t => {
  const directory = await fixture(t);
  await fs.mkdir(directory, { recursive: true });
  const oldFile = path.join(directory, "2000-01-01.jsonl");
  await fs.writeFile(oldFile, "old");
  const scan = t.mock.method(fs, "readdir");
  scan.mock.mockImplementationOnce(async () => { throw new Error("private exception"); });
  await assert.doesNotReject(lifecycle(jobId, "created"));
  const unlink = t.mock.method(fs, "unlink");
  unlink.mock.mockImplementationOnce(async () => { throw new Error("private exception"); });
  await assert.doesNotReject(lifecycle(jobId, "recovered"));
  await assert.doesNotReject(lifecycle(jobId, "recovered"));
  assert.equal(scan.mock.callCount(), 3);
  await assert.rejects(fs.stat(oldFile), { code: "ENOENT" });
  assert.equal((await records(directory)).length, 3);
});

test("missing retention candidates do not prevent cleanup of remaining files", async t => {
  const directory = await fixture(t);
  await fs.mkdir(directory, { recursive: true });
  for (const name of ["2000-01-01.jsonl", "2000-01-02.jsonl"]) await fs.writeFile(path.join(directory, name), "old");
  const realUnlink = fs.unlink.bind(fs);
  const unlink = t.mock.method(fs, "unlink");
  unlink.mock.mockImplementationOnce(async file => {
    await realUnlink(file);
    throw Object.assign(new Error("already removed"), { code: "ENOENT" });
  });
  await lifecycle(jobId, "created");
  assert.equal((await fs.readdir(directory)).length, 1);
});

test("concurrent processes append complete JSON lines without losing records", async t => {
  const directory = await fixture(t);
  const moduleUrl = new URL("../dist/log.js", import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, (_, worker) => promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    import { lifecycle } from ${JSON.stringify(moduleUrl)};
    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      lifecycle(${JSON.stringify(jobId)}, "created", { generation: ${worker * 50} + index })));
  `])));
  const rows = await records(directory);
  assert.equal(rows.length, 200);
  assert.deepEqual(rows.map(row => row.generation).sort((a, b) => a - b), Array.from({ length: 200 }, (_, i) => i));
});

test("runtime getters and filesystem failures never escape or print content", async t => {
  const directory = await fixture(t);
  const output = [t.mock.method(console, "error", () => {}), t.mock.method(console, "warn", () => {}), t.mock.method(console, "log", () => {})];
  await assert.doesNotReject(lifecycle(jobId, "created", { get reason() { throw new Error("secret"); } }));
  for (const method of ["mkdir", "lstat", "chmod", "open"]) {
    const mocked = t.mock.method(fs, method, async () => { throw new Error("private token repo task summary"); });
    await assert.doesNotReject(lifecycle(jobId, "created"));
    mocked.mock.restore();
  }
  for (const method of ["stat", "chmod", "writeFile", "close"]) {
    const handle = { stat: async () => ({ isFile: () => true }), chmod: async () => {}, writeFile: async () => {}, close: async () => {} };
    const close = t.mock.method(handle, "close");
    t.mock.method(handle, method, async () => { throw new Error("private exception"); });
    const open = t.mock.method(fs, "open", async () => handle);
    await assert.doesNotReject(lifecycle(jobId, "created"));
    if (method !== "close") assert.equal(close.mock.callCount(), 1);
    open.mock.restore();
  }
  assert.deepEqual(await fs.readdir(directory), []);
  for (const spy of output) assert.equal(spy.mock.callCount(), 0);
});

test("symlinked log directories and daily files are not followed", async t => {
  const directory = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-23T12:00:00Z") });
  const target = path.join(process.env.XDG_STATE_HOME, "unrelated");
  await fs.mkdir(target);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.symlink(target, directory);
  await assert.doesNotReject(lifecycle(jobId, "created"));
  assert.deepEqual(await fs.readdir(target), []);
  await fs.unlink(directory);
  await fs.mkdir(directory);
  const file = path.join(target, "file");
  await fs.writeFile(file, "untouched", { mode: 0o644 });
  await fs.symlink(file, path.join(directory, "2026-09-23.jsonl"));
  await assert.doesNotReject(lifecycle(jobId, "created"));
  assert.equal(await fs.readFile(file, "utf8"), "untouched");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o644);
});
