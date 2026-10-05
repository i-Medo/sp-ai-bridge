# sp-ai-bridge plugin

Super Productivity plugin (`plugin.js` type — runs in the app renderer) that
long-polls the [relay server](../relay/) via the documented
`PluginAPI.request()` and executes remote task commands through the PluginAPI.

## Files

- `manifest.json` — plugin manifest (permissions are per-method names)
- `plugin.js` — the plugin (poll loop, command dispatch, pairing)

## Packaging

The production relay (`https://sp-ai-bridge-production.up.railway.app`) is
already configured in `plugin.js` (`DEFAULT_RELAY_URL`) and `manifest.json`
(`allowedHosts`). To point at your own relay, change both to its exact
hostname (no wildcards — enforced fail-closed by the host).

## Package & install

```bash
cd plugin && zip -r sp-ai-bridge.zip manifest.json plugin.js
```

In the app: **Settings → Plugins → Choose Plugin File** → select the ZIP.
Works on desktop and mobile.

## Pairing

1. On first run the plugin generates a pairing token and stores it with
   `PluginAPI.setSecret()` — **local-only, never synced or backed up**.
2. Tap the **AI Bridge** header button → the dialog shows the relay URL,
   status, and the token (tap the field to select it for copying).
3. Paste the token into your AI assistant **once**, over a channel you trust.
   Anyone holding the token can control your tasks; re-pair by clearing the
   secret (Phase 3 will add in-app rotation).

## Commands (v0.2.0)

| Command | Args | Result |
|---|---|---|
| `ping` | — | `{ok, ts, version}` |
| `list_tasks` | — | active tasks (slim projection) |
| `add_task` | `title`*, `notes?`, `projectId?`, `tagIds?`, `dueDay?` (YYYY-MM-DD), `dueWithTime?` (epoch ms — shows in Schedule view), `timeEstimate?` (ms) | `{id}` |

> **Scheduling rule (from the app's data model): `dueDay` and `dueWithTime`
> are mutually exclusive — never set both.** For a timed entry pass only
> `dueWithTime` (epoch ms, e.g. `1791132000000`); for an all-day entry pass
> only `dueDay`. Setting both confuses the Schedule/Timeline view.
| `complete_task` | `id`*, `isDone?` (default true) | `{id, isDone}` |
| `update_task` | `id`*, `title?`, `notes?`, `dueDay?`, `dueWithTime?` (epoch ms, `null` clears), `timeEstimate?` | `{id, updated[]}` |
| `delete_task` | `id`*, `confirm:true`* | `{id, deleted}` |
| `list_projects` | — | `[{id, title}]` |
| `list_tags` | — | `[{id, title}]` |
| `add_time` | `id`*, `minutes`* | `{id, timeSpentMs}` |
| `notify` | `title?`, `body?` | `{sent}` — system notification on the phone |
| `rotate_token` | — | `{rotated, token}` — new token, old one invalid immediately |

Unknown commands and validation errors return clean errors — nothing hangs.
`delete_task` refuses without explicit `confirm:true`. Reconnect uses
exponential backoff (5s → 60s max). See [SECURITY.md](../SECURITY.md) for the
threat model and hardening notes.

## Test

```bash
node test-harness.js   # stubs the host, runs real plugin.js vs real relay
```

## Limitations (by design, Phase 2)

- The bridge is live only while the app's WebView is alive. No mobile
  background execution exists for plugins — the relay queues commands
  (`device_offline` fast-fail on the AI side) until the app reconnects.
- `PluginAPI.request` body handling: the plugin sends a JSON string; the
  relay also tolerates a double-encoded body. Verify on-device during
  first real install.
- Test on https://test-app.super-productivity.com/ first — never on real data.
