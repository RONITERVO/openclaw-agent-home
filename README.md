# Agent Home

Zero-click ambient second-screen display for OpenClaw agents.

Agent Home is meant to live beside the existing OpenClaw Control UI, not replace
it. Control UI is the interactive cockpit at `http://127.0.0.1:18789/`. Agent
Home is the room display: a full-screen, no-scroll, privacy-safe answer to
whether the agent is working, waiting, or needs the human.

It should show more than a chat app can show. Telegram shows the conversation.
Agent Home shows the operating context around the conversation: context
pressure, agent/subagent topology, gateway posture, collector health, local
machine posture, heartbeat/cron state, and the current attention queue.

The current visual model is a Signal Desk: a PC-native chat-and-command surface
for OpenClaw. It reads the local session store, shows Telegram-origin messages
and OpenClaw replies, turns tool/PowerShell activity into one active event, and
keeps collector proof visible without needing clicks or scroll.

This is the first local vertical slice. It is intentionally dependency-free:

- Node server reads machine-readable OpenClaw state.
- Browser UI renders one layout-ready view model from `/api/view`.
- Subagent/task relationships are derived from session and task metadata.
- No transcript bodies, tokens, raw tool args, or secrets are shown in ambient mode.
- No clicks, scrolling, forms, tabs, menus, or visible controls.

## Purpose

OpenClaw Control can already provide the deeper operator surface: chats,
settings, auth, nodes, plugins, and interactive troubleshooting. Agent Home uses
the same local facts for a narrower job:

- show the current agent posture as `Quiet`, `Working`, or `Needs You`
- surface only the top few attention signals
- show recent Telegram/OpenClaw session messages in compact ambient form
- show tool calls, PowerShell commands, status, duration, and trimmed output
- show file edit state for designers: changed paths, line counts, raw patch
  text, and Git hunks when a baseline exists
- show local safety posture that matters on an always-visible screen
- show verification, jobs, collector flow, and local sensor state in one frame
- stay useful from across the room on a second monitor

## Run

```powershell
cd C:\Users\ronit\.openclaw\workspace\agent-home
npm start
```

Open:

```text
http://127.0.0.1:18880/
```

Or use the helper:

```powershell
.\scripts\Open-AgentHome.ps1 -Fullscreen
```

The display refreshes itself. The user should not need keyboard shortcuts or
manual interaction after launch.

## Snapshot

```powershell
npm run snapshot
```

Designer-friendly UI data:

```text
http://127.0.0.1:18880/api/view
```

Raw collector data:

```text
http://127.0.0.1:18880/api/snapshot
```

The snapshot currently collects:

- `openclaw status --deep --json`
- `openclaw sessions --all-agents --limit 50 --json`
- `openclaw tasks list --json`
- `openclaw cron status`
- `openclaw cron list --json`
- `openclaw security audit --deep`
- Windows posture when available
- the latest OpenClaw session transcript JSONL
- the latest OpenClaw trajectory JSONL for tool/command events
- Git workspace status/diff for `agent-home`

The existing Control UI/Gateway can eventually replace the subprocess adapter
with authenticated Gateway route/RPC data for the same categories: gateway
health, channel state, sessions, tasks/subagents, cron, node status, plugin
health, memory/heartbeat status, and model/provider status.

## Release Direction

The local server is an MVP adapter. The release target is a native OpenClaw plugin
with a Gateway route and an `agentHome.snapshot` method.

See [docs-plugin-conversion.md](docs-plugin-conversion.md).

For UI-only handoff, see [DESIGNER-HANDOFF.md](DESIGNER-HANDOFF.md).

Release and safety notes:

- [PRIVACY.md](PRIVACY.md)
- [SECURITY.md](SECURITY.md)
- [RELEASE.md](RELEASE.md)
