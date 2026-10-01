import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { launchAgent } from "../dist/launch.js";

const exec = promisify(execFile);
test("real direnv loads the destination .env before starting OpenCode and refuses a failing .envrc", async (t) => {
  try { await exec("direnv", ["version"]); } catch { t.skip("direnv unavailable"); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-launch-"));
  const previous = { PATH: process.env.PATH, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  process.env.XDG_DATA_HOME = path.join(dir, "data");
  process.env.PATH = dir + path.delimiter + previous.PATH;
  await fs.writeFile(path.join(dir, "opencode"), "#!/bin/sh\n[ \"$ENVOY_TEST_LOADED\" = ready ] || exit 9\nprintf success > started\n", { mode: 0o700 });
  await fs.writeFile(path.join(dir, ".env"), "ENVOY_TEST_LOADED=ready\n", { mode: 0o600 });
  await fs.writeFile(path.join(dir, ".envrc"), "sleep 0.1\ndotenv .env\n");
  await exec("direnv", ["allow", dir]);
  assert.equal(await launchAgent(dir, []), 0);
  assert.equal(await fs.readFile(path.join(dir, "started"), "utf8"), "success");
  await fs.unlink(path.join(dir, "started"));
  await fs.writeFile(path.join(dir, ".envrc"), "echo private-secret >&2\nexit 1\n");
  await exec("direnv", ["allow", dir]);
  await assert.rejects(launchAgent(dir, []), /environment loading failed/);
  await assert.rejects(fs.access(path.join(dir, "started")), { code: "ENOENT" });
});
