/** @jsxImportSource @opentui/solid */
import { createSignal, createEffect, onCleanup, For, Show } from "solid-js";
import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { readMailbox, type MailItem } from "./mailbox.js";

function Mailbox(props: { api: TuiPluginApi; sessionID: string }) {
  const [mail, setMail] = createSignal<Awaited<ReturnType<typeof readMailbox>>>({ items: [], incomplete: false });
  const [loading, setLoading] = createSignal(true);
  const [expanded, setExpanded] = createSignal(true);
  const theme = props.api.theme.current;
  createEffect(() => {
    const sessionID = props.sessionID;
    const directory = props.api.state.path.directory;
    let disposed = false;
    let busy = false;
    setMail({ items: [], incomplete: false });
    setLoading(true);
    const refresh = async () => {
      if (busy || disposed) return;
      busy = true;
      try {
        const next = await readMailbox(sessionID, directory);
        if (!disposed) { setMail(next); setLoading(false); }
      } catch {
        if (!disposed) { setMail({ items: [], incomplete: true }); setLoading(false); }
      } finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    onCleanup(() => { disposed = true; clearInterval(timer); });
  });
  const detail = (item: MailItem) => {
    const Dialog = props.api.ui.DialogAlert;
    props.api.ui.dialog.replace(() => <Dialog title={`Envoy ${item.direction}: ${item.id.slice(0, 8)}`}
      message={[`State: ${item.state}`, `Peer: ${item.label}`, `Folder: ${item.folder}`, `Request: ${item.id}`,
        `Created: ${new Date(item.createdAt).toISOString()}`, item.summary && `Report:\n${item.summary}`,
        item.checks.length && `Checks:\n${item.checks.join("\n")}`, item.risks.length && `Risks:\n${item.risks.join("\n")}`,
        "Read-only. Completion does not commit or clean up resources."].filter(Boolean).join("\n\n")}
      onConfirm={() => props.api.ui.dialog.clear()} />);
  };
  const picker = (direction: "inbox" | "outbox") => {
    const Select = props.api.ui.DialogSelect;
    props.api.ui.dialog.replace(() => <Select title={`Envoy ${direction}`} options={mail().items.filter((i) => i.direction === direction).map((i) => ({
      title: `${i.state} · ${i.id.slice(0, 8)}`, description: i.label, value: i,
    }))} onSelect={(option) => detail(option.value)} />);
  };
  return <box flexDirection="column" gap={1}>
    <text fg={theme.text} onMouseUp={() => setExpanded((value) => !value)}><b>{expanded() ? "v" : ">"} Envoy ({mail().items.length})</b></text>
    <Show when={expanded()}>
    <Show when={loading()}><text fg={theme.textMuted}>Loading requests...</text></Show>
    <Show when={mail().incomplete}><text fg={theme.warning}>Queue data incomplete</text></Show>
    <For each={["inbox", "outbox"] as const}>{(direction) => {
      const items = () => mail().items.filter((i) => i.direction === direction);
      const [open, setOpen] = createSignal(true);
      return <box flexDirection="column">
        <text fg={theme.text} onMouseUp={() => setOpen((value) => !value)}><b>{open() ? "v" : ">"} {direction === "inbox" ? "Inbox" : "Outbox"} ({items().length})</b></text>
        <Show when={open()}>
        <Show when={!loading() && !items().length}><text fg={theme.textMuted}>No requests</text></Show>
        <For each={items().slice(0, 3)}>{(item) => <box onMouseUp={() => detail(item)} flexDirection="column">
          <text fg={item.state === "unconfirmed" ? theme.warning : theme.primary}>{item.state} · {item.id.slice(0, 8)}</text>
          <text fg={theme.textMuted}>{item.label}</text>
        </box>}</For>
        <Show when={items().length > 0}><text fg={theme.textMuted} onMouseUp={() => picker(direction)}>Browse all ({items().length})</text></Show>
        </Show>
      </box>;
    }}</For>
    </Show>
  </box>;
}

export default {
  id: "herdr-envoy.sidebar",
  tui: async (api) => {
    api.slots.register({ order: 350, slots: {
      sidebar_content: (_ctx, value) => <Mailbox api={api} sessionID={value.session_id} />,
    } });
  },
} satisfies TuiPluginModule;
