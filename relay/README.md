# sp-ai-bridge relay

Stateless forwarder between the Super Productivity **AI bridge plugin**
(which long-polls via the documented `PluginAPI.request()`) and AI clients
(which talk plain HTTPS REST).

The server stores **no task data** — it only shuffles opaque command envelopes
between one AI client and one plugin instance, keyed by a shared token.
Zero dependencies: plain `node:http` only (`node server.js`).

## Run

```bash
PORT=3877 node server.js
```

## API (all JSON)

| Method & path    | Body                                           | Response |
|------------------|------------------------------------------------|----------|
| `POST /api/register` | `{token}`                                 | `{ok:true}` — creates the token namespace (idempotent) |
| `POST /api/poll`     | `{token}`                                 | `{cmd:{id,name,args}\|null}` — long-poll, held ~25s |
| `POST /api/result`   | `{token,id,ok,result?,error?}`             | `{ok:true, delivered:bool}` |
| `POST /api/cmd`      | `{token,name,args?,timeoutMs?}`            | `{ok:true,result}` or `{ok:false,error}` — waits for the plugin (default 50s, max 110s) |
| `GET /api/health`    | —                                             | `{ok:true, uptime_s, namespaces}` |

Error values for `/api/cmd`: `bad_token`, `device_offline` (no plugin poll
within 60s — fast fail, no waiting), `timeout`, `plugin_error`.

## Security notes

- **TLS is required in production** (e.g. fly.io gives it for free).
  Never run the public endpoint over plain HTTP.
- The token is a **capability**: whoever holds it can issue commands.
  Use a high-entropy token (≥ 32 chars), keep it in the plugin's
  `setSecret()` storage (local-only, never synced) and in the AI client's
  secure vault. Rotate by registering a new token.
- Server logs only the first 6 chars of tokens, never bodies.
- Plugin side: the relay hostname must be listed in the plugin manifest's
  `allowedHosts` (exact match, no wildcards) with the `"http"` permission.

## Deploy (fly.io)

```bash
fly launch --no-deploy
fly deploy
```

Single instance is fine (state is in-memory). No database needed.

## Test

```bash
node test-smoke.js
```
