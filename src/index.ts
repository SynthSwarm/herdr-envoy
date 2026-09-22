// index.ts — single plugin, dual role (spec §12). Both coordinator and delegate
// are opencode processes running this same code; JOBDIR_ENV decides the role.
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { JOBDIR_ENV } from "./protocol.js";
import { consume, completeTool, askTool, readTaskTool, handBackTool, startHeartbeat, type DelegateState } from "./delegate.js";
import { Coordinator, delegateTool, reapTool, replyTool, openSessionTool, listSessionsTool, resumeSessionTool } from "./coordinator.js";
import { DELEGATE_COMMAND_NAME, delegateCommand } from "./command.js";
import { provisionSkill } from "./skill.js";

export const PeerDelegate: Plugin = async ({ $, client, directory }) => {
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
        ...(state.consumed?.mode === "interactive" ? { hand_back: handBackTool(state) } : {
          complete: completeTool(state), ask: askTool(state),
        }),
      },
    };
    // Mid-run heartbeat so the coordinator can tell "working" from "crashed".
    const stopHeartbeat = state.consumed?.mode === "interactive" ? () => {} : startHeartbeat(delegateJobDir);
    hooks.dispose = async () => stopHeartbeat();
    // Task delivery: the coordinator boots this delegate with a TINY launch
    // prompt ("call read_task first") — see coordinator.spawnDelegate. The full
    // task lives in the handoff already consumed above (state.task) and is served
    // back via the `read_task` tool, keeping arbitrary task text off the command
    // line entirely. No in-process prompt injection is needed.
    return hooks;
  }

  // ---- COORDINATOR ROLE ----
  const coord = new Coordinator($, client, directory);
  await coord.recover();

  // Self-provision the coordinator skill (SKILL.md in the user's config dir).
  // Skills can't be injected via the config hook like commands, so we write the
  // file if missing (idempotent; never overwrites user edits).
  await provisionSkill();

  const hooks: Hooks = {
    tool: {
      delegate: delegateTool(coord),
      reap_delegate: reapTool(coord),
      reply_delegate: replyTool(coord),
      open_session: openSessionTool(coord),
      list_sessions: listSessionsTool(coord),
      resume_session: resumeSessionTool(coord),
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
    async dispose() {
      await coord.dispose();
    },
  };
  return hooks;
};

export default PeerDelegate;
