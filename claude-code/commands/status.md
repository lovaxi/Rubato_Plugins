---
description: Show Rubato plugin status (MQTT config, daemon health, publish counters)
allowed-tools: Bash(node:*), PowerShell(node:*)
---

Report the current Rubato desk-device plugin status.

Run the status inspector with your shell tool:

- Bash: `node "${CLAUDE_PLUGIN_ROOT}/tools/status.mjs"`
- PowerShell: `node "${CLAUDE_PLUGIN_ROOT}/tools/status.mjs"`

Then summarize the JSON output for the user in a short table:

1. **Config**: `configured` / `enabled`, `clientId` (the CC-RUBATO-… identity), `topic`, `host`. If `setupHint` is present, show it verbatim — it explains exactly how to finish setup.
2. **Daemon**: `daemon.running`, `daemon.published` / `daemon.failed`, `daemon.lastPublish` (include `detail` when `ok` is false — it carries the MQTT failure reason).

Do not print the JSON blob itself; keep the answer compact. User-side plugins
keep no local archive (spec §5), so there are no records or calibration to
report; deeper troubleshooting relies on the desk device and the EMQX console.
