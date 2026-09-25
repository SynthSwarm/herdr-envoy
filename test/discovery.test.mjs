import assert from "node:assert/strict";
import { test } from "node:test";
import { listMachinesTool } from "../dist/discovery.js";

const profile = { id: "remote-id", label: "Remote", target: "ssh-alias", session: "dev", enabled: true };
const agent = {
  agent: "opencode", name: "reviewer", pane_id: "w1:p1", workspace_id: "w1",
  agent_status: "idle", cwd: "/repo", terminal_title: "OC | Review",
  agent_session: { agent: "opencode", kind: "id", value: "ses_one" },
};
const inventory = (agents) => ({ result: { agents } });

function fixture(t, responses) {
  const previous = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  });
  const controller = new AbortController();
  const calls = [];
  const run = async (file, args, options) => {
    assert.equal(file, "herdr");
    assert.equal(options.timeout, 15_000);
    assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    assert.equal(options.signal, controller.signal);
    calls.push(args);
    const response = responses[calls.length - 1];
    if (typeof response === "function") return response();
    if (response instanceof Error) throw response;
    return { stdout: typeof response === "string" ? response : JSON.stringify(response) };
  };
  const tool = listMachinesTool(run);
  return { controller, calls, tool, execute: () => tool.execute({}, { abort: controller.signal }) };
}

test("lists machines and only live OpenCode instances, retaining machine-scoped IDs and every state", async (t) => {
  const states = ["idle", "working", "blocked", "done", "unknown"];
  const f = fixture(t, [
    [profile, { ...profile, id: "disabled-id", enabled: false }],
    inventory([...states.map((agent_status) => ({ ...agent, agent_status })), { ...agent, agent: "hermes" }]),
    inventory([{ ...agent, cwd: "/remote/repo", name: null, agent_session: null, tokens: { secret: "omit" } }]),
  ]);
  assert.deepEqual(f.tool.args, {});
  const result = JSON.parse(await f.execute());
  assert.equal(result.error, undefined);
  assert.equal(result.machines.length, 3);
  const [local, remote, disabled] = result.machines;
  assert.equal(local.id, null);
  assert.equal(local.label, "Local");
  assert.equal(local.status, "available");
  assert.deepEqual(local.agents.map((a) => a.state), states);
  assert.deepEqual(local.agents[0], {
    paneId: "w1:p1", workspaceId: "w1", name: "reviewer", state: "idle", cwd: "/repo",
    title: "OC | Review", sessionId: "ses_one",
  });
  assert.deepEqual(remote, { ...profile, status: "available", agents: [{
    paneId: "w1:p1", workspaceId: "w1", name: null, state: "idle", cwd: "/remote/repo",
    title: "OC | Review", sessionId: null,
  }] });
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.agents, null);
  assert.deepEqual(f.calls, [["machine", "list", "--json"], ["agent", "list"], ["--machine", "remote-id", "agent", "list"]]);
});

test("handles missing optional fields and never presents another kind of session as an OpenCode conversation", async (t) => {
  const minimal = { agent: "opencode", pane_id: "p", workspace_id: "w", agent_status: "unknown" };
  const f = fixture(t, [[], inventory([
    minimal,
    { ...minimal, agent_session: { agent: "claude", kind: "id", value: "not-opencode" } },
    { ...minimal, agent_session: { agent: "opencode", kind: "path", value: "/not-an-id" } },
    { ...minimal, agent: null },
  ])]);
  const { machines: [local] } = JSON.parse(await f.execute());
  assert.equal(local.agents.length, 3);
  for (const a of local.agents) {
    assert.equal(a.name, null);
    assert.equal(a.cwd, null);
    assert.equal(a.title, null);
    assert.equal(a.sessionId, null);
  }
});

for (const failure of [new Error("ssh credential details"), "not-json", {}, inventory([{ ...agent, pane_id: "" }])]) {
  test(`failed machine query stays unknown without losing other machines: ${JSON.stringify(failure)}`, async (t) => {
    const f = fixture(t, [[profile], failure, inventory([])]);
    const { machines: [local, remote] } = JSON.parse(await f.execute());
    assert.equal(local.status, "unavailable");
    assert.equal(local.agents, null);
    assert.match(local.error, /Could not query agents/);
    assert.doesNotMatch(local.error, /credential/);
    assert.equal(remote.status, "available");
    assert.deepEqual(remote.agents, []);
  });
}

test("failed remote lookup never falls back to local agents", async (t) => {
  const f = fixture(t, [[profile], inventory([agent]), new Error("timeout")]);
  const { machines: [local, remote] } = JSON.parse(await f.execute());
  assert.equal(local.agents.length, 1);
  assert.equal(remote.status, "unavailable");
  assert.equal(remote.agents, null);
  assert.equal(f.calls.length, 3);
});

for (const failure of [new Error("missing CLI"), "not-json", {}, [{ ...profile, enabled: "yes" }]]) {
  test(`profile-list failure reports incomplete discovery but still checks Local: ${JSON.stringify(failure)}`, async (t) => {
    const f = fixture(t, [failure, inventory([])]);
    const result = JSON.parse(await f.execute());
    assert.match(result.error, /Only Local was inspected/);
    assert.equal(result.machines.length, 1);
    assert.equal(result.machines[0].status, "available");
  });
}

test("refuses discovery outside herdr without invoking commands", async (t) => {
  const f = fixture(t, []);
  delete process.env.HERDR_ENV;
  await assert.rejects(f.execute(), /HERDR_ENV=1/);
  assert.deepEqual(f.calls, []);
});

for (const stage of ["profiles", "agents", "between"]) {
  test(`cancellation propagates during ${stage} instead of returning a misleading inventory`, async (t) => {
    const abort = () => { f.controller.abort(); throw f.controller.signal.reason; };
    const responses = stage === "profiles" ? [abort] : stage === "agents" ? [[], abort] : [() => {
      f.controller.abort();
      return { stdout: "[]" };
    }];
    const f = fixture(t, responses);
    await assert.rejects(f.execute(), { name: "AbortError" });
  });
}
