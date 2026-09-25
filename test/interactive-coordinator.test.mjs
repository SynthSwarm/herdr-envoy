import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { tool } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk";
import {
  Coordinator, delegateTool, openSessionTool, listSessionsTool, resumeSessionTool, reapTool,
} from "../dist/coordinator.js";
import { consume, readTaskTool, handBackTool } from "../dist/delegate.js";
import { atomicWriteJSON, readJSON, FILES, JOBDIR_ENV, root, sessionRoot, withSessionLock } from "../dist/protocol.js";

const exec = promisify(execFile);
const owner = { sessionID: "orchestrator" };

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-interactive-coordinator-"));
  const keys = ["XDG_RUNTIME_DIR", "XDG_STATE_HOME", "HERDR_PANE_ID"];
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const coordinators = [];
  t.after(async () => {
    try {
      for (const coordinator of coordinators) await coordinator.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    } finally {
      for (const key of keys) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
    }
  });
  process.env.XDG_RUNTIME_DIR = path.join(dir, "runtime");
  process.env.XDG_STATE_HOME = path.join(dir, "state");
  process.env.HERDR_PANE_ID = "coordinator-pane";
  const repo = path.join(dir, "repo with spaces");
  await fs.mkdir(repo);
  const git = (...args) => exec("git", ["-C", repo, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  });
  await exec("git", ["init", "-q", "--initial-branch=main", repo]);
  await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
  await git("add", "tracked.txt");
  await git("commit", "-q", "-m", "base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  const calls = [];
  const panes = new Map([["coordinator-pane", { pane_id: "coordinator-pane", workspace_id: "parent" }]]);
  const workspaces = new Map([["parent", { workspace_id: "parent" }], ["unrelated", { workspace_id: "unrelated" }]]);
  const sources = new Map([["parent", { repo_root: repo, source_checkout_path: repo, source_workspace_id: "parent" }]]);
  const options = {
    failPrompt: false, failRun: false, failOpen: false, failClose: false,
    failCreateAfterSideEffect: false, failRename: false,
    onPrompt: undefined, onPost: undefined, onCreate: undefined,
    paneList: undefined, workspaceList: undefined, alreadyOpen: false,
    worktreeList: undefined, parentList: undefined, failGitInventory: false,
    busy: false, loseResponse: false, receiptParts: undefined,
    promptStatus: 204, readbackStatus: undefined,
  };
  let nextPane = 0;
  let nextWorkspace = 0;
  const addPane = (workspace_id) => {
    const pane = { pane_id: `worker-pane-${++nextPane}`, workspace_id };
    panes.set(pane.pane_id, pane);
    return pane;
  };
  const closeWorkspace = (id) => {
    workspaces.delete(id);
    for (const [paneID, pane] of panes) if (pane.workspace_id === id) panes.delete(paneID);
  };
  const shell = (strings, ...values) => {
    const words = [];
    strings.forEach((literal, i) => {
      words.push(...literal.trim().split(/\s+/).filter(Boolean));
      if (i < values.length) words.push(...(Array.isArray(values[i]) ? values[i] : [String(values[i])]));
    });
    let cwd;
    let promise;
    const run = () => promise ??= (async () => {
      calls.push(words);
      const [program, resource, action, id] = words;
      const json = (result) => ({ stdout: JSON.stringify({ result }) });
      const flag = (name) => words[words.indexOf(name) + 1];
      if (program === "git") {
        if (options.failGitInventory && words.includes("--porcelain")) throw new Error("git inventory unavailable");
        return exec(program, words.slice(1), { cwd });
      }
      if (program === "opencode") {
        assert.deepEqual(words, ["opencode", "agent", "list"]);
        assert.equal(cwd, repo);
        return { stdout: "worker (primary)\n" };
      }
      assert.equal(program, "herdr", `Unexpected command: ${words.join(" ")}`);
      if (resource === "pane" && action === "get") {
        assert.ok(panes.has(id), `Missing pane ${id}`);
        return json({ pane: panes.get(id) });
      }
      if (resource === "pane" && action === "list") return json(options.paneList ?? { panes: [...panes.values()] });
      if (resource === "pane" && action === "layout") return json({ layout: { panes: [] } });
      if (resource === "pane" && action === "split") {
        assert.ok(panes.has(id), `Missing split target ${id}`);
        await git("-C", flag("--cwd"), "rev-parse", "--show-toplevel");
        return json({ pane: addPane(panes.get(id).workspace_id) });
      }
      if (resource === "pane" && action === "close") {
        if (options.failClose) throw new Error("pane close failed");
        assert.ok(panes.delete(id), `Missing pane ${id}`);
        return json({});
      }
      if (resource === "workspace" && action === "get") {
        if (!workspaces.has(id)) throw new Error(`Missing parent workspace ${id}`);
        return json({ workspace: workspaces.get(id) });
      }
      if (resource === "workspace" && action === "list") return json(options.workspaceList ?? { workspaces: [...workspaces.values()] });
      if (resource === "workspace" && action === "close") {
        if (options.failClose) throw new Error("workspace close failed");
        assert.ok(workspaces.has(id), `Missing workspace ${id}`);
        closeWorkspace(id);
        return json({});
      }
      if (resource === "worktree" && action === "list") {
        const override = words.includes("--workspace") ? options.parentList : options.worktreeList;
        if (override !== undefined) return json(override);
        const repoRoot = words.includes("--cwd")
          ? (await git("-C", flag("--cwd"), "rev-parse", "--show-toplevel")).stdout.trim()
          : sources.get(flag("--workspace"))?.repo_root;
        const source = words.includes("--workspace") ? sources.get(flag("--workspace"))
          : [...sources.values()].find((entry) => entry.repo_root === repoRoot && workspaces.has(entry.source_workspace_id));
        const inventory = (await git("-C", repoRoot, "worktree", "list", "--porcelain", "-z")).stdout;
        const worktrees = inventory.split("\0\0").filter(Boolean).map((record) => {
          const fields = record.split("\0");
          return { path: fields.find((field) => field.startsWith("worktree ")).slice(9),
            branch: fields.find((field) => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) };
        });
        return json({ source: source ?? { repo_root: repoRoot }, worktrees });
      }
      if (resource === "worktree" && ["create", "open"].includes(action)) {
        assert.ok(workspaces.has(flag("--workspace")), "parent must exist");
        const checkout = flag("--path");
        if (action === "create") {
          await options.onCreate?.(words);
          await git("-C", sources.get(flag("--workspace")).repo_root, "worktree", "add", "--quiet", "-b", flag("--branch"), checkout, flag("--base"));
        }
        else {
          if (options.failOpen) throw new Error("worktree open failed");
          assert.equal((await git("-C", checkout, "rev-parse", "--show-toplevel")).stdout.trim(), checkout);
        }
        const existing = [...workspaces.values()].find((workspace) => workspace.path === checkout);
        if (existing) return json({ workspace: existing, root_pane: [...panes.values()].find((pane) => pane.workspace_id === existing.workspace_id), worktree: { path: checkout }, already_open: true });
        const workspace = { workspace_id: `child-${++nextWorkspace}`, parent_workspace_id: flag("--workspace"), path: checkout, worktree: { checkout_path: checkout } };
        workspaces.set(workspace.workspace_id, workspace);
        const root_pane = addPane(workspace.workspace_id);
        if (action === "create" && options.failCreateAfterSideEffect) throw new Error("worktree create response lost after creation");
        return json({ workspace, root_pane, worktree: { path: checkout }, already_open: options.alreadyOpen });
      }
      if (resource === "agent" && action === "prompt") {
        assert.ok(panes.has(id));
        await options.onPrompt?.(words);
        if (options.failPrompt) throw new Error("agent prompt failed");
        return json({});
      }
      if (resource === "wait" && action === "output") {
        assert.ok(panes.has(id));
        return json({});
      }
      if (resource === "pane" && ["run", "rename"].includes(action)) {
        assert.ok(panes.has(id));
        if (action === "run" && options.failRun) throw new Error("pane run failed");
        if (action === "rename" && options.failRename) throw new Error("pane rename failed");
        return json({});
      }
      assert.fail(`Unimplemented herdr command: ${words.join(" ")}`);
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
  const conversations = new Map();
  const messages = new Map();
  const posts = [];
  const gets = [];
  const sdk = createOpencodeClient({ baseUrl: "http://envoy.invalid", fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/session/status") return Response.json(options.busy ? { [owner.sessionID]: { type: "busy" } } : {});
    if (/^\/session\/[^/]+$/.test(url.pathname)) {
      gets.push({ path: url.pathname, directory: url.searchParams.get("directory") });
      const conversation = conversations.get(decodeURIComponent(url.pathname.split("/").at(-1)));
      return Response.json(conversation ?? { error: "conversation missing" }, { status: conversation ? 200 : 404 });
    }
    if (url.pathname.endsWith("/prompt_async")) {
      const body = await request.json();
      posts.push({ path: url.pathname, ...body });
      await options.onPost?.(body);
      if (options.promptStatus !== 204) return Response.json({ error: "notification unavailable" }, { status: options.promptStatus });
      messages.set(body.messageID, { parts: options.receiptParts ?? body.parts });
      if (options.loseResponse) throw new Error("lost accepted response");
      return new Response(null, { status: 204 });
    }
    assert.match(url.pathname, /^\/session\/[^/]+\/message\/[^/]+$/);
    if (options.readbackStatus) return Response.json({ error: "read-back unavailable" }, { status: options.readbackStatus });
    const message = messages.get(url.pathname.split("/").at(-1));
    return Response.json(message ?? { error: "message missing" }, { status: message ? 200 : 404 });
  } });
  const coordinator = (directory = repo) => {
    const c = new Coordinator(shell, { session: sdk.session, tui: { showToast: async () => ({}) } }, directory);
    coordinators.push(c);
    return c;
  };
  const c = coordinator();
  const metadata = (job) => readJSON(path.join(job.jobDir, FILES.coordinator));
  const state = (job) => readJSON(path.join(job.jobDir, FILES.session));
  const logs = async () => {
    const directory = path.join(process.env.XDG_STATE_HOME, "herdr-envoy", "logs");
    const files = await fs.readdir(directory);
    return (await Promise.all(files.filter((file) => file.endsWith(".jsonl")).sort().map(async (file) =>
      (await fs.readFile(path.join(directory, file), "utf8")).trim().split("\n").map((line) => JSON.parse(line))))).flat();
  };
  // A watch scan may already be reading the preceding state. Join it, then scan fresh.
  const settle = async (job, coord = c) => { await coord.reconcile(job.jobId); await coord.reconcile(job.jobId); };
  let sequence = 0;
  const open = async (overrides = {}, context = owner, coord = c) => {
    const number = ++sequence;
    const args = { agent: "worker", name: `session-${number}`, task: "Work with the user", repo, branch: `interactive/test-${number}`, baseCommit: base, ...overrides };
    const output = await openSessionTool(coord).execute(args, context);
    const jobId = /\(([a-f0-9]{32})\)/.exec(output)?.[1];
    assert.ok(jobId, output);
    const job = { jobId, jobDir: path.join(sessionRoot(), jobId), output, args };
    Object.assign(job, await metadata(job));
    await settle(job, coord);
    return job;
  };
  const bind = async (job) => {
    const context = { sessionID: `saved-${job.jobId}` };
    const delegate = await consume(job.jobDir);
    await readTaskTool(delegate).execute({}, context);
    conversations.set(context.sessionID, { id: context.sessionID, directory: job.worktree });
    Object.assign(panes.get(job.pane), { agent: "opencode", agent_session: { value: context.sessionID }, agent_status: "idle" });
    return { delegate, context };
  };
  const handBack = async (job, disposition = "pause") => {
    const { delegate, context } = await bind(job);
    await handBackTool(delegate).execute({ disposition, summary: "User work is ready", checks: ["manual check passed"], risks: ["needs review"], userInstruction: `Please ${disposition} this work.` }, context);
    await settle(job);
    return state(job);
  };
  return { dir, repo, base, git, c, coordinator, calls, panes, workspaces, sources, closeWorkspace, options,
    conversations, messages, posts, gets, metadata, state, logs, settle, open, bind, handBack };
}

test("open_session defaults to pane placement and persists an interactive handoff in the durable root", async (t) => {
  const f = await fixture(t);
  await f.git("commit", "-q", "--allow-empty", "-m", "new main head");
  const job = await f.open({ name: "User's session", task: "Keep this task off the command line" });
  assert.equal(job.mode, "interactive");
  assert.equal(job.phase, "running");
  assert.equal(job.placement, "pane");
  assert.equal(job.sessionID, owner.sessionID);
  assert.equal(job.worktreeCreated, true);
  assert.equal(job.branchCreated, true);
  assert.equal(job.jobDir, path.join(process.env.XDG_STATE_HOME, "herdr-envoy", "sessions", job.jobId));
  await assert.rejects(fs.access(path.join(root(), job.jobId)), { code: "ENOENT" });
  assert.equal((await f.git("-C", job.worktree, "rev-parse", "HEAD")).stdout.trim(), f.base);
  assert.equal((await f.git("-C", job.worktree, "branch", "--show-current")).stdout.trim(), job.branch);
  const handoff = await readJSON(path.join(job.jobDir, FILES.handoff));
  assert.equal(handoff.mode, "interactive");
  assert.equal(handoff.outputContract, "code-change");
  assert.equal(handoff.task, job.args.task);
  assert.equal((await f.state(job)).status, "active");
  assert.deepEqual((await f.metadata(job)).delivered, []);
  if (process.platform !== "win32") assert.equal((await fs.stat(job.jobDir)).mode & 0o777, 0o700);
  const split = f.calls.find((args) => args[2] === "split");
  assert.deepEqual(split, ["herdr", "pane", "split", "coordinator-pane", "--direction", "right", "--ratio", "0.5", "--cwd", job.worktree, "--no-focus", "--env", `${JOBDIR_ENV}=${job.jobDir}`]);
  const launch = f.calls.find((args) => args[2] === "run");
  assert.ok(launch[4].startsWith(`env ${JOBDIR_ENV}='${job.jobDir}' opencode --agent 'worker' --auto`));
  assert.match(launch[4], /read_task.*Work interactively.*hand_back only on explicit user instruction/);
  assert.doesNotMatch(launch[4], /--session|Keep this task|Call `complete`/);
  assert.deepEqual(f.calls.find((args) => args[2] === "rename"), ["herdr", "pane", "rename", job.pane, job.name]);
  const schema = tool.schema.object(openSessionTool(f.c).args);
  assert.equal(schema.parse(job.args).placement, "pane");
  assert.equal(schema.safeParse({ ...job.args, placement: "window" }).success, false);
});

test("durable recovery survives a changed pane and runtime loss but lists only the same directory and orchestrator", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  const other = await f.open({}, { sessionID: "other-orchestrator" });
  const bounded = await f.c.createJob({ agent: "worker", task: "bounded", repo: f.repo, branch: "bounded/test", outputContract: "advisory", sessionID: owner.sessionID });
  await fs.writeFile(path.join(job.worktree, "draft.txt"), "keep this dirty work\n");
  const paused = await f.handBack(job);
  await f.c.dispose();
  await fs.rm(root(), { recursive: true, force: true });
  process.env.HERDR_PANE_ID = "replacement-coordinator-pane";
  const recovered = f.coordinator();
  await recovered.recover();
  await f.settle(job, recovered);
  const listed = JSON.parse(await listSessionsTool(recovered).execute({}, owner));
  assert.deepEqual(listed, [{ jobId: job.jobId, name: job.name, status: "paused", phase: "running", placement: "pane", worktree: job.worktree, branch: job.branch, pane: job.pane, sessionID: paused.sessionID, summary: paused.summary,
    generation: paused.generation, checks: paused.checks, risks: paused.risks, notificationPending: false }]);
  assert.equal(recovered.resolveJobId(other.jobId, owner.sessionID), undefined);
  assert.equal(recovered.resolveJobId(bounded.jobId), undefined);
  assert.equal(JSON.parse(await recovered.listSessions("other-orchestrator"))[0].jobId, other.jobId);
  assert.deepEqual(JSON.parse(await recovered.listSessions("unknown-orchestrator")), []);
  assert.equal(await fs.readFile(path.join(job.worktree, "draft.txt"), "utf8"), "keep this dirty work\n");
  assert.equal((await f.git("rev-parse", job.branch)).stdout.trim(), f.base);
  assert.equal(f.posts.length, 1, "an acknowledged hand-back is not sent again after recovery");
  const elsewhere = f.coordinator(path.join(f.repo, "another-directory"));
  await elsewhere.recover();
  assert.deepEqual(JSON.parse(await elsewhere.listSessions(owner.sessionID)), []);
});

test("pause delivers once with no commit, merge or cleanup and refuses even explicitly forced reap", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  await fs.writeFile(path.join(job.worktree, "tracked.txt"), "changed\n");
  const start = f.calls.length;
  const state = await f.handBack(job);
  await f.settle(job);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].path, `/session/${owner.sessionID}/prompt_async`);
  const text = f.posts[0].parts[0].text;
  assert.match(text, /PAUSED.*Do not commit, merge or reap.*resume_session/);
  for (const value of [job.name, job.worktree, job.branch, state.summary, ...state.checks, ...state.risks, state.userInstruction]) assert.ok(text.includes(value));
  assert.doesNotMatch(text, new RegExp(state.completionToken));
  assert.deepEqual((await f.metadata(job)).delivered, [`handback:${state.handbackID}`]);
  for (const options of [{}, { deleteBranch: true }, { discard: true, confirmation: job.jobId, deleteBranch: true }]) {
    await assert.rejects(f.c.reap(job.jobId, options), /Active or paused sessions must be handed back/);
  }
  assert.deepEqual(f.calls.slice(start), [], "pause and refused cleanup issue no shell commands");
  assert.equal(f.panes.has(job.pane), true);
  assert.equal((await f.metadata(job)).phase, "running");
  assert.equal(await fs.readFile(path.join(job.worktree, "tracked.txt"), "utf8"), "changed\n");
});

test("commit hand-back does not commit automatically and reap preserves dirty work until the user commits", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  await fs.writeFile(path.join(job.worktree, "tracked.txt"), "changed\n");
  await fs.writeFile(path.join(job.worktree, "new.txt"), "untracked\n");
  const start = f.calls.length;
  await f.handBack(job, "commit");
  assert.match(f.posts[0].parts[0].text, /READY FOR COMMIT.*commit in the worktree BEFORE reap_delegate.*No merge or push/);
  assert.deepEqual(f.calls.slice(start), []);
  assert.equal((await f.git("rev-parse", job.branch)).stdout.trim(), f.base);
  await assert.rejects(f.c.reap(job.jobId, { discard: true, confirmation: job.jobId }), /has not requested discard/);
  await assert.rejects(f.c.reap(job.jobId), /modified or untracked files/);
  assert.equal(await fs.readFile(path.join(job.worktree, "new.txt"), "utf8"), "untracked\n");
  assert.equal(await fs.readFile(path.join(job.worktree, "tracked.txt"), "utf8"), "changed\n");
  assert.equal(f.c.resolveJobId(job.jobId), job.jobId);
  assert.equal((await f.metadata(job)).phase, "cleanup");
  await f.git("-C", job.worktree, "add", ".");
  await assert.rejects(f.c.reap(job.jobId), /modified or untracked files/);
  await f.git("-C", job.worktree, "commit", "-q", "-m", "User-approved change");
  const head = (await f.git("rev-parse", job.branch)).stdout.trim();
  await f.c.reap(job.jobId);
  await assert.rejects(fs.access(job.worktree), { code: "ENOENT" });
  await assert.rejects(fs.access(job.jobDir), { code: "ENOENT" });
  assert.equal((await f.git("rev-parse", job.branch)).stdout.trim(), head);
  assert.equal((await f.git("rev-parse", "main")).stdout.trim(), f.base);
  assert.ok(f.calls.filter((args) => args.includes("remove")).every((args) => !args.includes("--force")));
  assert.equal(f.calls.filter((args) => args[2] === "close").length, 1);
});

test("discard requires the exact full confirmation and deletes only the owned checkout, branch and child workspace", async (t) => {
  const f = await fixture(t);
  const job = await f.open({ placement: "subworkspace" });
  const other = await f.open({ placement: "subworkspace" }, { sessionID: "other-orchestrator" });
  await f.git("-C", job.worktree, "commit", "-q", "--allow-empty", "-m", "unwanted commit");
  await fs.writeFile(path.join(job.worktree, "discard.txt"), "discard only with approval");
  await fs.writeFile(path.join(other.worktree, "keep.txt"), "untouched");
  await f.handBack(job, "discard");
  assert.ok(f.posts[0].parts[0].text.includes(`confirmation=${job.jobId}`));
  assert.match(f.posts[0].parts[0].text, /DISCARD REQUESTED.*Ask the user to confirm/);
  const start = f.calls.length;
  for (const options of [{}, { discard: true }, { discard: false, confirmation: job.jobId }, { discard: true, confirmation: job.jobId.slice(0, 8) }, { discard: true, confirmation: other.jobId }]) {
    await assert.rejects(f.c.reap(job.jobId, options), /Confirm destructive discard/);
  }
  assert.match(await reapTool(f.c).execute({ jobId: job.jobId, discard: true, confirmation: job.jobId }, { sessionID: "other-orchestrator" }), /No tracked job/);
  assert.deepEqual(f.calls.slice(start), []);
  assert.equal(await fs.readFile(path.join(job.worktree, "discard.txt"), "utf8"), "discard only with approval");
  assert.match(await reapTool(f.c).execute({ jobId: job.jobId.slice(0, 8), discard: true, confirmation: job.jobId, deleteBranch: true }, owner), /Reaped job/);
  await assert.rejects(fs.access(job.worktree), { code: "ENOENT" });
  await assert.rejects(fs.access(job.jobDir), { code: "ENOENT" });
  await assert.rejects(f.git("show-ref", "--verify", `refs/heads/${job.branch}`));
  assert.equal(await fs.readFile(path.join(other.worktree, "keep.txt"), "utf8"), "untouched");
  await f.git("show-ref", "--verify", `refs/heads/${other.branch}`);
  assert.equal(f.workspaces.has(other.workspace), true);
  assert.equal(f.workspaces.has("parent"), true);
  assert.equal(f.workspaces.has("unrelated"), true);
  assert.equal(f.panes.has("coordinator-pane"), true);
  assert.deepEqual(f.calls.filter((args) => args[2] === "close"), [["herdr", "workspace", "close", job.workspace]]);
  assert.ok(f.calls.some((args) => args.includes("remove") && args.includes("--force") && args.at(-1) === job.worktree));
  assert.ok(f.calls.some((args) => args.includes("-D") && args.at(-1) === job.branch));
});

test("resume uses the exact live pane conversation, deduplicates concurrent calls and refreshes generation", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  const paused = await f.handBack(job);
  await fs.writeFile(path.join(job.worktree, "draft.txt"), "continue this");
  const start = f.calls.length;
  const resume = resumeSessionTool(f.c);
  await assert.rejects(resume.execute({ jobId: job.jobId }, { sessionID: "other" }), /owned by this orchestrator/);
  await assert.rejects(resume.execute({ jobId: job.jobId.slice(0, 7) }, owner), /uniquely matching/);
  const results = await Promise.all(Array.from({ length: 4 }, () => resume.execute({ jobId: job.jobId.slice(0, 8), instructions: "Continue the user's draft" }, owner)));
  assert.ok(results.every((result) => result === results[0]));
  assert.match(results[0], /Resumed/);
  const active = await f.state(job);
  assert.equal(active.status, "active");
  assert.equal(active.generation, paused.generation + 1);
  assert.equal(active.sessionID, paused.sessionID);
  assert.deepEqual(f.gets, [{ path: `/session/${paused.sessionID}`, directory: job.worktree }]);
  const prompts = f.calls.slice(start).filter((args) => args[1] === "agent");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][3], job.pane);
  assert.match(prompts[0][4], /Call read_task to refresh control.*Continue the user's draft/);
  assert.ok(!f.calls.slice(start).some((args) => ["split", "run", "create", "open"].includes(args[2])));
  assert.equal((await f.metadata(job)).pane, job.pane);
  assert.equal(await fs.readFile(path.join(job.worktree, "draft.txt"), "utf8"), "continue this");
  await assert.rejects(resume.execute({ jobId: job.jobId }, owner), /Only paused/);
});

test("resume without a jobId selects exactly one owned paused session and refuses zero or multiple", async (t) => {
  const f = await fixture(t);
  const resume = resumeSessionTool(f.c);
  assert.deepEqual(tool.schema.object(resume.args).parse({}), {});
  const active = await f.open();
  const other = await f.open({}, { sessionID: "other-orchestrator" });
  await f.handBack(other);
  const start = f.calls.length;
  await assert.rejects(resume.execute({}, owner), /expected exactly one paused session/);
  assert.deepEqual(f.calls.slice(start), []);
  const paused = await f.handBack(active);
  assert.match(await resume.execute({ instructions: "Continue the only paused session" }, owner), new RegExp(active.jobId));
  assert.equal((await f.state(active)).sessionID, paused.sessionID);
  assert.equal((await f.state(active)).status, "active");
  assert.equal((await f.state(other)).status, "paused");
  const prompt = f.calls.slice(start).filter((args) => args[2] === "prompt");
  assert.equal(prompt.length, 1);
  assert.equal(prompt[0][3], active.pane);
  assert.match(prompt[0][4], /Continue the only paused session/);
  await assert.rejects(resume.execute({}, owner), /expected exactly one paused session/);
  const first = await f.handBack(active);
  const second = await f.open();
  const secondPaused = await f.handBack(second);
  const beforeRefusal = f.calls.length;
  await assert.rejects(resume.execute({}, owner), /expected exactly one paused session/);
  assert.deepEqual(f.calls.slice(beforeRefusal), []);
  assert.deepEqual(await f.state(active), first);
  assert.deepEqual(await f.state(second), secondPaused);
});

test("a stale paused-to-commit hand-back waits for resume's shared lock and cannot overwrite the active generation", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  const paused = await f.handBack(job);
  const { delegate, context } = await f.bind(job);
  const lock = path.join(sessionRoot(), ".locks", job.jobId);
  let contended = () => {};
  const realOpen = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args) => {
    try { return await realOpen(...args); }
    catch (error) {
      if (args[0] === lock && error.code === "EEXIST") contended();
      throw error;
    }
  });
  let publication;
  f.options.onPrompt = async () => {
    assert.equal(await fs.readFile(lock, "utf8"), String(process.pid));
    await assert.rejects(withSessionLock(job.jobId, async () => assert.fail("shared lock was not held")), /being updated by another coordinator/);
    // Observe this peer's contention, not the explicit lock probe above.
    let peerContended;
    const peerContention = new Promise((resolve) => { peerContended = resolve; });
    contended = peerContended;
    publication = handBackTool(delegate).execute({ disposition: "commit", summary: "Stale commit request", userInstruction: "Hand back the paused work for commit" }, context)
      .then((value) => ({ value }), (error) => ({ error }));
    await Promise.race([peerContention, publication.then(() => assert.fail("hand-back completed without waiting for resume's lock"))]);
    const active = await f.state(job);
    assert.equal(active.status, "active");
    assert.equal(active.generation, paused.generation + 1);
    assert.equal(active.handbackID, undefined);
  };
  await f.c.resumeSession(job.jobId, "Continue with new work");
  assert.ok(publication);
  const result = await publication;
  assert.match(result.error?.message ?? "", /generation changed; reread read_task/);
  const active = await f.state(job);
  assert.equal(active.status, "active");
  assert.equal(active.generation, paused.generation + 1);
  assert.equal(active.summary, paused.summary);
  assert.equal(active.handbackID, undefined);
  await f.settle(job);
  assert.equal(f.posts.length, 1);
  assert.deepEqual((await f.metadata(job)).delivered, [`handback:${paused.handbackID}`]);
});

test("a paused-to-commit publication holds the shared lock until durable, then resume uses that hand-back", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  const paused = await f.handBack(job);
  const { delegate, context } = await f.bind(job);
  await f.c.dispose();
  let arrived;
  let release;
  const publishing = new Promise((resolve) => { arrived = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const realRename = fs.rename.bind(fs);
  const rename = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === path.join(job.jobDir, FILES.session)) {
      arrived();
      await barrier;
    }
    return realRename(source, destination);
  });
  const publication = handBackTool(delegate).execute({ disposition: "commit", summary: "Final paused work", userInstruction: "Hand back for commit" }, context)
    .then((value) => ({ value }), (error) => ({ error }));
  try {
    await Promise.race([publishing, publication.then(() => assert.fail("hand-back did not reach the publication barrier"))]);
    await assert.rejects(f.c.resumeSession(job.jobId), /being updated by another coordinator/);
    assert.deepEqual(await f.state(job), paused);
    assert.equal(f.calls.filter((args) => args[2] === "prompt").length, 0);
  } finally {
    release();
    await publication;
    rename.mock.restore();
  }
  assert.ifError((await publication).error);
  const ready = await f.state(job);
  assert.equal(ready.status, "commit");
  assert.equal(ready.generation, paused.generation);
  assert.notEqual(ready.handbackID, paused.handbackID);
  assert.match(await f.c.resumeSession(job.jobId), /Previous hand-back \(commit, generation \d+\): Final paused work/);
  const active = await f.state(job);
  assert.equal(active.status, "active");
  assert.equal(active.generation, paused.generation + 1);
  assert.equal(active.summary, ready.summary);
  assert.equal(active.handbackID, undefined);
});

test("failure on resume's second metadata save preserves durable intent and the pending notice for recovery", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  f.options.busy = true;
  const paused = await f.handBack(job);
  const previous = await f.metadata(job);
  await f.c.dispose();
  const realRename = fs.rename.bind(fs);
  let saves = 0;
  const rename = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === path.join(job.jobDir, FILES.coordinator) && ++saves === 2) {
      throw new Error("second metadata save failed");
    }
    return realRename(source, destination);
  });
  await assert.rejects(f.c.resumeSession(job.jobId, "Recover this resume"), /second metadata save failed/);
  rename.mock.restore();
  assert.equal(saves, 2);
  assert.deepEqual(await f.state(job), paused);
  const interrupted = await f.metadata(job);
  assert.deepEqual(interrupted.resuming, { generation: paused.generation + 1, instructions: "Recover this resume" });
  assert.deepEqual(interrupted.pending, previous.pending);
  assert.deepEqual(interrupted.delivered, []);
  assert.equal(f.calls.filter((args) => args[2] === "prompt").length, 0);
  const recovered = f.coordinator();
  await recovered.recover();
  await f.settle(job, recovered);
  assert.deepEqual(await f.metadata(job), interrupted, "busy reconciliation must preserve recoverable intent and pending delivery");
  assert.equal(f.posts.length, 0);
  await recovered.resumeSession(job.jobId, "Recover this resume");
  const active = await f.state(job);
  assert.equal(active.status, "active");
  assert.equal(active.generation, interrupted.resuming.generation);
  assert.equal(active.handbackID, undefined);
  assert.equal((await f.metadata(job)).resuming, undefined);
  assert.equal((await f.metadata(job)).pending, undefined);
  assert.deepEqual((await f.metadata(job)).delivered, [`handback:${paused.handbackID}`]);
  f.options.busy = false;
  await f.settle(job, recovered);
  assert.equal(f.posts.length, 0, "explicit retry must retire the old pause rather than replay it");
  assert.equal(f.calls.filter((args) => args[2] === "prompt").length, 1);
});

test("a closed pane relaunches the saved conversation with --session without recreating its dirty checkout", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  const paused = await f.handBack(job);
  await fs.writeFile(path.join(job.worktree, "draft.txt"), "dirty saved work");
  f.panes.delete(job.pane);
  const start = f.calls.length;
  await f.c.resumeSession(job.jobId);
  const metadata = await f.metadata(job);
  assert.notEqual(metadata.pane, job.pane);
  assert.equal(metadata.worktree, job.worktree);
  assert.equal(metadata.branch, job.branch);
  const commands = f.calls.slice(start);
  assert.equal(commands.filter((args) => args[2] === "split").length, 1);
  const launch = commands.find((args) => args[2] === "run");
  assert.equal(launch[3], metadata.pane);
  assert.ok(launch[4].includes(`--session '${paused.sessionID}'`));
  assert.match(launch[4], /Wait for the.*next instruction/);
  assert.ok(launch[4].includes(`${JOBDIR_ENV}='${job.jobDir}'`));
  assert.ok(!commands.some((args) => args.includes("add") || args[2] === "create"));
  assert.equal(await fs.readFile(path.join(job.worktree, "draft.txt"), "utf8"), "dirty saved work");
  assert.equal((await f.git("rev-parse", job.branch)).stdout.trim(), f.base);
});

for (const [label, override] of [
  ["different conversation", { agent_session: { value: "another-session" } }],
  ["missing conversation", { agent_session: undefined }],
  ["different agent", { agent: "other-agent" }],
  ["working agent", { agent_status: "working" }],
]) {
  test(`resume refuses a live pane with ${label} without changing paused control`, async (t) => {
    const f = await fixture(t);
    const job = await f.open();
    f.options.busy = true;
    const paused = await f.handBack(job);
    const metadata = await f.metadata(job);
    assert.equal(metadata.pending.key, `handback:${paused.handbackID}`);
    Object.assign(f.panes.get(job.pane), override);
    const start = f.calls.length;
    await assert.rejects(f.c.resumeSession(job.jobId), /busy or its conversation identity cannot be verified/);
    assert.deepEqual(await f.state(job), paused);
    assert.deepEqual(await f.metadata(job), metadata, "failed validation must not retire the pending notice");
    assert.equal(f.posts.length, 0);
    assert.ok(!f.calls.slice(start).some((args) => ["prompt", "split", "run", "close"].includes(args[2])));
    await fs.access(job.worktree);
  });
}

test("subworkspace create and reopen retain the original parent and own only the returned child", async (t) => {
  const f = await fixture(t);
  const job = await f.open({ placement: "subworkspace", name: "child session" });
  assert.equal(job.parentWorkspace, "parent");
  assert.equal(f.workspaces.get(job.workspace).parent_workspace_id, "parent");
  assert.deepEqual(f.calls.find((args) => args[2] === "create"), ["herdr", "worktree", "create", "--workspace", "parent", "--branch", job.branch, "--base", f.base, "--path", job.worktree, "--label", job.name, "--no-focus", "--json"]);
  assert.equal(f.calls.some((args) => args[2] === "split"), false);
  assert.equal((await f.git("-C", job.worktree, "branch", "--show-current")).stdout.trim(), job.branch);
  const paused = await f.handBack(job);
  await fs.writeFile(path.join(job.worktree, "draft.txt"), "preserved across close");
  f.closeWorkspace(job.workspace);
  process.env.HERDR_PANE_ID = "new-parent-pane";
  f.panes.set("new-parent-pane", { pane_id: "new-parent-pane", workspace_id: "unrelated" });
  await f.c.dispose();
  const recovered = f.coordinator();
  await recovered.recover();
  await f.settle(job, recovered);
  const start = f.calls.length;
  await recovered.resumeSession(job.jobId, "Continue here");
  const metadata = await f.metadata(job);
  assert.notEqual(metadata.workspace, job.workspace);
  assert.notEqual(metadata.pane, job.pane);
  assert.equal(metadata.parentWorkspace, "parent");
  assert.deepEqual(f.calls.slice(start).find((args) => args[2] === "open"), ["herdr", "worktree", "open", "--workspace", "parent", "--path", job.worktree, "--no-focus", "--json"]);
  assert.ok(f.calls.slice(start).find((args) => args[2] === "run")[4].includes(`--session '${paused.sessionID}'`));
  assert.ok(!f.calls.slice(start).some((args) => ["create", "split"].includes(args[2])));
  assert.equal(await fs.readFile(path.join(job.worktree, "draft.txt"), "utf8"), "preserved across close");
  const delegate = await consume(job.jobDir);
  await readTaskTool(delegate).execute({}, { sessionID: paused.sessionID });
  await handBackTool(delegate).execute({ disposition: "commit", summary: "ready", userInstruction: "Hand back for commit" }, { sessionID: paused.sessionID });
  await f.settle(job, recovered);
  await assert.rejects(recovered.reap(job.jobId), /modified or untracked files/);
  assert.equal(f.workspaces.has(metadata.workspace), false);
  assert.equal(f.workspaces.has("parent"), true);
  assert.equal(f.workspaces.has("unrelated"), true);
  await f.git("-C", job.worktree, "add", "draft.txt");
  await f.git("-C", job.worktree, "commit", "-q", "-m", "approved");
  await recovered.reap(job.jobId);
  assert.deepEqual(f.calls.filter((args) => args[2] === "close"), [["herdr", "workspace", "close", metadata.workspace]]);
});

test("subworkspace placement uses the target repository's parent rather than the caller's workspace", async (t) => {
  const f = await fixture(t);
  const callerRepo = path.join(f.dir, "caller repo");
  await f.git("init", "-q", "--initial-branch=main", callerRepo);
  await f.git("-C", callerRepo, "commit", "-q", "--allow-empty", "-m", "caller base");
  f.sources.set("unrelated", { repo_root: callerRepo, source_checkout_path: callerRepo, source_workspace_id: "unrelated" });
  f.panes.get("coordinator-pane").workspace_id = "unrelated";
  const caller = f.coordinator(callerRepo);
  const job = await f.open({ placement: "subworkspace" }, owner, caller);
  assert.equal(job.parentWorkspace, "parent");
  assert.equal(f.workspaces.get(job.workspace).parent_workspace_id, "parent");
  assert.deepEqual(f.calls.filter((args) => args[1] === "worktree" && args[2] === "list"), [
    ["herdr", "worktree", "list", "--cwd", f.repo, "--json"],
    ["herdr", "worktree", "list", "--workspace", "parent", "--json"],
  ]);
  assert.equal((await f.git("-C", job.worktree, "rev-parse", "HEAD")).stdout.trim(), f.base);
  await f.git("show-ref", "--verify", `refs/heads/${job.branch}`);
  await assert.rejects(f.git("-C", callerRepo, "show-ref", "--verify", `refs/heads/${job.branch}`));
  assert.ok(!f.calls.some((args) => args[1] === "pane" && ["get", "split"].includes(args[2])));
});

test("subworkspace parent verification compares real repository roots rather than path spelling", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.dir, "repo alias");
  await fs.symlink(f.repo, alias, "dir");
  f.options.parentList = { source: { repo_root: alias, source_checkout_path: alias } };
  const job = await f.open({ placement: "subworkspace" });
  assert.equal(job.parentWorkspace, "parent");
  assert.equal((await f.git("-C", job.worktree, "rev-parse", "HEAD")).stdout.trim(), f.base);
  assert.equal(f.calls.filter((args) => args[2] === "create").length, 1);
});

test("subworkspace placement refuses a repository with no parent workspace without creating resources", async (t) => {
  const f = await fixture(t);
  f.sources.clear();
  await assert.rejects(f.open({ placement: "subworkspace" }), /Cannot identify a parent workspace for the requested repository/);
  assert.ok(!f.calls.some((args) => ["create", "open", "run", "split", "close"].includes(args[2]) || args.includes("remove")));
  assert.deepEqual((await f.git("for-each-ref", "--format=%(refname)", "refs/heads/")).stdout.trim().split("\n"), ["refs/heads/main"]);
  assert.deepEqual(JSON.parse(await f.c.listSessions(owner.sessionID)), []);
});

for (const mismatch of ["repository", "checkout"]) {
  test(`subworkspace placement refuses a recorded parent with the wrong ${mismatch} before creation`, async (t) => {
    const f = await fixture(t);
    const otherRepo = path.join(f.dir, "wrong repo");
    await f.git("init", "-q", "--initial-branch=main", otherRepo);
    f.options.parentList = { source: { repo_root: mismatch === "repository" ? otherRepo : f.repo, source_checkout_path: otherRepo } };
    await assert.rejects(f.open({ placement: "subworkspace" }), /Recorded parent workspace does not match the requested repository root/);
    assert.ok(f.calls.some((args) => args[2] === "list" && args.includes("--workspace") && args.includes("parent")));
    assert.ok(!f.calls.some((args) => ["create", "open", "run", "split", "close"].includes(args[2]) || args.includes("remove")));
    assert.deepEqual(JSON.parse(await f.c.listSessions(owner.sessionID)), []);
    assert.equal(f.workspaces.has("parent"), true);
  });
}

test("bounded delegation also supports subworkspace placement with runtime state and child-only cleanup", async (t) => {
  const f = await fixture(t);
  const args = { agent: "worker", task: "Bounded work", repo: f.repo, branch: "bounded/subworkspace", placement: "subworkspace", outputContract: "advisory", baseCommit: f.base };
  const output = await delegateTool(f.c).execute(args, owner);
  assert.match(output, /Delegated to worker/);
  const create = f.calls.find((words) => words[2] === "create");
  const worktree = create[create.indexOf("--path") + 1];
  const jobId = path.basename(worktree);
  const job = { jobId, jobDir: path.join(root(), jobId) };
  const metadata = await f.metadata(job);
  assert.equal(metadata.mode, undefined);
  assert.equal(metadata.parentWorkspace, "parent");
  assert.equal(metadata.placement, "subworkspace");
  assert.equal(create[create.indexOf("--label") + 1], "worker");
  await assert.rejects(fs.access(path.join(sessionRoot(), jobId)), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(job.jobDir, FILES.session)), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await f.c.listSessions(owner.sessionID)), []);
  assert.match(f.calls.find((words) => words[2] === "run")[4], /Call `complete` when done.*call `ask`/);
  await f.c.reap(jobId, { deleteBranch: true });
  await assert.rejects(fs.access(worktree), { code: "ENOENT" });
  await assert.rejects(f.git("show-ref", "--verify", `refs/heads/${args.branch}`));
  assert.deepEqual(f.calls.filter((words) => words[2] === "close"), [["herdr", "workspace", "close", metadata.workspace]]);
  assert.equal(f.workspaces.has("parent"), true);
  assert.equal(f.workspaces.has("unrelated"), true);
  assert.equal(f.panes.has("coordinator-pane"), true);
});

for (const failure of ["identity", "checkout", "conversation", "conversation id", "conversation directory", "branch", "pane inventory", "parent"]) {
  test(`resume refuses missing or changed ${failure} rather than creating a substitute`, async (t) => {
    const f = await fixture(t);
    const job = await f.open({ placement: failure === "parent" ? "subworkspace" : "pane" });
    f.options.busy = true;
    const paused = await f.handBack(job);
    const metadata = await f.metadata(job);
    assert.equal(metadata.pending.key, `handback:${paused.handbackID}`);
    let expected;
    if (failure === "identity") {
      delete paused.sessionID;
      await atomicWriteJSON(path.join(job.jobDir, FILES.session), paused);
      expected = /Saved conversation identity is missing/;
    } else if (failure === "checkout") {
      await f.git("worktree", "remove", job.worktree);
      expected = /Saved worktree is missing/;
    } else if (failure === "conversation") {
      f.conversations.delete(paused.sessionID);
    } else if (failure.startsWith("conversation ")) {
      f.conversations.set(paused.sessionID, { id: failure === "conversation id" ? "wrong" : paused.sessionID, directory: failure === "conversation directory" ? f.repo : job.worktree });
      expected = /Saved conversation does not belong/;
    } else if (failure === "branch") {
      await f.git("-C", job.worktree, "switch", "-q", "-c", "unexpected-branch");
      expected = /Saved worktree branch has changed/;
    } else if (failure === "pane inventory") {
      f.options.paneList = {};
      expected = /Cannot inspect existing panes/;
    } else {
      f.closeWorkspace(job.workspace);
      f.workspaces.delete("parent");
      expected = /Resume failed.*Missing parent workspace/;
    }
    const start = f.calls.length;
    if (expected) await assert.rejects(f.c.resumeSession(job.jobId), expected);
    else await assert.rejects(f.c.resumeSession(job.jobId));
    const after = await f.state(job);
    assert.equal(after.status, "paused");
    assert.equal(after.sessionID, paused.sessionID);
    assert.equal(after.completionToken, paused.completionToken);
      assert.equal(after.handbackID, failure === "parent" ? undefined : paused.handbackID);
    assert.equal(after.generation, paused.generation + (failure === "parent" ? 1 : 0));
    if (failure !== "parent") {
      assert.deepEqual(after, paused);
      assert.deepEqual(await f.metadata(job), metadata, "failed validation must not retire the pending notice");
      assert.ok(!(await f.logs()).some((record) => ["notification_superseded", "resume_started"].includes(record.event)));
    }
    assert.equal(f.posts.length, 0);
    assert.ok(!f.calls.slice(start).some((args) => ["create", "open", "split", "run", "prompt", "close"].includes(args[2])));
    assert.equal(f.c.resolveJobId(job.jobId), job.jobId);
    if (failure !== "checkout") await fs.access(job.worktree);
    await f.git("show-ref", "--verify", `refs/heads/${job.branch}`);
  });
}

for (const failure of ["prompt", "run", "open"]) {
  test(`failed resume ${failure} preserves paused state, conversation and dirty work`, async (t) => {
    const f = await fixture(t);
    const job = await f.open({ placement: failure === "open" ? "subworkspace" : "pane" });
    const paused = await f.handBack(job);
    await fs.writeFile(path.join(job.worktree, "draft.txt"), "must survive failure");
    if (failure === "prompt") f.options.failPrompt = true;
    if (failure === "run") { f.panes.delete(job.pane); f.options.failRun = true; }
    if (failure === "open") { f.closeWorkspace(job.workspace); f.options.failOpen = true; }
    const start = f.calls.length;
    await assert.rejects(f.c.resumeSession(job.jobId), /Resume failed/);
    const after = await f.state(job);
    assert.equal(after.status, "paused");
    assert.equal(after.generation, paused.generation + 1);
    assert.equal(after.sessionID, paused.sessionID);
    assert.equal(after.handbackID, undefined);
    assert.equal(await fs.readFile(path.join(job.worktree, "draft.txt"), "utf8"), "must survive failure");
    assert.ok(!f.calls.slice(start).some((args) => args[2] === "close" || args.includes("remove") || args.includes("-D")));
    assert.equal(f.c.resolveJobId(job.jobId), job.jobId);
    await assert.rejects(f.c.reap(job.jobId), /Active or paused|Resource creation is uncertain/);
    if (failure !== "run") {
      f.options.failPrompt = false;
      f.options.failOpen = false;
      await f.c.resumeSession(job.jobId);
      assert.equal((await f.state(job)).status, "active");
    }
  });
}

for (const disposition of ["pause", "commit", "discard"]) {
  test(`failed resume prompt preserves a newer ${disposition} hand-back published during dispatch`, async (t) => {
    const f = await fixture(t);
    const job = await f.open();
    const paused = await f.handBack(job);
    await fs.writeFile(path.join(job.worktree, "draft.txt"), "work completed during resume");
    let newer;
    let publication;
    let publicationError;
    f.options.onPrompt = async () => {
      const delegate = await consume(job.jobDir);
      const context = { sessionID: paused.sessionID };
      await readTaskTool(delegate).execute({}, context);
      // A real peer runs concurrently, not inside the CLI request's promise.
      publication = handBackTool(delegate).execute({ disposition, summary: "New work after resuming", checks: ["new checks"], risks: ["new risks"], userInstruction: `Please ${disposition} the new work.` }, context)
        .then(() => f.state(job)).then((state) => { newer = state; }, (error) => { publicationError = error; });
    };
    f.options.failPrompt = true;
    const start = f.calls.length;
    await assert.rejects(f.c.resumeSession(job.jobId), /Resume failed/);
    await publication;
    assert.ifError(publicationError);
    assert.ok(newer);
    assert.equal(newer.generation, paused.generation + 1);
    assert.equal(newer.sessionID, paused.sessionID);
    assert.notEqual(newer.handbackID, paused.handbackID);
    assert.deepEqual(await f.state(job), newer);
    assert.equal((await f.metadata(job)).resuming, undefined);
    await f.settle(job);
    assert.deepEqual((await f.metadata(job)).delivered, [`handback:${paused.handbackID}`, `handback:${newer.handbackID}`]);
    assert.equal(f.posts.length, 2);
    assert.match(f.posts[1].parts[0].text, /New work after resuming/);
    assert.equal(await fs.readFile(path.join(job.worktree, "draft.txt"), "utf8"), "work completed during resume");
    assert.equal(f.panes.has(job.pane), true);
    assert.ok(!f.calls.slice(start).some((args) => args[2] === "close" || args.includes("remove") || args.includes("-D")));
  });
}

for (const livePane of [true, false]) {
  test(`recovery retries persisted resuming active control in the same conversation with a ${livePane ? "live" : "closed"} pane`, async (t) => {
    const f = await fixture(t);
    const job = await f.open();
    const paused = await f.handBack(job);
    await f.c.dispose();
    const { handbackID, ...previous } = paused;
    const active = { ...previous, status: "active", generation: paused.generation + 1 };
    const metadata = await f.metadata(job);
    metadata.resuming = { generation: active.generation, instructions: "Continue saved work" };
    await atomicWriteJSON(path.join(job.jobDir, FILES.coordinator), metadata);
    await atomicWriteJSON(path.join(job.jobDir, FILES.session), active);
    await fs.writeFile(path.join(job.worktree, "draft.txt"), "survives restart");
    if (!livePane) f.panes.delete(job.pane);
    const recovered = f.coordinator();
    await recovered.recover();
    await f.settle(job, recovered);
    assert.deepEqual(await f.state(job), active);
    assert.deepEqual((await f.metadata(job)).resuming, metadata.resuming);
    assert.equal(f.posts.length, 1);
    const start = f.calls.length;
    assert.match(await resumeSessionTool(recovered).execute({ jobId: job.jobId, instructions: "Continue saved work" }, owner), /Resumed/);
    assert.deepEqual(await f.state(job), active, "retry must not allocate another generation or conversation");
    assert.equal((await f.metadata(job)).resuming, undefined);
    assert.deepEqual(f.gets, [{ path: `/session/${paused.sessionID}`, directory: job.worktree }]);
    const commands = f.calls.slice(start);
    const dispatches = commands.filter((args) => ["prompt", "run"].includes(args[2]));
    assert.equal(dispatches.length, 1);
    assert.match(dispatches[0][4], /Continue saved work/);
    if (livePane) {
      assert.equal(dispatches[0][2], "prompt");
      assert.equal(dispatches[0][3], job.pane);
      assert.ok(!commands.some((args) => args[2] === "split"));
    } else {
      assert.equal(dispatches[0][2], "run");
      assert.ok(dispatches[0][4].includes(`--session '${paused.sessionID}'`));
      assert.notEqual((await f.metadata(job)).pane, job.pane);
    }
    assert.ok(!commands.some((args) => args[2] === "create" || args.includes("add") || args[2] === "close" || args.includes("remove")));
    assert.equal(await fs.readFile(path.join(job.worktree, "draft.txt"), "utf8"), "survives restart");
  });
}

test("an already-open child refuses duplicate conversation launch and remains paused", async (t) => {
  const f = await fixture(t);
  const job = await f.open({ placement: "subworkspace" });
  const paused = await f.handBack(job);
  f.closeWorkspace(job.workspace);
  f.options.alreadyOpen = true;
  const start = f.calls.length;
  await assert.rejects(f.c.resumeSession(job.jobId), /Workspace is already open without the saved pane/);
  assert.equal((await f.state(job)).status, "paused");
  assert.equal((await f.state(job)).sessionID, paused.sessionID);
  assert.ok(!f.calls.slice(start).some((args) => args[2] === "run" || args[2] === "close"));
  await fs.access(job.worktree);
});

for (const disposition of ["pause", "commit"]) {
  test(`a busy orchestrator's pending ${disposition} hand-back does not block explicit resume or grant commit or reap permission`, async (t) => {
    const f = await fixture(t);
    const job = await f.open();
    await fs.writeFile(path.join(job.worktree, "draft.txt"), "changes still needed\n");
    f.options.busy = true;
    const previous = await f.handBack(job, disposition);
    const metadata = await f.metadata(job);
    assert.equal(metadata.pending.key, `handback:${previous.handbackID}`);
    assert.equal(metadata.pending.attemptedAt, undefined);
    assert.deepEqual(metadata.delivered, []);
    assert.equal(f.posts.length, 0);
    assert.deepEqual(JSON.parse(await listSessionsTool(f.c).execute({}, owner)), [{
      jobId: job.jobId, name: job.name, status: previous.status, phase: "running", placement: "pane",
      worktree: job.worktree, branch: job.branch, pane: job.pane, sessionID: previous.sessionID,
      summary: previous.summary, generation: previous.generation, checks: previous.checks, risks: previous.risks,
      notificationPending: true,
    }]);
    const start = f.calls.length;
    const result = await resumeSessionTool(f.c).execute({ jobId: job.jobId, instructions: "Make the requested changes before another hand-back" }, owner);
    assert.ok(result.includes(`Previous hand-back (${previous.status}, generation ${previous.generation}): ${previous.summary}`));
    assert.ok(result.includes(`Checks: ${previous.checks.join("; ")}`));
    assert.ok(result.includes(`Risks: ${previous.risks.join("; ")}`));
    assert.match(result, /Do not commit or reap until a new hand-back/);
    const { handbackID, ...previousControl } = previous;
    assert.deepEqual(await f.state(job), { ...previousControl, status: "active", generation: previous.generation + 1 });
    assert.equal((await f.metadata(job)).pending, undefined);
    assert.deepEqual((await f.metadata(job)).delivered, [`handback:${previous.handbackID}`]);
    const prompts = f.calls.slice(start).filter((args) => args[2] === "prompt");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0][3], job.pane);
    assert.match(prompts[0][4], /Call read_task to refresh control.*Make the requested changes/);
    for (const options of [{}, { deleteBranch: true }, { discard: true, confirmation: job.jobId }]) {
      await assert.rejects(f.c.reap(job.jobId, options), /Active or paused sessions must be handed back/);
    }
    assert.ok(!f.calls.slice(start).some((args) => ["commit", "merge", "push", "remove", "-d", "-D"].some((word) => args.includes(word)) || ["close", "split", "run", "create", "open"].includes(args[2])));
    assert.equal((await f.git("rev-parse", job.branch)).stdout.trim(), f.base);
    assert.equal(await fs.readFile(path.join(job.worktree, "draft.txt"), "utf8"), "changes still needed\n");
    await f.c.dispose();
    f.options.busy = false;
    const recovered = f.coordinator();
    await recovered.recover();
    await f.settle(job, recovered);
    assert.equal(f.posts.length, 0, "the retired hand-back must not be submitted after restart");
    assert.deepEqual((await f.metadata(job)).delivered, [`handback:${previous.handbackID}`]);
    const [listed] = JSON.parse(await listSessionsTool(recovered).execute({}, owner));
    assert.equal(listed.status, "active");
    assert.equal(listed.generation, previous.generation + 1);
    assert.equal(listed.notificationPending, false);
    assert.equal(Object.hasOwn(listed, "notificationAttemptedAt"), false);
  });
}

for (const failure of ["HTTP 503 submission", "HTTP 503 read-back", "mismatched read-back"]) {
  test(`unacknowledged hand-back after ${failure} does not block explicit resume or replay after restart`, async (t) => {
    const f = await fixture(t);
    t.mock.method(console, "error", () => {});
    const job = await f.open();
    if (failure === "HTTP 503 submission") f.options.promptStatus = 503;
    else if (failure === "HTTP 503 read-back") f.options.readbackStatus = 503;
    else f.options.receiptParts = [{ type: "text", text: "not the submitted hand-back" }];
    const paused = await f.handBack(job);
    const pending = (await f.metadata(job)).pending;
    assert.equal(pending.key, `handback:${paused.handbackID}`);
    assert.deepEqual((await f.metadata(job)).delivered, []);
    const attempted = failure !== "HTTP 503 read-back";
    assert.equal(f.posts.length, attempted ? 1 : 0);
    if (attempted) assert.ok(Number.isSafeInteger(pending.attemptedAt) && pending.attemptedAt > 0);
    else assert.equal(pending.attemptedAt, undefined);
    const [listed] = JSON.parse(await listSessionsTool(f.c).execute({}, owner));
    assert.equal(listed.notificationPending, true);
    assert.equal(listed.notificationAttemptedAt, pending.attemptedAt);
    assert.equal(listed.generation, paused.generation);
    assert.deepEqual(listed.checks, paused.checks);
    assert.deepEqual(listed.risks, paused.risks);
    const result = await resumeSessionTool(f.c).execute({ jobId: job.jobId }, owner);
    for (const text of [paused.summary, ...paused.checks, ...paused.risks]) assert.ok(result.includes(text));
    const { handbackID, ...previousControl } = paused;
    assert.deepEqual(await f.state(job), { ...previousControl, status: "active", generation: paused.generation + 1 });
    assert.deepEqual(f.gets, [{ path: `/session/${paused.sessionID}`, directory: job.worktree }]);
    assert.equal((await f.metadata(job)).pending, undefined);
    assert.deepEqual((await f.metadata(job)).delivered, [`handback:${paused.handbackID}`]);
    await f.c.dispose();
    f.options.promptStatus = 204;
    f.options.readbackStatus = undefined;
    f.options.receiptParts = undefined;
    const recovered = f.coordinator();
    await recovered.recover();
    await f.settle(job, recovered);
    assert.equal(f.posts.length, attempted ? 1 : 0, "recovery must not replay the retired notice");
    assert.equal((await f.metadata(job)).pending, undefined);
    assert.deepEqual((await f.metadata(job)).delivered, [`handback:${paused.handbackID}`]);
  });
}

test("a commit hand-back supersedes an undelivered pause and only the commit note is sent", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  f.options.busy = true;
  const paused = await f.handBack(job);
  assert.equal((await f.metadata(job)).pending.key, `handback:${paused.handbackID}`);
  assert.equal(f.posts.length, 0);
  const { delegate, context } = await f.bind(job);
  await handBackTool(delegate).execute({ disposition: "commit", summary: "Final work ready for review", checks: ["final check passed"], risks: ["final review needed"], userInstruction: "Hand this back for commit instead of leaving it paused" }, context);
  const ready = await f.state(job);
  assert.equal(ready.status, "commit");
  assert.equal(ready.generation, paused.generation);
  assert.notEqual(ready.handbackID, paused.handbackID);
  await f.settle(job);
  assert.deepEqual((await f.metadata(job)).delivered, [`handback:${paused.handbackID}`]);
  assert.equal((await f.metadata(job)).pending.key, `handback:${ready.handbackID}`);
  assert.equal(f.posts.length, 0);
  f.options.busy = false;
  await f.settle(job);
  assert.equal(f.posts.length, 1);
  const text = f.posts[0].parts[0].text;
  assert.match(text, /READY FOR COMMIT/);
  assert.doesNotMatch(text, /PAUSED/);
  for (const value of [ready.summary, ...ready.checks, ...ready.risks, ready.userInstruction]) assert.ok(text.includes(value));
  assert.ok(!text.includes(paused.summary));
  assert.equal((await f.metadata(job)).pending, undefined);
  assert.deepEqual((await f.metadata(job)).delivered, [`handback:${paused.handbackID}`, `handback:${ready.handbackID}`]);
  await f.c.dispose();
  const recovered = f.coordinator();
  await recovered.recover();
  await f.settle(job, recovered);
  assert.equal(f.posts.length, 1);
  assert.deepEqual(await f.state(job), ready);
});

test("cleanup retains content-free lifecycle logs after deleting the job, including failed and successful resume events", async (t) => {
  const f = await fixture(t);
  const job = await f.open({ name: "Private session name", task: "Private task text" });
  f.options.busy = true;
  const paused = await f.handBack(job);
  f.panes.get(job.pane).agent_status = "working";
  await assert.rejects(f.c.resumeSession(job.jobId, "Private failed resume instruction"), /busy or its conversation identity/);
  f.panes.get(job.pane).agent_status = "idle";
  await f.c.resumeSession(job.jobId, "Private successful resume instruction");
  await f.handBack(job, "commit");
  await f.c.reap(job.jobId);
  await assert.rejects(fs.access(job.jobDir), { code: "ENOENT" });
  await assert.rejects(fs.access(job.worktree), { code: "ENOENT" });
  const records = await f.logs();
  assert.ok(records.length > 0);
  const events = records.map((record) => record.event);
  assert.deepEqual(events.filter((event) => event.startsWith("resume_")), ["resume_failed", "resume_started", "resume_completed"]);
  assert.deepEqual(events.filter((event) => event.startsWith("cleanup_")), ["cleanup_started", "cleanup_completed"]);
  assert.ok(records.some((record) => record.event === "notification_superseded" && record.reason === "resume"));
  for (const event of ["resume_started", "resume_completed"]) {
    assert.equal(records.find((record) => record.event === event).generation, paused.generation + 1);
  }
  for (const record of records) {
    assert.equal(record.jobId, job.jobId);
    assert.equal(new Date(record.time).toISOString(), record.time);
    assert.ok(Object.keys(record).every((key) => ["time", "jobId", "event", "generation", "disposition", "reason", "httpStatus"].includes(key)));
  }
  const text = JSON.stringify(records);
  for (const value of [job.name, job.args.task, job.worktree, job.branch, job.repo, paused.sessionID,
    paused.completionToken, paused.summary, ...paused.checks, ...paused.risks, paused.userInstruction,
    "Private failed resume instruction", "Private successful resume instruction", "Saved pane is busy"]) {
    assert.ok(!text.includes(value), `Lifecycle logs leaked ${value}`);
  }
});

test("accepted hand-back with a lost response recovers by read-back without duplicate delivery", async (t) => {
  const f = await fixture(t);
  t.mock.method(console, "error", () => {});
  const job = await f.open();
  f.options.loseResponse = true;
  const paused = await f.handBack(job);
  await f.settle(job);
  assert.equal(f.posts.length, 1);
  assert.deepEqual((await f.metadata(job)).delivered, [`handback:${paused.handbackID}`]);
  assert.equal((await f.metadata(job)).pending, undefined);
});

test("a startup-timeout notice stays pending across busy scans and delivers once when idle", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  f.options.busy = true;
  t.mock.timers.enable({ apis: ["Date"], now: job.createdAt + job.startupTimeoutSeconds * 1000 + 1 });
  await f.settle(job);
  const pending = (await f.metadata(job)).pending;
  assert.equal(pending.key, "startup-timeout");
  assert.equal(pending.attemptedAt, undefined);
  await f.settle(job);
  assert.deepEqual((await f.metadata(job)).pending, pending);
  assert.deepEqual((await f.metadata(job)).delivered, []);
  assert.equal(f.posts.length, 0);
  assert.equal((await f.state(job)).status, "active");
  assert.ok(!(await f.logs()).some((record) => record.event === "notification_superseded"));
  f.options.busy = false;
  await f.settle(job);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].parts[0].text, pending.text);
  assert.match(pending.text, /failed to start within its timeout/);
  assert.equal((await f.metadata(job)).pending, undefined);
  assert.deepEqual((await f.metadata(job)).delivered, ["startup-timeout"]);
  await f.c.dispose();
  const recovered = f.coordinator();
  await recovered.recover();
  await f.settle(job, recovered);
  assert.equal(f.posts.length, 1);
});

test("background lock contention is quiet and retries delivery without hiding subsequent state failures", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  f.options.busy = true;
  const paused = await f.handBack(job);
  const pending = (await f.metadata(job)).pending;
  const errors = t.mock.method(console, "error", () => {});
  const logCount = (await f.logs()).length;
  f.options.busy = false;

  await withSessionLock(job.jobId, async () => {
    await f.settle(job);
    assert.equal(errors.mock.callCount(), 0);
    assert.equal((await f.logs()).length, logCount);
    assert.deepEqual((await f.metadata(job)).pending, pending);
    assert.equal(f.posts.length, 0);
  });

  // Contention must not consume the genuine failure log's rate-limit window.
  await atomicWriteJSON(path.join(job.jobDir, FILES.session), { ...paused, completionToken: "invalid-token" });
  await f.settle(job);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal((await f.logs()).slice(logCount).filter((record) => record.event === "reconciliation_failed").length, 1);

  await atomicWriteJSON(path.join(job.jobDir, FILES.session), paused);
  await f.settle(job);
  assert.equal(f.posts.length, 1);
  assert.equal((await f.metadata(job)).pending, undefined);
  assert.deepEqual((await f.metadata(job)).delivered, [`handback:${paused.handbackID}`]);
  assert.deepEqual(await f.state(job), paused);
});

test("reconciliation failures log at most once per job per minute while scans keep retrying", async (t) => {
  const f = await fixture(t);
  const job = await f.open({ startupTimeoutSeconds: 120 });
  const state = await f.state(job);
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const errors = t.mock.method(console, "error", () => {});
  await atomicWriteJSON(path.join(job.jobDir, FILES.session), { ...state, completionToken: "private-invalid-token" });
  await f.settle(job);
  const failures = async () => (await f.logs()).filter((record) => record.event === "reconciliation_failed");
  assert.equal((await failures()).length, 1);
  t.mock.timers.tick(59_999);
  await f.settle(job);
  assert.equal((await failures()).length, 1);
  assert.equal(errors.mock.callCount(), 1);
  t.mock.timers.tick(1);
  await f.settle(job);
  const records = await failures();
  assert.equal(records.length, 2);
  assert.equal(errors.mock.callCount(), 2);
  assert.deepEqual(records, [now, now + 60_000].map((time) => ({
    time: new Date(time).toISOString(), jobId: job.jobId, event: "reconciliation_failed", reason: "state",
  })));
  await atomicWriteJSON(path.join(job.jobDir, FILES.session), state);
  await f.handBack(job);
  assert.equal(f.posts.length, 1, "rate limiting the failure log must not suppress reconciliation itself");
});

test("two live recovered coordinators lock concurrent hand-back scans and retry without duplicate posts", async (t) => {
  const f = await fixture(t);
  t.mock.method(console, "error", () => {});
  const job = await f.open();
  f.options.busy = true;
  const paused = await f.handBack(job);
  const pending = (await f.metadata(job)).pending;
  assert.equal(pending.key, `handback:${paused.handbackID}`);
  assert.equal(f.posts.length, 0);
  await f.c.dispose();
  const first = f.coordinator();
  const second = f.coordinator();
  await Promise.all([first.recover(), second.recover()]);
  await f.settle(job, first);
  await f.settle(job, second);
  assert.equal(first.resolveJobId(job.jobId), job.jobId);
  assert.equal(second.resolveJobId(job.jobId), job.jobId);
  let concurrentScan = false;
  f.options.onPost = async (body) => {
    concurrentScan = true;
    assert.equal(await fs.readFile(path.join(sessionRoot(), ".locks", job.jobId), "utf8"), String(process.pid));
    assert.equal((await f.metadata(job)).pending.messageID, body.messageID);
    await Promise.all([second.reconcile(job.jobId), second.reconcile(job.jobId)]);
    assert.equal((await f.metadata(job)).pending.messageID, body.messageID);
    assert.deepEqual((await f.metadata(job)).delivered, [], "a contender must not acknowledge an in-flight delivery");
    assert.equal(f.posts.length, 1, "a contender must not post while delivery is in flight");
  };
  f.options.busy = false;
  await f.settle(job, first);
  assert.equal(concurrentScan, true);
  f.options.onPost = undefined;
  await Promise.all([first.reconcile(job.jobId), second.reconcile(job.jobId)]);
  await f.settle(job, second);
  await f.settle(job, first);
  assert.equal(f.posts.length, 1);
  assert.deepEqual((await f.metadata(job)).delivered, [`handback:${paused.handbackID}`]);
  assert.equal((await f.metadata(job)).pending, undefined);
  assert.deepEqual(await f.state(job), paused);
  await first.dispose();
  await second.dispose();
  await assert.rejects(fs.access(path.join(sessionRoot(), ".locks", job.jobId)), { code: "ENOENT" });
});

for (const contents of [String(process.pid), "", "not-a-pid", "0", "1.5"]) {
  test(`resume and reap refuse a ${contents === String(process.pid) ? "live PID" : `malformed or incomplete ${JSON.stringify(contents)}`} lock without removing it`, async (t) => {
    const f = await fixture(t);
    t.mock.method(console, "error", () => {});
    const job = await f.open();
    const paused = await f.handBack(job);
    await f.c.dispose();
    const metadata = await f.metadata(job);
    const lock = path.join(sessionRoot(), ".locks", job.jobId);
    await fs.writeFile(lock, contents);
    const recovered = f.coordinator();
    await recovered.recover();
    await f.settle(job, recovered);
    const start = f.calls.length;
    const expected = contents === String(process.pid) ? /being updated by another coordinator/ : /Session lock is incomplete/;
    await assert.rejects(recovered.resumeSession(job.jobId), expected);
    await assert.rejects(recovered.reap(job.jobId, { discard: true, confirmation: job.jobId, deleteBranch: true }), expected);
    assert.equal(await fs.readFile(lock, "utf8"), contents);
    assert.deepEqual(await f.metadata(job), metadata);
    assert.deepEqual(await f.state(job), paused);
    assert.deepEqual(f.calls.slice(start), []);
    assert.equal(f.gets.length, 0);
    assert.equal(f.posts.length, 1);
    await fs.access(job.worktree);
  });
}

test("a stale lock from a dead PID is recovered before resuming the saved conversation", async (t) => {
  const f = await fixture(t);
  const job = await f.open();
  const paused = await f.handBack(job);
  await f.c.dispose();
  const deadPID = Number((await exec(process.execPath, ["-e", "process.stdout.write(String(process.pid))"])).stdout);
  assert.throws(() => process.kill(deadPID, 0), { code: "ESRCH" });
  const lock = path.join(sessionRoot(), ".locks", job.jobId);
  await fs.writeFile(lock, String(deadPID));
  const recovered = f.coordinator();
  await recovered.recover();
  await f.settle(job, recovered);
  await assert.rejects(fs.access(lock), { code: "ENOENT" });
  assert.deepEqual(await f.state(job), paused);
  await recovered.resumeSession(job.jobId);
  const active = await f.state(job);
  assert.equal(active.status, "active");
  assert.equal(active.sessionID, paused.sessionID);
  assert.equal(active.generation, paused.generation + 1);
  assert.equal(f.calls.filter((args) => args[2] === "prompt").length, 1);
  assert.equal(f.posts.length, 1);
  await recovered.dispose();
  await assert.rejects(fs.access(lock), { code: "ENOENT" });
});

test("a lost create response after herdr side effects retains uncertain resources and refuses reap after recovery", async (t) => {
  const f = await fixture(t);
  f.options.failCreateAfterSideEffect = true;
  await assert.rejects(f.open({ placement: "subworkspace" }), /worktree create response lost after creation.*Resource creation is uncertain/);
  const create = f.calls.find((args) => args[2] === "create");
  const worktree = create[create.indexOf("--path") + 1];
  const jobId = path.basename(worktree);
  const job = { jobId, jobDir: path.join(sessionRoot(), jobId) };
  const metadata = await f.metadata(job);
  assert.equal(metadata.resourceUncertain, true);
  assert.equal(metadata.phase, "starting");
  assert.equal(metadata.worktree, worktree);
  assert.equal(metadata.parentWorkspace, "parent");
  assert.equal(metadata.workspace, undefined, "a thrown response cannot establish resource ownership");
  assert.equal(metadata.pane, undefined);
  assert.equal((await f.state(job)).status, "active");
  assert.equal((await f.git("-C", worktree, "branch", "--show-current")).stdout.trim(), metadata.branch);
  const workspace = [...f.workspaces.values()].find((entry) => entry.path === worktree);
  assert.ok(workspace);
  assert.ok([...f.panes.values()].some((pane) => pane.workspace_id === workspace.workspace_id));
  assert.ok(!f.calls.some((args) => ["run", "close"].includes(args[2]) || args.includes("remove") || args.includes("-D")));
  await fs.writeFile(path.join(worktree, "draft.txt"), "preserve uncertain resources");
  await f.c.dispose();
  const recovered = f.coordinator();
  await recovered.recover();
  await f.settle(job, recovered);
  assert.equal(recovered.resolveJobId(jobId), jobId);
  const start = f.calls.length;
  for (const options of [{}, { deleteBranch: true }, { discard: true, confirmation: jobId, deleteBranch: true }]) {
    await assert.rejects(recovered.reap(jobId, options), /Resource creation is uncertain/);
  }
  assert.ok(f.calls.slice(start).some((args) => args[1] === "worktree" && args[2] === "list" && args.includes("--cwd")));
  assert.ok(!f.calls.slice(start).some((args) => ["create", "open", "run", "close"].includes(args[2]) || args.includes("remove") || args.includes("-D")));
  assert.deepEqual(await f.metadata(job), metadata);
  assert.equal(await fs.readFile(path.join(worktree, "draft.txt"), "utf8"), "preserve uncertain resources");
  assert.equal(f.workspaces.has(workspace.workspace_id), true);
  await f.git("show-ref", "--verify", `refs/heads/${metadata.branch}`);
});

for (const residual of ["none", "wrong-parent branch", "launch", "path", "branch", "worktree inventory", "workspace inventory", "parent inventory", "git inventory"]) {
  test(`failed creation recovery ${residual === "none" ? "permits cleanup when no resources or launch exist" : `refuses cleanup with ${residual}`}`, async (t) => {
    const f = await fixture(t);
    f.options.onCreate = async () => {
      f.options.workspaceList = {};
      throw new Error("definitive create failure before side effects");
    };
    await assert.rejects(f.open({ placement: "subworkspace" }), /definitive create failure before side effects.*invalid workspace inventory/);
    const create = f.calls.find((args) => args[2] === "create");
    const worktree = create[create.indexOf("--path") + 1];
    const jobId = path.basename(worktree);
    const job = { jobId, jobDir: path.join(sessionRoot(), jobId) };
    await f.c.dispose();
    const metadata = await f.metadata(job);
    assert.equal(metadata.resourceUncertain, true);
    assert.equal(metadata.phase, "starting");
    assert.equal(metadata.launchAttempted, undefined);
    await assert.rejects(fs.access(worktree), { code: "ENOENT" });
    await assert.rejects(f.git("show-ref", "--verify", `refs/heads/${metadata.branch}`));
    f.options.workspaceList = undefined;
    let expected = /Resource creation is uncertain/;
    let wrongRepo;
    if (residual === "wrong-parent branch") {
      wrongRepo = path.join(f.dir, "old wrong parent repo");
      await f.git("init", "-q", "--initial-branch=main", wrongRepo);
      await f.git("-C", wrongRepo, "commit", "-q", "--allow-empty", "-m", "wrong parent base");
      await f.git("-C", wrongRepo, "branch", metadata.branch);
      f.sources.set("unrelated", { repo_root: wrongRepo, source_checkout_path: wrongRepo, source_workspace_id: "unrelated" });
      metadata.parentWorkspace = "unrelated";
      await atomicWriteJSON(path.join(job.jobDir, FILES.coordinator), metadata);
      expected = /Uncertain resources remain in the recorded parent repository/;
    } else if (residual === "launch") {
      metadata.launchAttempted = true;
      await atomicWriteJSON(path.join(job.jobDir, FILES.coordinator), metadata);
    } else if (residual === "path") {
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, "keep.txt"), "unregistered resources");
    } else if (residual === "branch") {
      await f.git("branch", metadata.branch);
    } else if (residual === "worktree inventory") {
      f.options.worktreeList = {};
      expected = /invalid worktree inventory/;
    } else if (residual === "workspace inventory") {
      f.options.workspaceList = {};
      expected = /invalid workspace inventory/;
    } else if (residual === "parent inventory") {
      f.options.parentList = {};
      expected = /invalid parent inventory/;
    } else if (residual === "git inventory") {
      f.options.failGitInventory = true;
      expected = /git inventory unavailable/;
    }
    const recovered = f.coordinator();
    await recovered.recover();
    await f.settle(job, recovered);
    assert.equal(recovered.resolveJobId(jobId), jobId);
    const start = f.calls.length;
    if (residual === "none") {
      await recovered.reap(jobId, { deleteBranch: true });
      await assert.rejects(fs.access(job.jobDir), { code: "ENOENT" });
      await assert.rejects(fs.access(worktree), { code: "ENOENT" });
      assert.equal(recovered.resolveJobId(jobId), undefined);
      assert.ok((await f.logs()).some((record) => record.event === "creation_reconciled"));
      assert.ok(f.calls.slice(start).some((args) => args.includes("--porcelain") && args.includes("-z")));
      assert.ok(f.calls.slice(start).some((args) => args.includes("for-each-ref")));
      assert.ok(f.calls.slice(start).some((args) => args[1] === "workspace" && args[2] === "list"));
      assert.ok(f.calls.slice(start).some((args) => args.includes("--workspace") && args.includes("parent")));
    } else {
      await assert.rejects(recovered.reap(jobId, { deleteBranch: true }), expected);
      assert.deepEqual(await f.metadata(job), metadata);
      assert.equal(recovered.resolveJobId(jobId), jobId);
      assert.ok(!(await f.logs()).some((record) => record.event === "creation_reconciled"));
      if (wrongRepo) await f.git("-C", wrongRepo, "show-ref", "--verify", `refs/heads/${metadata.branch}`);
      if (residual === "branch") await f.git("show-ref", "--verify", `refs/heads/${metadata.branch}`);
      if (residual === "path") assert.equal(await fs.readFile(path.join(worktree, "keep.txt"), "utf8"), "unregistered resources");
    }
    assert.ok(!f.calls.slice(start).some((args) => ["create", "open", "run", "close"].includes(args[2]) || args.includes("remove") || args.includes("-D") || args.includes("-d")));
    assert.equal(f.workspaces.has("parent"), true);
    assert.equal(f.workspaces.has("unrelated"), true);
    assert.equal(f.panes.has("coordinator-pane"), true);
  });
}

test("pane rename failure after interactive launch preserves the active session and prevents reap", async (t) => {
  const f = await fixture(t);
  f.options.failRename = true;
  await assert.rejects(f.open(), /Launch may have started session.*resources are preserved for inspection.*pane rename failed/);
  const runIndex = f.calls.findIndex((args) => args[2] === "run");
  const renameIndex = f.calls.findIndex((args) => args[2] === "rename");
  assert.ok(runIndex >= 0 && renameIndex > runIndex);
  const pane = f.calls[runIndex][3];
  const split = f.calls.find((args) => args[2] === "split");
  const worktree = split[split.indexOf("--cwd") + 1];
  const jobId = path.basename(worktree);
  const job = { jobId, jobDir: path.join(sessionRoot(), jobId) };
  await f.settle(job);
  const metadata = await f.metadata(job);
  assert.equal(metadata.launchAttempted, true);
  assert.equal(metadata.phase, "starting");
  assert.equal(metadata.pane, pane);
  assert.equal(metadata.worktreeCreated, true);
  assert.equal(metadata.branchCreated, true);
  const state = await f.state(job);
  assert.equal(state.status, "active");
  assert.equal(f.panes.has(pane), true);
  assert.ok(!f.calls.some((args) => args[2] === "close" || args.includes("remove") || args.includes("-D")));
  await f.c.dispose();
  const recovered = f.coordinator();
  await recovered.recover();
  await f.settle(job, recovered);
  const start = f.calls.length;
  await assert.rejects(recovered.reap(jobId, { deleteBranch: true }), /Active or paused sessions must be handed back/);
  assert.deepEqual(f.calls.slice(start), []);
  assert.deepEqual(await f.metadata(job), metadata);
  assert.deepEqual(await f.state(job), state);
  assert.equal(f.panes.has(pane), true);
  await fs.access(worktree);
  await f.git("show-ref", "--verify", `refs/heads/${metadata.branch}`);
});

test("uncertain workspace inventory and failed close retain ownership for safe retry", async (t) => {
  const f = await fixture(t);
  const job = await f.open({ placement: "subworkspace" });
  await f.handBack(job, "commit");
  f.options.workspaceList = {};
  await assert.rejects(f.c.reap(job.jobId), /Cannot establish whether delegate workspace exists/);
  assert.equal((await f.metadata(job)).workspace, job.workspace);
  await fs.access(job.worktree);
  f.options.workspaceList = undefined;
  f.options.failClose = true;
  await assert.rejects(f.c.reap(job.jobId), /workspace close failed/);
  assert.equal((await f.metadata(job)).workspace, job.workspace);
  assert.equal(f.workspaces.has(job.workspace), true);
  await fs.access(job.worktree);
  f.options.failClose = false;
  await f.c.reap(job.jobId, { deleteBranch: true });
  assert.equal(f.workspaces.has(job.workspace), false);
  assert.equal(f.workspaces.has("parent"), true);
  await assert.rejects(fs.access(job.worktree), { code: "ENOENT" });
});
