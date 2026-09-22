import { test, expect } from "bun:test";
import { $ } from "bun";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Coordinator } from "../dist/coordinator.js";
import { jobDir } from "../dist/protocol.js";

test("cleanup deletes a merged branch using the real Bun shell parser", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-bun-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = directory;
  const repo = path.join(directory, "repo");
  const coordinator = new Coordinator($ as any, {} as any, repo);
  const id = "a".repeat(32);
  try {
    await $`git init -q --initial-branch=main ${repo}`.quiet();
    await $`git -C ${repo} -c user.name=Test -c user.email=test@example.invalid commit -q --allow-empty -m base`.quiet();
    await $`git -C ${repo} branch smoke-test`.quiet();
    await fs.mkdir(jobDir(id), { recursive: true });
    (coordinator as any).jobs.set(id, {
      jobId: id, directory: repo, repo, sessionID: "test", agent: "build",
      branch: "smoke-test", branchCreated: true, phase: "cleanup", delivered: [],
    });
    await coordinator.reap(id, { deleteBranch: true });
    expect(await $`git -C ${repo} branch --list smoke-test`.text()).toBe("");
    expect(coordinator.resolveJobId(id)).toBeUndefined();
  } finally {
    await coordinator.dispose();
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
