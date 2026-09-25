import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Coordinator } from "../dist/coordinator.js";
import { existingRequests } from "../dist/requests.js";
import { FILES, readJSON, atomicWriteJSON, withSessionLock, SessionLockBusyError } from "../dist/protocol.js";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-requests-"));
  const old = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
  process.env.XDG_STATE_HOME = dir;
  process.env.HERDR_PANE_ID = "owner-pane";
  process.env.HERDR_SOCKET_PATH = "/test/herdr.sock";
  const pane = { pane_id: "target-pane", terminal_id: "target-terminal", agent: "opencode", agent_status: "working", cwd: dir,
    agent_session: { agent: "opencode", kind: "id", value: "target-session" } };
  const calls = [];
  const shell = (strings) => ({ text: async () => {
    assert.equal(strings.join(""), "herdr agent list");
    calls.push("inventory");
    return JSON.stringify({ result: { agents: [pane] } });
  } });
  const receipts = new Map();
  const posts = [];
  const options = { busy: false, lost: false, accepted: true, receipt: true, directory: dir, persona: true };
  const client = { session: {
    get: async ({ path: p }) => ({ data: { id: p.id, directory: options.directory } }),
    status: async () => ({ data: options.busy ? { "target-session": { type: "busy" } } : {} }),
    messages: async () => ({ data: options.persona ? [{ info: { role: "user", agent: "custom-persona", model: { providerID: "provider", modelID: "model" } } }] : [] }),
    message: async ({ path: p }) => {
      const data = options.receipt ? receipts.get(p.messageID) : undefined;
      return { data, error: data ? undefined : {}, response: { status: data ? 200 : 404 } };
    },
    promptAsync: async (request) => {
      posts.push(request);
      if (options.accepted) receipts.set(request.body.messageID, { parts: request.body.parts });
      if (options.lost) throw new Error("lost response");
      return {};
    },
  }, tui: { showToast: async () => ({}) } };
  const coordinator = new Coordinator(shell, client, dir);
  const receiver = existingRequests(shell, client, dir);
  t.after(async () => {
    await receiver.dispose();
    await coordinator.dispose();
    await fs.rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const enqueue = async () => {
    process.env.HERDR_PANE_ID = "owner-pane";
    const result = await coordinator.requestAgent("target-pane", "Review the existing draft. Do not change files.", "owner-session", "target-session");
    const id = result.match(/[a-f0-9]{32}/)[0];
    await coordinator.reconcile(id);
    process.env.HERDR_PANE_ID = "target-pane";
    return id;
  };
  const file = (id, name) => path.join(dir, "herdr-envoy", "sessions", id, FILES[name]);
  return { dir, pane, calls, posts, receipts, options, coordinator, receiver, enqueue, file, client, shell };
}

test("existing local requests wait while busy, preserve persona and hand back without owning resources", async (t) => {
  const f = await fixture(t);
  const id = await f.enqueue();
  await f.receiver.tick();
  assert.equal(f.posts.length, 0);
  f.pane.agent_status = "idle";
  f.options.busy = true;
  await f.receiver.tick();
  assert.equal(f.posts.length, 0);
  f.options.busy = false;
  await f.receiver.tick();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].path.id, "target-session");
  assert.equal(f.posts[0].body.agent, "custom-persona");
  assert.deepEqual(f.posts[0].body.model, { providerID: "provider", modelID: "model" });
  assert.equal(f.posts[0].query.directory, f.dir);
  assert.match(f.posts[0].body.messageID, /^msg_[a-f0-9]{26}$/);
  const ctx = { sessionID: "target-session" };
  assert.match(await f.receiver.read_task.execute({ jobId: id }, ctx), /Review the existing draft/);
  await assert.rejects(f.receiver.read_task.execute({ jobId: id }, { sessionID: "wrong" }), /not delivered/);
  await f.receiver.hand_back.execute({ jobId: id, disposition: "pause", summary: "Reviewed", userInstruction: "Pause this request" }, ctx);
  assert.equal((await readJSON(f.file(id, "session"))).summary, "Reviewed");
  assert.equal((await readJSON(f.file(id, "coordinator"))).worktreeCreated, undefined);
  await assert.rejects(f.coordinator.reap(id, { discard: true, confirmation: id }), /not owned/);
  await assert.rejects(f.coordinator.resumeSession(id), /cannot be resumed/);
  const listing = JSON.parse(await f.coordinator.listSessions("owner-session"));
  assert.equal(listing[0].existingAgent, true);
  assert.equal(listing[0].requestDelivered, true);
});

test("one outstanding request gates later requests until handback", async (t) => {
  const f = await fixture(t);
  const first = await f.enqueue();
  const second = await f.enqueue();
  // Pin deterministic FIFO order even on a coarse clock.
  const record = await readJSON(f.file(second, "coordinator"));
  record.createdAt += 1000;
  await atomicWriteJSON(f.file(second, "coordinator"), record);
  f.pane.agent_status = "done";
  await Promise.all([f.receiver.tick(), f.receiver.tick()]);
  await f.receiver.tick();
  assert.equal(f.posts.length, 1);
  await f.receiver.hand_back.execute({ jobId: first, disposition: "pause", summary: "Paused", userInstruction: "Pause" }, { sessionID: "target-session" });
  await f.receiver.tick();
  assert.equal(f.posts.length, 2);
});

test("lost submission response recovers from receipt without duplicate input", async (t) => {
  const f = await fixture(t);
  const id = await f.enqueue();
  f.pane.agent_status = "idle";
  f.options.lost = true;
  await f.receiver.tick();
  assert.equal((await readJSON(f.file(id, "coordinator"))).existing.delivered, undefined);
  await f.receiver.tick();
  assert.equal(f.posts.length, 1);
  assert.equal((await readJSON(f.file(id, "coordinator"))).existing.delivered, true);
});

test("uncertain submission stays pending and is never blindly replayed", async (t) => {
  const f = await fixture(t);
  const id = await f.enqueue();
  f.pane.agent_status = "idle";
  f.options.accepted = false;
  f.options.lost = true;
  await f.receiver.tick();
  await f.receiver.tick();
  assert.equal(f.posts.length, 1);
  assert.ok((await readJSON(f.file(id, "coordinator"))).existing.attemptedAt);
  assert.equal(JSON.parse(await f.coordinator.listSessions("owner-session"))[0].requestDelivered, false);
  await assert.rejects(f.coordinator.cancelRequest(id, "other-owner"), /owned/);
  await f.coordinator.cancelRequest(id, "owner-session");
  assert.equal(JSON.parse(await f.coordinator.listSessions("owner-session"))[0].requestCancelled, true);
  f.options.accepted = true;
  f.options.lost = false;
  await f.enqueue();
  await f.receiver.tick();
  assert.equal(f.posts.length, 2);
});

test("handback after lost acknowledgement confirms delivery before coordinator notification", async (t) => {
  const f = await fixture(t);
  const id = await f.enqueue();
  f.pane.agent_status = "idle";
  f.options.lost = true;
  await f.receiver.tick();
  f.options.lost = false;
  await f.receiver.hand_back.execute({ jobId: id, disposition: "pause", summary: "Returned", userInstruction: "Pause" }, { sessionID: "target-session" });
  await f.coordinator.reconcile(id);
  await f.coordinator.reconcile(id);
  assert.equal((await readJSON(f.file(id, "coordinator"))).existing.delivered, true);
  assert.ok(f.posts.some((p) => p.path.id === "owner-session" && p.body.parts[0].text.includes("EXISTING-AGENT HAND-BACK")));
});

test("queued request survives receiver restart and socket or terminal mismatch cannot redirect it", async (t) => {
  const f = await fixture(t);
  await f.enqueue();
  f.pane.agent_status = "idle";
  process.env.HERDR_SOCKET_PATH = "/other/socket";
  await f.receiver.tick();
  process.env.HERDR_SOCKET_PATH = "/test/herdr.sock";
  f.pane.terminal_id = "replacement";
  await f.receiver.tick();
  assert.equal(f.posts.length, 0);
  f.pane.terminal_id = "target-terminal";
  await f.receiver.dispose();
  // A fresh receiver must discover persisted state rather than an in-memory queue.
  const receiver = existingRequests(f.shell, f.client, f.dir);
  await receiver.tick();
  await receiver.dispose();
  assert.equal(f.posts.length, 1);
});

test("never targets a replacement conversation, blocked agent or another directory", async (t) => {
  const f = await fixture(t);
  await f.enqueue();
  f.pane.agent_status = "blocked";
  await f.receiver.tick();
  f.pane.agent_status = "idle";
  f.pane.agent_session.value = "replacement";
  await f.receiver.tick();
  f.pane.agent_session.value = "target-session";
  f.options.directory = "/different";
  await f.receiver.tick();
  f.options.directory = f.dir;
  f.options.persona = false;
  await f.receiver.tick();
  assert.equal(f.posts.length, 0);
});

test("rejects invalid targets and request tool IDs without side effects", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.coordinator.requestAgent("target-pane", "  ", "owner"), /nonblank/);
  await assert.rejects(f.coordinator.requestAgent("missing", "task", "owner"), /live local/);
  await assert.rejects(f.coordinator.requestAgent("target-pane", "task", "target-session", "target-session"), /itself/);
  await assert.rejects(f.coordinator.requestAgent("target-pane", "task", "owner", "stale-session"), /live local/);
  f.pane.agent = "claude";
  await assert.rejects(f.coordinator.requestAgent("target-pane", "task", "owner"), /live local/);
  await assert.rejects(f.receiver.read_task.execute({}, {}), /Specify/);
  await assert.rejects(f.receiver.hand_back.execute({}, {}), /Specify/);
  await assert.rejects(f.receiver.read_task.execute({ jobId: "../outside" }, {}), /Invalid request/);
  assert.equal(f.posts.length, 0);
});

test("a lock released between contention and inspection is retryable, not a state failure", async (t) => {
  await fixture(t);
  t.mock.method(fs, "open", async () => { throw Object.assign(new Error("busy"), { code: "EEXIST" }); });
  t.mock.method(fs, "readFile", async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); });
  await assert.rejects(withSessionLock("released", async () => assert.fail("must not enter")), SessionLockBusyError);
});
