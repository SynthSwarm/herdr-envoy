import { test, expect } from "bun:test";
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";
import { testRender } from "@opentui/solid";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

ensureRuntimePluginSupport();

test("TUI sidebar renders inbox and outbox using the OpenTUI renderer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "envoy-tui-"));
  const old = process.env.XDG_STATE_HOME;
  const oldRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_STATE_HOME = dir;
  process.env.XDG_RUNTIME_DIR = path.join(dir, "runtime");
  let renderer;
  try {
    for (const [letter, incoming] of [["a", true], ["b", false]] as const) {
      const id = letter.repeat(32);
      const folder = path.join(dir, "herdr-envoy", "sessions", id);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, "coordinator.json"), JSON.stringify({ jobId: id, mode: "interactive", createdAt: 1,
        directory: incoming ? "/sender" : dir, worktree: incoming ? dir : "/target", sessionID: incoming ? "sender" : "me",
        name: "Review agent", existing: { sessionID: incoming ? "me" : "target" } }));
      await fs.writeFile(path.join(folder, "session.json"), JSON.stringify({ status: "active" }));
    }
    const { default: plugin } = await import("../dist/tui.jsx");
    let slot;
    const api = { state: { path: { directory: dir } }, theme: { current: { text: "white", textMuted: "gray", warning: "yellow", primary: "cyan" } },
      slots: { register(value) { slot = value.slots.sidebar_content; } } };
    await plugin.tui(api);
    const view = await testRender(() => slot({}, { session_id: "me" }), { width: 42, height: 24 });
    renderer = view.renderer;
    await view.waitForFrame((text) => text.includes("Inbox (1)") && text.includes("Outbox (1)"));
    const frame = view.captureCharFrame();
    expect(frame).toContain("queued");
    expect(frame).toContain("sender");
    expect(frame).toContain("Review agent");
    const clickText = async (text: string) => {
      const lines = view.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes(text));
      expect(y).toBeGreaterThanOrEqual(0);
      await view.mockMouse.click(lines[y].indexOf(text), y);
      await view.renderOnce();
    };
    await clickText("Inbox (1)");
    expect(view.captureCharFrame()).toContain("> Inbox (1)");
    expect(view.captureCharFrame()).not.toContain("sender");
    expect(view.captureCharFrame()).toContain("Review agent");
    await clickText("Outbox (1)");
    expect(view.captureCharFrame()).not.toContain("Review agent");
    await clickText("Inbox (1)");
    expect(view.captureCharFrame()).toContain("sender");
    await clickText("Envoy (2)");
    expect(view.captureCharFrame()).toContain("> Envoy (2)");
    expect(view.captureCharFrame()).not.toContain("Inbox");
    await clickText("Envoy (2)");
    expect(view.captureCharFrame()).toContain("Inbox (1)");
  } finally {
    renderer?.destroy();
    if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old;
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
