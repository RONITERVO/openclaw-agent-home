# Designer Handoff

Agent Home is split into two layers:

- Backend data adapter: `src/server.mjs`
- Frontend display: `public/index.html`, `public/app.js`, `public/styles.css`

For design work, use the layout-ready endpoint:

```text
http://127.0.0.1:18880/api/view
```

Use the raw endpoint only for debugging:

```text
http://127.0.0.1:18880/api/snapshot
```

Use the process endpoint when designing progress/ETA surfaces:

```text
http://127.0.0.1:18880/api/processes
```

Use the reaction endpoint when designing "what happens next" surfaces:

```text
http://127.0.0.1:18880/api/reaction
```

## View Contract

`/api/view` returns a small JSON object shaped for UI rendering:

```js
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-07T02:00:00.000Z",
  "mode": "quiet | working | needs-you",
  "modeLabel": "Quiet | Working | Needs You",
  "title": "OpenClaw Signal Desk",
  "subtitle": "Agent Home",
  "topPills": [
    { "label": "Gateway ok", "status": "ok" }
  ],
  "conversation": {
    "title": "OpenClaw Conversation",
    "kicker": "Unified local thread // webchat + telegram",
    "scope": "unified-local-sessions",
    "channels": [
      { "id": "webchat", "count": 3, "latestAt": "..." },
      { "id": "telegram", "count": 2, "latestAt": "..." }
    ],
    "messages": [
      { "actor": "Roni Tervo", "role": "human", "channel": "webchat", "at": "...", "text": "..." }
    ]
  },
  "activeEvent": {
    "status": "running | done | failed | warning | quiet",
    "title": "bash command",
    "command": "powershell ...",
    "detail": "C:\\Users\\...",
    "durationMs": 1234
  },
  "terminal": {
    "title": "PowerShell / Tool Transparency",
    "events": [
      { "at": "...", "status": "done", "title": "Security audit ok", "command": "openclaw security audit --deep", "detail": "..." }
    ]
  },
  "proof": {
    "cards": [
      { "label": "Collectors", "value": "8/8 ok", "status": "ok" },
      { "label": "Processes", "value": "0 live", "status": "neutral" },
      { "label": "Disk I/O", "value": "0 B/s", "status": "neutral" }
    ]
  },
  "attention": {
    "count": 0,
    "items": [
      { "severity": "notice", "source": "windows", "title": "BitLocker is off", "reason": "..." }
    ]
  },
  "reactionForecast": {
    "state": "idle | responding | working | scheduled | waiting-for-user",
    "label": "Working; next reaction is after current work returns",
    "confidence": "high | medium | low",
    "nextKnownAt": "2026-06-07T02:30:00.000Z | null",
    "nextKnownLabel": "5m | unknown",
    "knownFutureAvailable": true,
    "items": [
      { "kind": "tool-return", "status": "working", "source": "session-trajectory", "title": "bash is running" }
    ]
  },
  "fileEdits": {
    "title": "File Edits",
    "count": 3,
    "exactHunksAvailable": true,
    "baseline": "Git baseline available; tracked files can include exact hunks.",
    "items": [
      {
        "path": "agent-home/public/app.js",
        "status": "modified",
        "added": 12,
        "removed": 4,
        "rawPatchKind": "git-diff",
        "rawPatchTruncated": false,
        "rawPatch": "diff --git a/agent-home/public/app.js b/agent-home/public/app.js\n...",
        "exactHunks": [
          { "header": "@@ -1,3 +1,5 @@", "lines": [" context", "+added", "-removed"] }
        ]
      }
    ]
  },
  "sensors": [
    { "label": "Proc", "value": "0", "status": "neutral" },
    { "label": "TCP", "value": "56", "status": "active" },
    { "label": "Updated", "value": "2026-06-07T02:00:00.000Z", "status": "active" }
  ]
}
```

## Process Progress Contract

`/api/processes` is deliberately backend-first. It exposes what Windows can
prove without the agent narrating progress:

- redacted process table entries with PID, parent PID, executable, command
  summary, CPU, memory, handles, threads, and disk I/O rates
- TCP socket ownership by process from `Get-NetTCPConnection`
- recent local file activity and file-growth rates under likely workspace,
  Downloads, Desktop, and archive roots
- high-level `activities` for likely user-started processes, transfers, builds,
  and growing output files

Do not invent percent or ETA. Use these fields:

- `activity.progress.bytesDone`
- `activity.progress.bytesTotal`
- `activity.progress.rateLabel`
- `activity.progress.etaLabel`
- `activity.progress.confidence`
- `activity.progress.reason`

If `etaSeconds` is `null`, show the rate/evidence and keep ETA visually
unknown. That is intentional: Windows does not expose universal per-process
network byte totals or final download size through the standard APIs Agent Home
uses.

The raw endpoint can include local paths, process names, redacted command lines,
and remote IP addresses. Keep it as operator telemetry, not a public marketing
dashboard.

## Reaction Forecast Contract

`/api/reaction` and `/api/view.reactionForecast` expose the same backend facts.
This is not a promise generator. It answers what the PC and OpenClaw state can
actually know:

- `tool-return`: an OpenClaw trajectory has a tool call without a matching
  result; the agent can react after that tool returns.
- `running-task` / `queued-task`: task state says work is running or queued.
- `process-completion`: Windows process telemetry sees active work; ETA appears
  only if the activity exposes a trustworthy total.
- `cron-wake` / `cron-job`: cron exposes a concrete next wake/run timestamp.
- `heartbeat`: heartbeat interval and last heartbeat imply a next opportunity,
  but it can still skip.
- `pending-reply`: the latest unified local transcript message is from the
  human and no newer agent message is stored.
- `needs-human`: attention state says the next useful reaction depends on the
  human or an external state change.

Use `knownFutureAvailable`, `nextKnownAt`, and `nextKnownLabel` for countdowns.
If `nextKnownAt` is `null`, show the label/reason instead of inventing a timer.

## Design Rules

- Keep it zero-click, zero-scroll, and one screen at 1920x1080.
- Do not add tabs, menus, forms, hover-only meaning, or hidden panels.
- Preserve all major sections unless replacing them with clearer equivalents:
  top status, conversation, active event, terminal transparency, proof, file edits,
  attention, sensors.
- Text may be truncated, but labels and statuses must stay visible.
- The UI should be understandable from a screenshot by a small vision model.
- Use `/api/view?force=1` when testing fresh data.
- `fileEdits.exactHunks` appears for tracked Git diffs. If the app folder is
  untracked, files are reported as whole-file additions until a baseline commit
  exists.
- `fileEdits.items[].rawPatch` is the raw patch text to render in a design. For
  tracked files it is Git diff text; for untracked text files it is synthesized
  as a new-file patch. It is capped for UI safety; check `rawPatchTruncated`.

## Verify

```powershell
npm run verify:win
```

Expected result:

- no horizontal overflow
- no vertical overflow
- 5 or more visible panels
- 9 sensors
- screenshot at `agent-home-signal-desk-1920-current.png`
