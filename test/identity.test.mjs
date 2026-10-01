import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentRef, conversationRef, listAgentsTool } from "../dist/identity.js";
import { atomicWriteJSON, FILES, sessionRoot } from "../dist/protocol.js";

test("references are safe, readable and scoped to a machine and conversation", () => {
  assert.equal(agentRef("Access Review / QA", "a".repeat(32)), "access-review-qa-aaaaaaaaaaaa");
  assert.equal(agentRef("!!!", "b".repeat(32)), "agent-bbbbbbbbbbbb");
  assert.notEqual(conversationRef("local", "one"), conversationRef("remote", "one"));
  assert.notEqual(conversationRef("local", "one"), conversationRef("local", "two"));
  assert.equal(conversationRef("local", "one"), conversationRef("local", "one"));
});

test("discovery joins verified owned identity, redacts remotes, and leaves other agents untouched", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-identity-"));
  const env = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    HERDR_ENV: process.env.HERDR_ENV, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
  process.env.XDG_STATE_HOME = dir;
  process.env.XDG_RUNTIME_DIR = path.join(dir, "runtime");
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "socket";
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const jobId = "a".repeat(32);
  const jobDir = path.join(sessionRoot(), jobId);
  await fs.mkdir(jobDir, { recursive: true });
  await atomicWriteJSON(path.join(jobDir, FILES.coordinator), {
    jobId, identity: "access-review-aaaaaaaaaaaa", socket: "socket", terminalID: "terminal", pane: "old-pane",
    worktree: "/repo", worktreeCreated: true,
  });
  await atomicWriteJSON(path.join(jobDir, "agent-session.json"), { sessionID: "conversation" });
  const agent = { agent: "opencode", pane_id: "moved-pane", terminal_id: "terminal", workspace_id: "workspace",
    agent_status: "idle", cwd: "/repo", name: "user-label", agent_session: { agent: "opencode", kind: "id", value: "conversation" } };
  const calls = [];
  const run = async (program, args) => {
    calls.push([program, ...args]);
    if (program === "git") return { stdout: args.includes("rev-parse") ? "/repo\n" : "origin\thttps://user:secret@github.com/team/repo.git?token=secret (fetch)\n" };
    if (args[0] === "machine") return { stdout: JSON.stringify([{ id: "remote", label: "Remote", target: "ssh", session: "main", enabled: true }]) };
    return { stdout: JSON.stringify({ result: { agents: [agent] } }) };
  };
  const tool = listAgentsTool(run);
  const ctx = { abort: new AbortController().signal };
  const result = JSON.parse(await tool.execute({}, ctx));
  const owned = result.machines[0].agents[0];
  assert.equal(owned.identity, "access-review-aaaaaaaaaaaa");
  assert.equal(owned.ownership, "envoy");
  assert.equal(owned.name, "user-label");
  assert.equal(owned.paneId, "moved-pane");
  assert.deepEqual(owned.git, { root: "/repo", remotes: ["origin https://github.com/team/repo.git"] });
  assert.equal(result.machines[1].agents[0].ownership, "discovered");
  assert.equal(result.machines[1].agents[0].gitStatus, "not_inspected");
  assert.equal(calls.filter(([p]) => p === "git").length, 2);
  assert.ok(!calls.some((c) => c.includes("rename")));
  agent.agent_session.value = "replacement";
  const replaced = JSON.parse(await tool.execute({}, ctx)).machines[0].agents[0];
  assert.equal(replaced.ownership, "discovered");
  assert.notEqual(replaced.identity, owned.identity);
  agent.agent_session = null;
  assert.equal(JSON.parse(await tool.execute({}, ctx)).machines[0].agents[0].identity, null);
  const failingGit = listAgentsTool(async (program, args) => {
    if (program === "git") throw new Error("not a repository");
    return run(program, args);
  });
  assert.equal(JSON.parse(await failingGit.execute({}, ctx)).machines[0].agents[0].gitStatus, "unavailable");
  const readdir = fs.readdir;
  t.mock.method(fs, "readdir", async (...args) => {
    if (args[0] === sessionRoot()) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return readdir(...args);
  });
  await assert.rejects(tool.execute({}, ctx), /denied/);
});
