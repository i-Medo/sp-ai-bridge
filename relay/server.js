'use strict';
/*
 * sp-ai-bridge relay server
 * -------------------------
 * Stateless forwarder between:
 *   - the Super Productivity "AI bridge" plugin, which long-polls via the
 *     documented PluginAPI.request() (raw WebSocket is NOT part of the
 *     plugin contract), and
 *   - AI clients (e.g. Muse), which talk plain HTTPS REST.
 *
 * The server stores NO task data. It only shuffles opaque command envelopes
 * between one AI client and one plugin instance, keyed by a shared token.
 * The token is a capability: whoever holds it can issue commands.
 *
 * Zero dependencies — plain node:http only.
 *
 * Endpoints (all JSON):
 *   POST /api/register  {token}                       -> {ok:true}
 *   POST /api/poll      {token}                       -> {cmd:{id,name,args}|null}  (long-poll, ~25s)
 *   POST /api/result    {token,id,ok,result?,error?}  -> {ok:true, delivered:bool}
 *   POST /api/cmd       {token,name,args?,timeoutMs?} -> {ok:true,result} | {ok:false,error}
 * On every endpoint the token may alternatively be sent as
 * `Authorization: Bearer <token>` (body.token takes precedence if both).
 *   GET  /api/health                                  -> {ok:true,...}
 */

const http = require('node:http');
const { randomUUID } = require('node:crypto');

const PORT = parseInt(process.env.PORT || '3877', 10);
const POLL_HOLD_MS = 25000;        // max time a poll request is held open
const CMD_DEFAULT_TIMEOUT_MS = 50000;
const CMD_MAX_TIMEOUT_MS = 110000;
const CMD_TTL_MS = 10 * 60 * 1000; // queued commands expire after 10 min
const OFFLINE_AFTER_MS = 60000;    // no poll within this -> device treated as offline
const MAX_BODY_BYTES = 1024 * 1024;
const NS_IDLE_DROP_MS = 24 * 60 * 60 * 1000;

// token -> { queue:[], pollWaiters:Set, pending:Map, lastPollAt:number|null, lastSeen:number }
const namespaces = new Map();
const startedAt = Date.now();

function tokenOk(t) {
  return typeof t === 'string' && t.length >= 32 && t.length <= 256;
}
function shortTok(t) {
  return typeof t === 'string' ? t.slice(0, 6) + '...' : '?';
}
function nsFor(token) {
  let ns = namespaces.get(token);
  if (!ns) {
    ns = { queue: [], pollWaiters: new Set(), pending: new Map(), lastPollAt: null, lastSeen: Date.now() };
    namespaces.set(token, ns);
  }
  ns.lastSeen = Date.now();
  return ns;
}

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        let parsed = JSON.parse(raw);
        // tolerate hosts that JSON-encode an already-stringified body
        if (typeof parsed === 'string') {
          try {
            parsed = JSON.parse(parsed);
          } catch {
            /* keep as-is */
          }
        }
        resolve(parsed);
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function dropExpired(ns) {
  const now = Date.now();
  while (ns.queue.length && now - ns.queue[0].enqueuedAt > CMD_TTL_MS) ns.queue.shift();
}

// Hand queued commands to waiting long-pollers.
function deliver(ns) {
  dropExpired(ns);
  for (const waiter of [...ns.pollWaiters]) {
    const cmd = ns.queue.shift();
    if (!cmd) break;
    if (waiter.done) continue;
    waiter.done = true;
    clearTimeout(waiter.timer);
    ns.pollWaiters.delete(waiter);
    sendJson(waiter.res, 200, { cmd: { id: cmd.id, name: cmd.name, args: cmd.args } });
  }
}

function handlePoll(ns, res) {
  ns.lastPollAt = Date.now();
  dropExpired(ns);
  const cmd = ns.queue.shift();
  if (cmd) {
    return sendJson(res, 200, { cmd: { id: cmd.id, name: cmd.name, args: cmd.args } });
  }
  const waiter = { res, timer: null, done: false };
  waiter.timer = setTimeout(() => {
    if (waiter.done) return;
    waiter.done = true;
    ns.pollWaiters.delete(waiter);
    sendJson(res, 200, { cmd: null });
  }, POLL_HOLD_MS);
  res.on('close', () => {
    if (waiter.done) return;
    waiter.done = true;
    clearTimeout(waiter.timer);
    ns.pollWaiters.delete(waiter);
  });
  ns.pollWaiters.add(waiter);
}

function handleResult(ns, body, res) {
  const p = ns.pending.get(body.id);
  if (!p) return sendJson(res, 200, { ok: true, delivered: false });
  ns.pending.delete(body.id);
  clearTimeout(p.timer);
  if (!p.res.writableEnded) {
    sendJson(
      p.res,
      200,
      body.ok === false
        ? { ok: false, error: String(body.error || 'plugin_error') }
        : { ok: true, result: body.result === undefined ? null : body.result }
    );
  }
  return sendJson(res, 200, { ok: true, delivered: true });
}

function handleCmd(ns, body, res) {
  const now = Date.now();
  if (!ns.lastPollAt || now - ns.lastPollAt > OFFLINE_AFTER_MS) {
    return sendJson(res, 200, { ok: false, error: 'device_offline' });
  }
  if (typeof body.name !== 'string' || !body.name) {
    return sendJson(res, 400, { ok: false, error: 'bad_name' });
  }
  const timeoutMs = Math.min(
    Math.max(parseInt(body.timeoutMs, 10) || CMD_DEFAULT_TIMEOUT_MS, 1000),
    CMD_MAX_TIMEOUT_MS
  );
  const id = randomUUID();
  ns.queue.push({ id, name: body.name, args: body.args && typeof body.args === 'object' ? body.args : {}, enqueuedAt: now });
  deliver(ns);

  const timer = setTimeout(() => {
    if (!ns.pending.has(id)) return;
    ns.pending.delete(id);
    ns.queue = ns.queue.filter((c) => c.id !== id);
    sendJson(res, 200, { ok: false, error: 'timeout' });
  }, timeoutMs);
  res.on('close', () => {
    clearTimeout(timer);
    ns.pending.delete(id);
  });
  ns.pending.set(id, { timer, res });
  // response is sent later, from handleResult or the timeout above
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
      });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, uptime_s: Math.floor((Date.now() - startedAt) / 1000), namespaces: namespaces.size });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

    const body = await readBody(req);
    // Token arrives in the JSON body (phone plugin) or as a Bearer header
    // (server-side clients using a securely stored credential). Body wins if both.
    const authH = req.headers['authorization'] || '';
    const bearer = authH.toLowerCase().startsWith('bearer ') ? authH.slice(7).trim() : '';
    const token = body.token || bearer || '';
    const needsToken = ['/api/register', '/api/poll', '/api/result', '/api/cmd'].includes(url.pathname);
    if (needsToken && !tokenOk(token)) {
      return sendJson(res, 401, { ok: false, error: 'bad_token' });
    }
    const ns = needsToken ? nsFor(token) : null;
    console.log(new Date().toISOString(), req.method, url.pathname, 'tok=' + shortTok(token));

    switch (url.pathname) {
      case '/api/register':
        return sendJson(res, 200, { ok: true });
      case '/api/poll':
        return handlePoll(ns, res);
      case '/api/result':
        if (typeof body.id !== 'string') return sendJson(res, 400, { ok: false, error: 'bad_id' });
        return handleResult(ns, body, res);
      case '/api/cmd':
        return handleCmd(ns, body, res);
      default:
        return sendJson(res, 404, { ok: false, error: 'not_found' });
    }
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: String((err && err.message) || 'bad_request') });
  }
});

// Periodic sweep: drop namespaces idle for 24h (frees memory; token can re-register).
setInterval(() => {
  const now = Date.now();
  for (const [tok, ns] of namespaces) {
    if (now - ns.lastSeen > NS_IDLE_DROP_MS && ns.pending.size === 0) {
      for (const w of ns.pollWaiters) {
        if (!w.done) {
          w.done = true;
          clearTimeout(w.timer);
          sendJson(w.res, 200, { cmd: null });
        }
      }
      namespaces.delete(tok);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`sp-ai-bridge relay listening on :${PORT}`);
});
