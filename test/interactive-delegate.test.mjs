import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { tool } from "@opencode-ai/plugin";
import { consume, handBackTool, readTaskTool } from "../dist/delegate.js";
import { FILES, PROTOCOL_VERSION, atomicWriteJSON, readJSON } from "../dist/protocol.js";

const ctx = { sessionID: "interactive-worker-session" };
const request = { disposition: "pause", summary: "Implementation ready for review.", userInstruction: "Pause here, please." };

async function fixture(t) {
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-interactive-delegate-"));
  t.after(() => fs.rm(jobDir, { recursive: true, force: true }));
  const file = (name) => path.join(jobDir, FILES[name]);
  const session = {
    protocolVersion: PROTOCOL_VERSION, jobId: "interactive-job", generation: 1,
    completionToken: "interactive-token", status: "active",
  };
  const handoff = {
    protocolVersion: session.protocolVersion, jobId: session.jobId, generation: session.generation,
    completionToken: session.completionToken, mode: "interactive", agent: "worker",
    task: "Work with the user on the implementation.", outputContract: "code-change",
    targetBranch: "main", baseCommit: "a".repeat(40), mergePolicy: "manual", checks: [],
    startupTimeoutSeconds: 30,
  };
  await atomicWriteJSON(file("handoff"), handoff);
  await atomicWriteJSON(file("session"), session);
  const state = await consume(jobDir);
  return { jobDir, file, session, handoff, state,
    read: () => readJSON(file("session")),
    write: (value) => atomicWriteJSON(file("session"), value),
  };
}

test("interactive consume preserves mode and read_task durably binds the caller", async (t) => {
  const f = await fixture(t);
  const { startupTimeoutSeconds, ...snapshot } = f.handoff;
  assert.deepEqual(await readJSON(f.file("consumed")), snapshot);
  const text = await readTaskTool(f.state).execute({}, ctx);
  assert.deepEqual(await f.read(), { ...f.session, sessionID: ctx.sessionID });
  assert.match(text, /user steers/);
  assert.match(text, /only after the user explicitly/);
  assert.match(text, /Do not call `complete` or `ask`/);
  assert.match(text, /Do not automatically commit or clean up/);
  assert.match(text, /reread current control/);
  assert.ok(text.includes(f.handoff.task));
  assert.ok(!text.includes(f.session.completionToken));
  const restarted = await consume(f.jobDir);
  assert.equal(restarted.consumed.mode, "interactive");
  const rename = t.mock.method(fs, "rename");
  await readTaskTool(restarted).execute({}, ctx);
  assert.equal(rename.mock.callCount(), 0, "an existing binding must not be republished");
  await assert.rejects(readTaskTool(restarted).execute({}, { sessionID: "other" }), /another sessionID/);
});

test("pause and coordinator resume use fresh control and a new generation", async (t) => {
  const f = await fixture(t);
  const readTask = readTaskTool(f.state);
  const handBack = handBackTool(f.state);
  await readTask.execute({}, ctx);
  await handBack.execute(request, ctx);
  const paused = await f.read();
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.checks, []);
  assert.deepEqual(paused.risks, []);
  assert.match(paused.handbackID, /^[0-9a-f]{32}$/);
  assert.match(await readTask.execute({}, ctx), /Status: paused.*Generation: 1/);
  await f.write({ ...paused, status: "active", generation: 2 });
  await assert.rejects(handBack.execute(request, ctx), /generation changed/);
  assert.match(await readTask.execute({}, ctx), /Status: active.*Generation: 2/);
  await handBack.execute({ ...request, disposition: "commit", userInstruction: "Hand this back for commit." }, ctx);
  const committed = await f.read();
  assert.equal(committed.status, "commit");
  assert.equal(committed.generation, 2);
  assert.notEqual(committed.handbackID, paused.handbackID);
  assert.equal((await readJSON(f.file("consumed"))).generation, 1);
  const restarted = await consume(f.jobDir);
  await readTaskTool(restarted).execute({}, ctx);
  assert.equal(restarted.interactiveGeneration, 2);
});

for (const disposition of ["pause", "commit", "discard"]) {
  test(`${disposition} publishes atomically and identical retries never republish`, async (t) => {
    const f = await fixture(t);
    await readTaskTool(f.state).execute({}, ctx);
    const before = await f.read();
    const rename = fs.rename;
    const publish = t.mock.method(fs, "rename", async (source, dest) => {
      assert.equal(dest, f.file("session"));
      assert.equal(path.dirname(source), f.jobDir);
      assert.deepEqual(await f.read(), before);
      await rename(source, dest);
    });
    const args = { ...request, disposition, checks: ["npm test passed"], risks: ["Manual review outstanding"],
      userInstruction: `Please ${disposition} this session.` };
    await handBackTool(f.state).execute(args, ctx);
    const published = await f.read();
    assert.deepEqual(published, { ...before, status: disposition === "pause" ? "paused" : disposition,
      summary: args.summary, checks: args.checks, risks: args.risks, userInstruction: args.userInstruction,
      handbackID: published.handbackID });
    assert.match(published.handbackID, /^[0-9a-f]{32}$/);
    assert.match(await handBackTool(f.state).execute(args, ctx), /already reported/);
    assert.equal(publish.mock.callCount(), 1);
    assert.deepEqual(await f.read(), published);
    for (const changed of [
      { summary: "Changed" }, { checks: [] }, { risks: [] }, { userInstruction: "Different instruction" },
      { disposition: disposition === "pause" ? "commit" : "pause" },
    ]) {
      await assert.rejects(handBackTool(f.state).execute({ ...args, ...changed }, ctx), /not active/);
    }
    assert.equal(publish.mock.callCount(), 1);
    assert.deepEqual((await fs.readdir(f.jobDir)).sort(), [FILES.consumed, FILES.session].sort());
    if (process.platform !== "win32") assert.equal((await fs.stat(f.file("session"))).mode & 0o777, 0o600);
  });
}

for (const change of [
  { protocolVersion: PROTOCOL_VERSION + 1 }, { jobId: "other-job" }, { completionToken: "other-token" },
  { generation: 0 }, { generation: "1" }, { status: "unknown" }, { sessionID: "other-session" },
]) {
  test(`interactive tools reject changed disk control ${JSON.stringify(change)}`, async (t) => {
    const f = await fixture(t);
    await readTaskTool(f.state).execute({}, ctx);
    const changed = { ...await f.read(), ...change };
    await f.write(changed);
    await assert.rejects(readTaskTool(f.state).execute({}, ctx));
    await assert.rejects(handBackTool(f.state).execute(request, ctx));
    assert.deepEqual(await f.read(), changed);
  });
}

test("hand_back rejects absent auth, non-interactive auth, missing context and unbound sessions", async (t) => {
  const f = await fixture(t);
  for (const consumed of [null, { ...f.state.consumed, mode: undefined }]) {
    await assert.rejects(handBackTool({ ...f.state, consumed }).execute(request, ctx), /no interactive job auth/);
  }
  await assert.rejects(readTaskTool(f.state).execute({}), /ctx.sessionID/);
  await assert.rejects(handBackTool(f.state).execute(request), /ctx.sessionID/);
  await assert.rejects(handBackTool(f.state).execute(request, ctx), /call read_task/);
  assert.deepEqual(await f.read(), f.session);
  await f.write({ ...f.session, status: "paused" });
  await assert.rejects(readTaskTool(f.state).execute({}, ctx), /not active/);
});

test("interactive tools fail closed on missing or malformed session files", async (t) => {
  const f = await fixture(t);
  await readTaskTool(f.state).execute({}, ctx);
  await fs.unlink(f.file("session"));
  await assert.rejects(readTaskTool(f.state).execute({}, ctx), { code: "ENOENT" });
  await assert.rejects(handBackTool(f.state).execute(request, ctx), { code: "ENOENT" });
  await fs.writeFile(f.file("session"), "{broken");
  await assert.rejects(readTaskTool(f.state).execute({}, ctx), SyntaxError);
  await assert.rejects(handBackTool(f.state).execute(request, ctx), SyntaxError);
  assert.equal(await fs.readFile(f.file("session"), "utf8"), "{broken");
});

test("hand_back rechecks binding and inactive control even for identical retries", async (t) => {
  const f = await fixture(t);
  await readTaskTool(f.state).execute({}, ctx);
  const handBack = handBackTool(f.state);
  await assert.rejects(handBack.execute(request, { sessionID: "another-caller" }), /another sessionID/);
  await f.write({ ...await f.read(), status: "paused" });
  await assert.rejects(handBack.execute(request, ctx), /not active/);
  await f.write({ ...await f.read(), status: "active" });
  await handBack.execute(request, ctx);
  const paused = await f.read();
  await f.write({ ...paused, completionToken: "replaced-token" });
  await assert.rejects(handBack.execute(request, ctx), /identity mismatch/);
  await f.write({ ...paused, sessionID: "another-caller" });
  await assert.rejects(handBack.execute(request, ctx), /another sessionID/);
});

test("failed binding or hand-back publication leaves disk control unchanged and can be retried", async (t) => {
  const f = await fixture(t);
  const failure = new Error("disk full");
  const write = t.mock.method(fs, "writeFile", async () => { throw failure; });
  await assert.rejects(readTaskTool(f.state).execute({}, ctx), (error) => error === failure);
  assert.deepEqual(await f.read(), f.session);
  assert.equal(f.state.interactiveGeneration, undefined);
  write.mock.restore();
  await readTaskTool(f.state).execute({}, ctx);
  const bound = await f.read();
  const failedPublish = t.mock.method(fs, "writeFile", async () => { throw failure; });
  await assert.rejects(handBackTool(f.state).execute(request, ctx), (error) => error === failure);
  assert.deepEqual(await f.read(), bound);
  failedPublish.mock.restore();
  await handBackTool(f.state).execute(request, ctx);
  assert.equal((await f.read()).status, "paused");
});

test("hand_back schema defaults arrays and requires an explicit nonblank instruction", async (t) => {
  const f = await fixture(t);
  const handBack = handBackTool(f.state);
  const schema = tool.schema.object(handBack.args);
  assert.deepEqual(schema.parse(request), { ...request, checks: [], risks: [] });
  assert.match(handBack.args.userInstruction.description, /quote the user's explicit instruction/);
  await readTaskTool(f.state).execute({}, ctx);
  for (const change of [
    { userInstruction: undefined }, { userInstruction: "" }, { userInstruction: "   " },
    { disposition: "complete" }, { summary: undefined }, { checks: [1] }, { risks: "none" },
  ]) {
    const invalid = { ...request, ...change };
    assert.equal(schema.safeParse(invalid).success, false);
    await assert.rejects(handBack.execute(invalid, ctx));
  }
  assert.equal((await f.read()).status, "active");
});
