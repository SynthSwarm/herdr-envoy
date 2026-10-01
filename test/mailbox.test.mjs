import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readMailbox, displayText } from "../dist/mailbox.js";
import { atomicWriteJSON, FILES, sessionRoot, root } from "../dist/protocol.js";

test("mailbox scopes inbox/outbox to exact conversation and directory, retains reports and excludes credentials", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-mailbox-"));
  const old = [process.env.XDG_STATE_HOME, process.env.XDG_RUNTIME_DIR];
  process.env.XDG_STATE_HOME = dir;
  process.env.XDG_RUNTIME_DIR = path.join(dir, "runtime");
  t.after(async () => {
    for (const [i, key] of ["XDG_STATE_HOME", "XDG_RUNTIME_DIR"].entries()) {
      if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await readMailbox("", ""), { items: [], incomplete: false });
  assert.deepEqual(await readMailbox("me", "/my/project"), { items: [], incomplete: false });
  const publish = async (id, job, state, base = sessionRoot()) => {
    const folder = path.join(base, id.repeat(32));
    await fs.mkdir(folder, { recursive: true });
    await atomicWriteJSON(path.join(folder, FILES.coordinator), { jobId: id.repeat(32), phase: "running", createdAt: 10, ...job });
    if (state) await atomicWriteJSON(path.join(folder, FILES.session), { completionToken: "secret-token", ...state });
    return folder;
  };
  const base = { directory: "/sender", worktree: "/my/project", sessionID: "sender", mode: "interactive", existing: { sessionID: "me" } };
  await publish("a", base, { status: "active" });
  await publish("b", { ...base, existing: { sessionID: "me", attemptedAt: 10 } }, { status: "active" });
  await publish("c", { ...base, existing: { sessionID: "me", delivered: true } }, { status: "completed", summary: "Report", checks: ["passed", 2], risks: ["review"] });
  await publish("d", { ...base, directory: "/my/project", worktree: "/target", sessionID: "me", name: "Peer", existing: { sessionID: "other", cancelled: true } }, { status: "active" });
  await publish("e", { ...base, worktree: "/wrong" }, { status: "active" });
  const bounded = await publish("f", { directory: "/my/project", sessionID: "me", worktree: "/target", agent: "worker" }, null, root());
  await atomicWriteJSON(path.join(bounded, FILES.result), { status: "success", summary: "Finished", completionToken: "secret-token" });
  const result = await readMailbox("me", "/my/project");
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.items.map((i) => i.state), ["queued", "unconfirmed", "completed", "cancelled", "success"]);
  assert.deepEqual(result.items.map((i) => i.direction), ["inbox", "inbox", "inbox", "outbox", "outbox"]);
  assert.deepEqual(result.items[2].checks, ["passed"]);
  assert.equal(result.items[2].summary, "Report");
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
  await fs.writeFile(path.join(bounded, FILES.result), "invalid");
  assert.equal((await readMailbox("me", "/my/project")).incomplete, true);
});

test("display text strips terminal and bidi controls and is bounded", () => {
  assert.equal(displayText("hello\u001b\u202e world", 8), "hello wo");
  assert.equal(displayText(null), "");
});
