# Security review — sp-ai-bridge (v0.2.0)

Date: 2026-10-04. Scope: `relay/server.js` + `plugin/plugin.js` + `plugin/manifest.json`.

## Trust model

- **The pairing token is a bearer capability.** Whoever holds it can issue
  any exposed command (add/complete/update/delete tasks, read everything,
  rotate the token). There are no scopes or roles in v0.2.0.
- **The relay is trusted with metadata, not data at rest.** It never writes
  task data to disk, but command names/args pass through its memory while
  forwarding. Run it on infrastructure you trust, always behind TLS.

## What is protected

- Token on device: stored via `PluginAPI.setSecret()` — local-only, excluded
  from Super Productivity sync, exports and backups (per upstream docs).
  It is, however, **stored unencrypted at rest** (upstream is explicit about
  this) — the guarantee is "stays on this device", not hardware encryption.
- Token in transit: never in URLs (POST bodies only); server logs only the
  first 6 chars; bodies are never logged.
- Relay auth: tokens < 32 chars are rejected outright (`bad_token`).
- Network egress is fail-closed: the plugin declares `"http"` permission
  **and** an exact-match `allowedHosts` entry; anything else is rejected by
  the host. No wildcards.
- Destructive op guard: `delete_task` requires `confirm:true`, otherwise it
  is refused. (Read the arg twice before scripting deletes.)
- Rotation: `rotate_token` invalidates the old token immediately — the
  plugin's next poll uses the new one, and the old namespace goes
  `device_offline`. The rotation *result* is pinned to the old token's
  request so the AI reliably receives the new value.

## Known limitations / accepted risks

- **No end-to-end encryption (v0.2.0).** TLS protects client↔relay, but the
  relay process sees plaintext envelopes. A future version could add
  NaCl-box E2E between plugin and AI client so the relay is blind.
- **Token at rest is unencrypted** on the phone (upstream limitation).
  Mitigation: OS-level device encryption, rotate periodically.
- **No rate limiting on the relay.** A token holder can flood commands.
  Mitigation: single-tenant deployment per user; add per-token rate limits
  before any multi-user hosting.
- **No audit log yet.** The relay logs only method/path/token-prefix.
  Consider a per-token append-only command log (names + timestamps, no args)
  for the "who did what" story.
- **Mobile WebView lifetime.** The bridge is alive only while the app's
  WebView is alive; there is no plugin API for background execution or
  foreground services. Commands queue server-side (`device_offline`
  fast-fail) until reconnect. This is a platform constraint, not a bug.
- **Plugin runs unsandboxed** in the renderer (upstream design). Only
  install plugin ZIPs from sources you trust — this one included.

## Recommendations before real-world use

1. Deploy the relay behind TLS only (fly.io default) — never plain HTTP.
2. Generate the token on-device (the plugin does this); transfer it to the
   AI assistant over a trusted channel; store it in the assistant's secure
   vault, never in chat logs or code.
3. Rotate the token after any suspected exposure (`rotate_token`).
4. First install on https://test-app.super-productivity.com/, never on
   real data — per upstream plugin docs.
