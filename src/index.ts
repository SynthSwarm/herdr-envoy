// index.ts — single plugin, dual role (spec §12). Both coordinator and delegate
// are opencode processes running this same code; JOBDIR_ENV decides the role.
import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { JOBDIR_ENV } from "./protocol.js";
import { consume, completeTool, askTool, startHeartbeat, type DelegateState } from "./delegate.js";
import { Coordinator, delegateTool, reapTool, replyTool, openSessionTool, listSessionsTool, resumeSessionTool } from "./coordinator.js";
import { DELEGATE_COMMAND_NAME, delegateCommand } from "./command.js";
import { provisionSkill } from "./skill.js";
import { listMachinesTool } from "./discovery.js";
import { existingRequests } from "./requests.js";
import { tool } from "@opencode-ai/plugin";

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

    const requests = existingRequests($, client, directory, state);
    const hooks: Hooks = {
      tool: {
        read_task: requests.read_task,
        hand_back: requests.hand_back,
        ...(state.consumed?.mode === "interactive" ? {} : {
          complete: completeTool(state), ask: askTool(state),
        }),
      },
    };
    // Mid-run heartbeat so the coordinator can tell "working" from "crashed".
    const stopHeartbeat = state.consumed?.mode === "interactive" ? () => {} : startHeartbeat(delegateJobDir);
    hooks.dispose = async () => { stopHeartbeat(); await requests.dispose(); };
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
  const requests = existingRequests($, client, directory);

  const hooks: Hooks = {
    tool: {
      list_machines: listMachinesTool(),
      request_agent: tool({
        description: "Queue a request for an existing local OpenCode pane. Requires the updated Envoy plugin in the target. No terminal input, abort, remote targeting or resource ownership transfer. Delivery waits for idle and earlier requests' handback; a simultaneous user submission can race the idle check.",
        args: { paneId: tool.schema.string(), sessionId: tool.schema.string().describe("Expected conversation ID from Local discovery, checked before enqueueing."), task: tool.schema.string().min(1) },
        execute: ({ paneId, sessionId, task }, ctx) => coord.requestAgent(paneId, task, ctx.sessionID, sessionId),
      }),
      cancel_request: tool({
        description: "Retire an existing-agent request from its delivery queue. Does not interrupt or retract already-submitted work or touch the agent's resources. Use to release a stuck or unwanted request.",
        args: { jobId: tool.schema.string() },
        execute: ({ jobId }, ctx) => coord.cancelRequest(jobId, ctx.sessionID),
      }),
      read_task: requests.read_task,
      hand_back: requests.hand_back,
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
      await requests.dispose();
      await coord.dispose();
    },
  };
  return hooks;
};

export default PeerDelegate;
