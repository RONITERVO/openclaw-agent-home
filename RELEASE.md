# Release Notes

## 0.1.0

Agent Home 0.1.0 is a working local MVP plus a native OpenClaw plugin bridge.

### What Ships

- Full-screen zero-click ambient display.
- No scroll, no forms, no tabs, no visible controls.
- Signal Desk layout that uses the fullscreen surface for OpenClaw messages,
  one active command event, PowerShell/tool transparency, proof cards,
  file edits, attention signals, and compact sensor state.
- Designer-friendly `/api/view` endpoint that exposes layout-ready sections
  without requiring the frontend to understand OpenClaw internals.
- UI-only handoff guide in `DESIGNER-HANDOFF.md`.
- Privacy-safe snapshot model for always-visible screens.
- Programmatic OpenClaw collectors:
  - gateway status
  - sessions across agents
  - tasks and subagent relationships
  - cron and heartbeat state
  - security audit summary
  - Windows posture when available
  - latest session transcript messages
  - latest trajectory tool calls/results
  - Git workspace status/diff plus raw patch text for file-edit visibility
- Standalone local server on `127.0.0.1:18880`.
- Edge launcher helper for kiosk-style second-monitor use.
- Native plugin scaffold:
  - `openclaw.plugin.json`
  - `package.json#openclaw.extensions`
  - `src/plugin.mjs`
  - authenticated route target `/__openclaw__/agent-home/`
  - Gateway method `agentHome.snapshot`

### Verified

- `npm run snapshot`
- `npm run verify:win`
- standalone HTTP health route
- 1920x1080 rendered screenshot
- 1920x1080 DOM overflow check: no horizontal or vertical document overflow
- Screenshot proof: `agent-home-signal-desk-1920-current.png`

### Known Gaps

- Native plugin route is scaffolded but not installed into this OpenClaw runtime
  yet.
- Snapshot collection still uses CLI subprocesses in the standalone MVP.
- Release plugin should replace CLI subprocesses with in-process Gateway/plugin
  APIs where those APIs are stable and public.
- Windows second-monitor placement is browser/launcher based, not a native
  monitor-placement companion.

### Design Position

OpenClaw Control UI is the cockpit. Agent Home is the zero-click Signal Desk.

Agent Home should answer:

- Quiet
- Working
- Needs You
- What just happened in chat
- What command/tool is active
- Which proof source backs the current state
