// index.ts — single plugin, dual role (spec §12). Both coordinator and delegate
// are opencode processes running this same code; JOBDIR_ENV decides the role.
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { JOBDIR_ENV } from "./protocol.js";
import { consume, completeTool, askTool, readTaskTool, startHeartbeat, type DelegateState } from "./delegate.js";
import { Coordinator, delegateTool, reapTool, replyTool } from "./coordinator.js";
import { DELEGATE_COMMAND_NAME, delegateCommand } from "./command.js";
import { provisionSkill } from "./skill.js";

export const PeerDelegate: Plugin = async ({ $, client }) => {
  const delegateJobDir = process.env[JOBDIR_ENV];

  // ---- DELEGATE ROLE ----
  if (delegateJobDir) {
    let state: DelegateState = { jobDir: delegateJobDir, task: null, consumed: null };
    try {
      state = await consume(delegateJobDir);
    } catch (err) {
      // Fail closed but keep the agent usable; the coordinator will time out.
      console.error(`peer-delegate(delegate): ${(err as Error).message}`);
    }

    const hooks: Hooks = {
      tool: {
        read_task: readTaskTool(state),
        complete: completeTool(state),
        ask: askTool(state),
      },
    };
    // Mid-run heartbeat so the coordinator can tell "working" from "crashed".
    const stopHeartbeat = startHeartbeat(delegateJobDir);
    hooks.dispose = async () => stopHeartbeat();
    // Task delivery is handled entirely at launch: the coordinator boots this
    // delegate with `opencode --agent X --auto --prompt <task>`, which starts the
    // first turn automatically. No in-process injection needed (a fresh TUI has
    // no session to promptAsync into until a turn starts — verified in trial).
    return hooks;
  }

  // ---- COORDINATOR ROLE ----
  const coord = new Coordinator($, client);

  // Self-provision the coordinator skill (SKILL.md in the user's config dir).
  // Skills can't be injected via the config hook like commands, so we write the
  // file if missing (idempotent; never overwrites user edits).
  await provisionSkill();

  const hooks: Hooks = {
    tool: {
      delegate: delegateTool(coord),
      reap_delegate: reapTool(coord),
      reply_delegate: replyTool(coord),
    },
    // Ship the coordinator `/delegate` command WITH the plugin: inject it into
    // the config `command` map on load (no file install; agents stay the user's).
    // Don't clobber a user-defined command of the same name.
    async config(config) {
      const cfg = config as { command?: Record<string, unknown> };
      cfg.command ??= {};
      if (!(DELEGATE_COMMAND_NAME in cfg.command)) {
        cfg.command[DELEGATE_COMMAND_NAME] = delegateCommand;
      }
    },
    // Drain the async event queue at safe points (between turns). Never blocks
    // the user's current turn; surfaces completions as they arrive (spec §13).
    async event({ event }) {
      if (event.type === "session.idle") {
        coord.setSessionId(event.properties.sessionID);
        for (const ev of coord.drain()) {
          await coord.surface(ev);
        }
      }
    },
    async dispose() {
      coord.dispose();
    },
  };
  return hooks;
};

export default PeerDelegate;
