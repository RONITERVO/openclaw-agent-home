# Native OpenClaw Plugin Conversion

This local MVP should convert into a native OpenClaw plugin named `agent-home`.

Agent Home is not a second Control UI. OpenClaw Control is the interactive
cockpit for chats, settings, auth, nodes, plugins, pairing, logs, and
troubleshooting. Agent Home is the passive room display: one zero-click,
zero-scroll, privacy-safe screen that shows whether the agent is quiet, working,
or needs the human.

## Plugin Identity

```json
{
  "id": "agent-home",
  "name": "Agent Home Display",
  "description": "Ambient second-screen status display for OpenClaw agents",
  "activation": {
    "onStartup": true
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "privacyMode": {
        "type": "string",
        "enum": ["ambient", "work", "private"],
        "default": "ambient"
      },
      "refreshMs": {
        "type": "number",
        "default": 10000
      },
      "agentName": {
        "type": "string"
      },
      "workspaceName": {
        "type": "string"
      },
      "workboard": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "enabled": { "type": "boolean", "default": false }
        }
      }
    }
  }
}
```

## Gateway Surface

Target route:

```text
GET /__openclaw__/agent-home/
```

Target RPC:

```text
agentHome.snapshot
```

The browser should fetch one redacted snapshot. UI components should not call
raw Gateway methods independently.

Current bridge files:

- `openclaw.plugin.json` declares native plugin identity/config.
- `package.json#openclaw.extensions` points to `src/plugin.mjs`.
- `src/plugin.mjs` registers the authenticated route and `agentHome.snapshot`.
- `src/server.mjs` now exports `collectSnapshot()` and only starts the
  standalone server when executed directly.

The standalone MVP remains the verified runtime today. The native plugin entry
is plugin-loader code and should be validated with `openclaw plugins inspect
agent-home --runtime --json` after installing or pinning this package through
OpenClaw plugin config. Direct `node src/plugin.mjs` is not the validation path
because the OpenClaw loader owns the plugin SDK import context.

The ideal handoff is: glance at Agent Home, then open Control UI only when a
signal actually needs operator action. Agent Home should reuse Gateway
auth/session state and must not embed tokens in launcher args, query strings, or
static config.

## Collector Mapping

Current MVP collector:

- `openclaw status --deep --json`
- `openclaw sessions --all-agents --limit 50 --json`
- `openclaw tasks list --json`
- `openclaw cron status`
- `openclaw cron list --json`
- `openclaw security audit --deep`
- Windows posture through PowerShell

Plugin collector target:

- Gateway status/health methods instead of CLI subprocesses
- sessions list method
- tasks list method
- cron status/list methods
- channel connectivity and transport freshness
- node service and paired-node status
- loaded plugin list and plugin errors
- model/provider auth or pricing health when useful
- memory/heartbeat state
- optional Workboard methods when plugin is enabled and allowed
- host posture provider as optional platform adapter

## Privacy Rules To Preserve

- Default `ambient` mode.
- No transcript bodies in ambient mode.
- No raw tool arguments.
- No tokens, passwords, auth fragments, API keys, or emails.
- Redaction happens before the snapshot leaves the backend.
- Work/private modes must be explicit config choices.

## Subagent Rules To Preserve

- Group by `childSessionKey` first.
- Merge task rows by `runId`.
- Show `requesterSessionKey -> childSessionKey` relationships.
- If parentage is unknown, group under the agent and mark as unlinked.

## Release Checklist

- Add `openclaw.plugin.json`.
- Add `package.json#openclaw` runtime entry metadata.
- Move `src/server.mjs` normalization into plugin runtime modules.
- Serve `public/` through a plugin HTTP route.
- Add tests for snapshot normalization and redaction.
- Add screenshots from 1920x1080 and 2560x1440.
- Add `SECURITY.md` and `PRIVACY.md`.
- Keep Windows kiosk launcher optional.
