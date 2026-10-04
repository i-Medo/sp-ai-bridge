/* sp-ai-bridge — plugin.js
 *
 * Relay-based remote task control for Super Productivity.
 *
 * How it works:
 *   1. On first run the plugin generates a high-entropy pairing token and
 *      stores it with PluginAPI.setSecret() (local-only, never synced).
 *   2. It long-polls the relay server via the documented PluginAPI.request()
 *      (raw WebSocket is NOT part of the plugin contract).
 *   3. Commands from the relay are executed through the PluginAPI
 *      (addTask / updateTask / getTasks / ...) and results are POSTed back.
 *   4. The AI client talks to the relay's REST API; the relay holds no data.
 *
 * Before packaging, set DEFAULT_RELAY_URL below AND the matching hostname in
 * manifest.json -> allowedHosts (exact match, no wildcards, fail-closed).
 *
 * Supported commands (Phase 3):
 *   ping            -> {ok, ts, version}
 *   list_tasks      -> [{id,title,isDone,projectId,tagIds,dueDay,notes}]
 *   add_task        {title, notes?, projectId?, tagIds?, dueDay?, timeEstimate?} -> {id}
 *   complete_task   {id, isDone?} -> {id, isDone}
 *   update_task     {id, title?, notes?, dueDay?, timeEstimate?} -> {id, updated[]}
 *   delete_task     {id, confirm:true} -> {id, deleted}   (confirm required)
 *   list_projects   -> [{id,title}]
 *   list_tags       -> [{id,title}]
 *   add_time        {id, minutes} -> {id, timeSpentMs}
 *   notify          {title?, body?} -> {sent}
 *   rotate_token    -> {rotated, token}   (invalidates the old token)
 */
(function () {
  'use strict';

  // === CONFIG: set before packaging ===
  var DEFAULT_RELAY_URL = 'https://REPLACE_WITH_YOUR_RELAY_HOST'; // no trailing slash

  var SECRET_KEY = 'spAiBridge.relayToken';
  var URL_KEY = 'spAiBridge.relayUrl';
  var RETRY_MS = 5000;
  var MAX_RETRY_MS = 60000;
  var VERSION = '0.2.0';

  var stopped = false;
  var status = 'init';
  var cachedToken = null;
  var retryMs = RETRY_MS;

  function log() {
    try {
      PluginAPI.log.info.apply(
        PluginAPI.log,
        ['[sp-ai-bridge]'].concat(Array.prototype.slice.call(arguments))
      );
    } catch (e) {
      /* host without log — ignore */
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function onReadyFn(fn) {
    if (typeof plugin !== 'undefined' && plugin && typeof plugin.onReady === 'function')
      return plugin.onReady(fn);
    if (typeof PluginAPI !== 'undefined' && typeof PluginAPI.onReady === 'function')
      return PluginAPI.onReady(fn);
    fn();
  }

  function onUnloadFn(fn) {
    if (typeof plugin !== 'undefined' && plugin && typeof plugin.onUnload === 'function')
      return plugin.onUnload(fn);
    if (typeof PluginAPI !== 'undefined' && typeof PluginAPI.onUnload === 'function')
      return PluginAPI.onUnload(fn);
  }

  function genToken() {
    var chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    var rnd = new Uint8Array(48);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(rnd);
    } else {
      for (var i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
    }
    var out = '';
    for (var j = 0; j < rnd.length; j++) out += chars[rnd[j] % chars.length];
    return out;
  }

  async function ensureToken() {
    if (cachedToken) return cachedToken;
    var t = null;
    try {
      t = await PluginAPI.getSecret(SECRET_KEY);
    } catch (e) {
      log('getSecret failed:', String((e && e.message) || e));
    }
    if (!t) {
      t = genToken();
      await PluginAPI.setSecret(SECRET_KEY, t);
      log('generated new pairing token');
      try {
        await PluginAPI.showSnack({
          msg: 'AI Bridge: pairing token created — open the AI Bridge header button to view it',
          type: 'INFO',
        });
      } catch (e) {
        /* optional */
      }
    }
    cachedToken = t;
    return t;
  }

  async function getEndpoint() {
    var url = null;
    try {
      url = await PluginAPI.loadSyncedData(URL_KEY);
    } catch (e) {
      /* optional */
    }
    url = String(url || DEFAULT_RELAY_URL || '').replace(/\/+$/, '');
    var token = await ensureToken();
    return { url: url, token: token };
  }

  function relayConfigured(url) {
    return !!url && url.indexOf('REPLACE_WITH') === -1;
  }

  async function relayWith(ep, path, body) {
    if (!relayConfigured(ep.url)) throw new Error('relay_not_configured');
    if (!ep.token) throw new Error('no_token');
    var payload = JSON.stringify(Object.assign({ token: ep.token }, body || {}));
    return PluginAPI.request(ep.url + path, { method: 'POST', body: payload });
  }

  async function relay(path, body) {
    return relayWith(await getEndpoint(), path, body);
  }

  function slimTask(t) {
    return {
      id: t.id,
      title: t.title,
      isDone: !!t.isDone,
      projectId: t.projectId || null,
      tagIds: t.tagIds || [],
      dueDay: t.dueDay || null,
      notes: t.notes ? String(t.notes).slice(0, 500) : null,
    };
  }

  var COMMANDS = {
    ping: function () {
      return Promise.resolve({ ok: true, ts: Date.now(), version: VERSION });
    },
    list_tasks: async function () {
      var tasks = await PluginAPI.getTasks();
      return tasks.map(slimTask);
    },
    add_task: async function (args) {
      args = args || {};
      var title = args.title ? String(args.title).trim() : '';
      if (!title) throw new Error('title_required');
      var data = { title: title };
      if (args.notes) data.notes = String(args.notes);
      if (args.projectId) data.projectId = String(args.projectId);
      if (Array.isArray(args.tagIds)) data.tagIds = args.tagIds.map(String);
      if (args.dueDay) data.dueDay = String(args.dueDay); // YYYY-MM-DD
      if (typeof args.timeEstimate === 'number') data.timeEstimate = args.timeEstimate;
      var id = await PluginAPI.addTask(data);
      return { id: id };
    },
    complete_task: async function (args) {
      args = args || {};
      if (!args.id) throw new Error('id_required');
      var done = args.isDone !== false;
      await PluginAPI.updateTask(String(args.id), { isDone: done });
      return { id: String(args.id), isDone: done };
    },
    list_projects: async function () {
      var ps = await PluginAPI.getAllProjects();
      return ps.map(function (p) {
        return { id: p.id, title: p.title };
      });
    },
    list_tags: async function () {
      var ts = await PluginAPI.getAllTags();
      return ts.map(function (t) {
        return { id: t.id, title: t.title };
      });
    },
    update_task: async function (args) {
      args = args || {};
      if (!args.id) throw new Error('id_required');
      var updates = {};
      if (args.title !== undefined) {
        var t = String(args.title).trim();
        if (!t) throw new Error('title_required');
        updates.title = t;
      }
      if (args.notes !== undefined) updates.notes = String(args.notes);
      if (args.dueDay !== undefined) updates.dueDay = args.dueDay ? String(args.dueDay) : null;
      if (typeof args.timeEstimate === 'number') updates.timeEstimate = args.timeEstimate;
      if (Object.keys(updates).length === 0) throw new Error('nothing_to_update');
      await PluginAPI.updateTask(String(args.id), updates);
      return { id: String(args.id), updated: Object.keys(updates) };
    },
    delete_task: async function (args) {
      args = args || {};
      if (!args.id) throw new Error('id_required');
      if (args.confirm !== true) throw new Error('confirm_required');
      await PluginAPI.deleteTask(String(args.id));
      return { id: String(args.id), deleted: true };
    },
    add_time: async function (args) {
      args = args || {};
      if (!args.id) throw new Error('id_required');
      var minutes = Number(args.minutes);
      if (!(minutes > 0)) throw new Error('minutes_required');
      var tasks = await PluginAPI.getTasks();
      var task = null;
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].id === String(args.id)) task = tasks[i];
      }
      if (!task) throw new Error('not_found');
      var addMs = Math.round(minutes * 60000);
      var perDay = Object.assign({}, task.timeSpentOnDay || {});
      var day = new Date().toISOString().slice(0, 10);
      perDay[day] = (perDay[day] || 0) + addMs;
      var newTotal = (task.timeSpent || 0) + addMs;
      await PluginAPI.updateTask(task.id, { timeSpent: newTotal, timeSpentOnDay: perDay });
      return { id: task.id, timeSpentMs: newTotal };
    },
    notify: async function (args) {
      args = args || {};
      await PluginAPI.notify({
        title: args.title ? String(args.title) : 'AI Bridge',
        body: args.body ? String(args.body) : '',
      });
      return { sent: true };
    },
    rotate_token: async function () {
      cachedToken = genToken();
      await PluginAPI.setSecret(SECRET_KEY, cachedToken);
      log('pairing token rotated via command');
      return { rotated: true, token: cachedToken };
    },
  };

  async function dispatch(cmd) {
    var fn = COMMANDS[cmd.name];
    if (!fn) throw new Error('unknown_command:' + cmd.name);
    return fn(cmd.args || {});
  }

  function setStatus(s) {
    status = s;
    log('status:', s);
  }

  async function pollLoop() {
    while (!stopped) {
      try {
        var ep = await getEndpoint();
        if (!relayConfigured(ep.url)) {
          setStatus('not_configured');
          await sleep(RETRY_MS);
          continue;
        }
        setStatus('online');
        // Pin this poll's endpoint: the result must go back on the same
        // token the command arrived on (matters for rotate_token).
        var res = await relayWith(ep, '/api/poll', {});
        retryMs = RETRY_MS; // success — reset backoff
        if (stopped) break;
        var cmd = res && res.cmd;
        if (cmd && cmd.id) {
          setStatus('working:' + cmd.name);
          var out;
          try {
            out = { ok: true, result: await dispatch(cmd) };
          } catch (e) {
            out = { ok: false, error: String((e && e.message) || e) };
          }
          if (!stopped) {
            try {
              await relayWith(ep, '/api/result', {
                id: cmd.id,
                ok: out.ok,
                result: out.result,
                error: out.error,
              });
            } catch (e) {
              log('result post failed:', String((e && e.message) || e));
            }
          }
          setStatus('online');
        }
      } catch (e) {
        if (stopped) break;
        setStatus('error');
        log('loop error:', String((e && e.message) || e));
        await sleep(retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS); // exponential backoff
      }
    }
    log('poll loop stopped');
  }

  async function showPairingDialog() {
    var ep = await getEndpoint();
    var html =
      '<div style="font-size:14px;line-height:1.7">' +
      '<p><b>Relay:</b> ' +
      escapeHtml(ep.url) +
      '</p>' +
      '<p><b>Status:</b> ' +
      escapeHtml(status) +
      '</p>' +
      '<p>Pairing token — paste it into your AI assistant <b>once</b>:</p>' +
      '<p><input readonly value="' +
      escapeHtml(ep.token || '') +
      '" style="width:100%;font-family:monospace" onclick="this.select()"/></p>' +
      '<p style="opacity:.65">Stored only on this device (never synced). ' +
      'Anyone holding the token can control your tasks.<br/>' +
      'To rotate it, ask your AI assistant to send the <b>rotate_token</b> command.</p>' +
      '</div>';
    try {
      await PluginAPI.openDialog({
        title: 'AI Bridge pairing',
        htmlContent: html,
        okBtnLabel: 'Close',
      });
    } catch (e) {
      log('dialog failed:', String((e && e.message) || e));
    }
  }

  function init() {
    try {
      if (PluginAPI && typeof PluginAPI.registerHeaderButton === 'function') {
        PluginAPI.registerHeaderButton({
          id: 'sp-ai-bridge',
          label: 'AI Bridge',
          icon: 'link',
          onClick: function () {
            showPairingDialog();
          },
        });
      }
    } catch (e) {
      log('header button failed:', String((e && e.message) || e));
    }
    setStatus('starting');
    pollLoop();
  }

  onReadyFn(init);
  onUnloadFn(function () {
    stopped = true;
  });
})();
