# sp-ai-bridge

Relay-based **AI bridge for [Super Productivity](https://github.com/super-productivity/super-productivity)** — lets a paired AI assistant list, add, complete, update and delete tasks, track time, and send notifications, directly from chat. No desktop PC required: the phone app connects outbound to a tiny relay server.

```
Phone (Super Productivity + AI Bridge plugin)
   |  long-poll via PluginAPI.request()   (outbound — no open ports, no VPN)
   v
Relay server (stateless forwarder, no data stored)
   |  HTTPS REST
   v
AI assistant (Muse, etc.)
```

## Components

- [`relay/`](./relay/) — single-file Node.js server (zero dependencies).
  Forwards opaque command envelopes between one plugin instance and one AI
  client, keyed by a pairing token. Holds no task data.
- [`plugin/`](./plugin/) — Super Productivity plugin (`plugin.js` type, runs
  in-app). Long-polls the relay, executes commands through the documented
  PluginAPI, posts results back. Installs from a ZIP via
  Settings → Plugins. 11 commands in v0.2.0.
- [`SECURITY.md`](./SECURITY.md) — threat model, hardening notes, and
  recommendations before real-world use.

## Quick start

1. Deploy `relay/` somewhere with TLS (fly.io, Render, …).
2. In `plugin/plugin.js` set `DEFAULT_RELAY_URL`; in `plugin/manifest.json`
   set `allowedHosts` to the relay's exact hostname.
3. Zip `plugin/` (`manifest.json` at root) → install via Settings → Plugins.
4. Open the **AI Bridge** header button → copy the auto-generated pairing
   token → give it to your AI assistant once.

## Status

v0.2.0 — built and tested end-to-end (plugin ↔ relay round-trips verified
with stubbed host; 18/18 checks pass). Real-device testing pending.

## Notes

- The bridge is live while the app's WebView is alive; commands queue
  server-side while the phone is offline (a platform constraint for plugins —
  no background execution API exists).
- This is an independent community project, not affiliated with the
  Super Productivity maintainer.

## License

MIT
