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
    "title": "OpenClaw Messages",
    "kicker": "Telegram-origin session",
    "messages": [
      { "actor": "Roni Tervo", "role": "human", "channel": "telegram", "at": "...", "text": "..." }
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
      { "label": "Collectors", "value": "7/7 ok", "status": "ok" }
    ]
  },
  "attention": {
    "count": 0,
    "items": [
      { "severity": "notice", "source": "windows", "title": "BitLocker is off", "reason": "..." }
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
    { "label": "Updated", "value": "2026-06-07T02:00:00.000Z", "status": "active" }
  ]
}
```

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
- 6 visible panels
- 7 sensors
- screenshot at `agent-home-signal-desk-1920-current.png`
