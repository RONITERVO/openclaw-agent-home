# Privacy

Agent Home is designed for an always-visible monitor. The default privacy model
is intentionally conservative.

## Ambient Defaults

The display should not show:

- transcript bodies
- raw tool arguments
- tokens, passwords, API keys, bearer headers, or auth fragments
- email addresses
- full local file contents

The display may show:

- gateway health and local bind posture
- channel connected/offline state
- session kind, model, runtime, recency, and context pressure
- task/subagent status and short redacted summaries
- cron/heartbeat status
- high-level Windows posture, when available

## Local-Only MVP

The standalone MVP binds to `127.0.0.1` on port `18880`. It is meant for the
local machine only.

Do not bind the standalone server to `0.0.0.0` unless you also put it behind an
authenticating private ingress you control.

## Plugin Target

The native plugin target serves Agent Home through the OpenClaw Gateway route:

```text
/__openclaw__/agent-home/
```

That route should use Gateway auth. Launcher shortcuts should not embed Gateway
tokens in command-line arguments, query strings, or config files.

## Redaction

The backend performs basic string redaction before snapshot text reaches the
browser. Redaction is a guardrail, not a license to send sensitive content to
the display. New collectors should prefer structured, privacy-safe fields over
redacting large raw blobs after the fact.
