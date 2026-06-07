# Security And Privacy

Agent Home is intended for a trusted local display, not a public dashboard.

Current MVP defaults:

- Binds to `127.0.0.1`.
- Shows `ambient` privacy mode.
- Does not render transcript bodies.
- Does not render raw tool arguments.
- Redacts obvious tokens, passwords, bearer strings, API-key-like fields, and email addresses from text summaries.
- Reads OpenClaw state through local commands and Windows posture through local PowerShell.
- Reads Windows process transparency through local PowerShell/CIM and
  `Get-NetTCPConnection`; command lines are redacted before they reach the
  snapshot.

Do not expose this server directly to a LAN, tailnet, or the public internet.
The release target should be an authenticated OpenClaw Gateway plugin route.

Before public release:

- Move snapshot collection into native OpenClaw plugin runtime.
- Serve UI through Gateway auth.
- Add automated redaction tests.
- Add explicit privacy modes.
- Document what each mode can show.
- Add regression tests for process command-line redaction and ETA confidence
  behavior.
