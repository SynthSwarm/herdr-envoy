import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

// Run inside the destination pane. Export completes before spawn, and neither output nor
// errors from .envrc are printed because they can contain credentials.
export async function launchAgent(directory: string, args: string[]) {
  const env = { ...process.env };
  try {
    const result = await promisify(execFile)("direnv", ["export", "json"], {
      cwd: directory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    const changes = JSON.parse(result.stdout.trim() || "{}");
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete env[key];
      else if (typeof value === "string") env[key] = value;
      else throw new Error("Invalid environment export");
    }
  } catch {
    throw new Error("direnv environment loading failed; OpenCode was not started. Inspect .envrc locally and retry.");
  }
  const child = spawn("opencode", args, { cwd: directory, env, stdio: "inherit" });
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, ...args] = process.argv.slice(2);
  if (!directory) process.exitCode = 1;
  else launchAgent(directory, args).then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Envoy: environment preparation or agent launch failed. OpenCode was not started if environment preparation failed. Inspect direnv locally before retrying.");
    process.exitCode = 1;
  });
}
