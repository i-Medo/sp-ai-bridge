'use strict';
/*
 * Harness for the sp-ai-bridge plugin.
 * Stubs the Super Productivity plugin host (plugin/PluginAPI globals),
 * loads the REAL plugin.js, and drives it against the REAL relay server.
 * Verifies the full AI -> relay -> plugin -> relay -> AI round-trip.
 *
 * Run: node test-harness.js
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PORT = 3881;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error('FAIL:', msg);
  } else {
    console.log('ok:', msg);
  }
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'relay', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => process.stdout.write('[relay] ' + d));
  await sleep(700);

  // ---------- stub host ----------
  const secrets = {};
  const synced = { 'spAiBridge.relayUrl': BASE }; // as if the user configured it
  const tasks = [];
  let taskSeq = 0;
  const projects = [{ id: 'p1', title: 'Inbox' }];
  const readyCbs = [];

  global.plugin = {
    onReady: (fn) => readyCbs.push(fn),
    onUnload: () => {},
  };
  global.PluginAPI = {
    log: {
      info: (...a) => console.log('[plugin]', ...a),
      warn: (...a) => console.log('[plugin:warn]', ...a),
      error: (...a) => console.log('[plugin:error]', ...a),
      debug: () => {},
      verbose: () => {},
      normal: (...a) => console.log('[plugin]', ...a),
      critical: (...a) => console.log('[plugin]', ...a),
      err: (...a) => console.log('[plugin:error]', ...a),
    },
    request: async (url, opts) => {
      const r = await fetch(url, {
        method: (opts && opts.method) || 'GET',
        headers: { 'content-type': 'application/json' },
        body: opts && opts.body,
      });
      return r.json();
    },
    getTasks: async () => tasks.filter((t) => !t.isDone).map((t) => ({ ...t })),
    addTask: async (d) => {
      const id = 't' + ++taskSeq;
      tasks.push({
        id,
        title: d.title,
        notes: d.notes,
        isDone: false,
        projectId: d.projectId || null,
        tagIds: d.tagIds || [],
        dueDay: d.dueDay || null,
        dueWithTime: d.dueWithTime || null,
      });
      return id;
    },
    updateTask: async (id, u) => {
      const t = tasks.find((t) => t.id === id);
      if (!t) throw new Error('not_found');
      Object.assign(t, u);
    },
    deleteTask: async (id) => {
      const i = tasks.findIndex((t) => t.id === id);
      if (i === -1) throw new Error('not_found');
      tasks.splice(i, 1);
    },
    notify: async () => {},
    getAllProjects: async () => projects.map((p) => ({ ...p })),
    getAllTags: async () => [],
    getSecret: async (k) => secrets[k] || null,
    setSecret: async (k, v) => {
      secrets[k] = v;
    },
    loadSyncedData: async (k) => synced[k] || null,
    persistDataSynced: async (d, k) => {
      synced[k || ''] = d;
    },
    registerHeaderButton: (cfg) => {
      console.log('[plugin] header button registered:', cfg.id);
      return { setLabel: () => {} };
    },
    showSnack: async () => {},
    openDialog: async () => {},
  };

  // ---------- load the real plugin ----------
  const code = fs.readFileSync(path.join(__dirname, 'plugin.js'), 'utf8');
  new vm.Script(code, { filename: 'plugin.js' }).runInThisContext();
  for (const fn of readyCbs) await fn();
  await sleep(1000); // let token generate + first poll start

  const token0 = secrets['spAiBridge.relayToken'];
  assert(token0 && token0.length >= 32, 'plugin generated a pairing token');
  let token = token0;

  async function aiCmd(name, args) {
    const r = await fetch(BASE + '/api/cmd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, name, args }),
    });
    return r.json();
  }

  let r = await aiCmd('ping', {});
  assert(r.ok === true && r.result && r.result.version === '0.2.1', 'ping round-trip');

  r = await aiCmd('add_task', { title: 'Buy milk', notes: '2%' });
  assert(r.ok === true && r.result && r.result.id, 'add_task round-trip, id=' + (r.result && r.result.id));

  const DWT = 1791741600000; // fixed epoch ms
  r = await aiCmd('add_task', { title: 'Timed task', dueDay: '2026-10-10', dueWithTime: DWT });
  assert(
    r.ok === true && r.result && r.result.id &&
      tasks.find((t) => t.id === r.result.id).dueWithTime === DWT,
    'add_task with dueWithTime -> stored on task'
  );
  r = await aiCmd('add_task', { title: 'Bad time', dueWithTime: 'not-a-number' });
  assert(r.ok === false, 'add_task with invalid dueWithTime -> clean error');
  r = await aiCmd('update_task', { id: tasks[tasks.length - 1].id, dueWithTime: null });
  assert(
    r.ok === true && tasks[tasks.length - 1].dueWithTime === null,
    'update_task can clear dueWithTime'
  );
  await aiCmd('delete_task', { id: tasks[tasks.length - 1].id, confirm: true }); // clean up

  r = await aiCmd('list_tasks', {});
  assert(
    r.ok === true && Array.isArray(r.result) && r.result.length === 1 && r.result[0].title === 'Buy milk',
    'list_tasks returns the created task'
  );

  const tid = r.result[0].id;
  r = await aiCmd('complete_task', { id: tid });
  assert(r.ok === true && r.result.isDone === true, 'complete_task round-trip');

  r = await aiCmd('list_tasks', {});
  assert(r.ok === true && r.result.length === 0, 'completed task no longer listed as active');

  r = await aiCmd('list_projects', {});
  assert(r.ok === true && r.result.length === 1 && r.result[0].title === 'Inbox', 'list_projects round-trip');

  r = await aiCmd('add_task', {});
  assert(r.ok === false, 'add_task without title -> clean error (no hang)');

  r = await aiCmd('bogus_cmd', {});
  assert(r.ok === false, 'unknown command -> clean error (no hang)');

  // ---- Phase 3: new commands ----
  r = await aiCmd('add_task', { title: 'Write report' });
  const tid2 = r.result.id;
  r = await aiCmd('update_task', { id: tid2, title: 'Write report v2', notes: 'due Friday' });
  assert(r.ok === true && r.result.updated.includes('title'), 'update_task edits fields');

  r = await aiCmd('list_tasks', {});
  assert(r.result.find((t) => t.id === tid2).title === 'Write report v2', 'update persisted');

  r = await aiCmd('delete_task', { id: tid2 });
  assert(r.ok === false, 'delete_task without confirm -> refused');

  r = await aiCmd('delete_task', { id: tid2, confirm: true });
  assert(r.ok === true && r.result.deleted === true, 'delete_task with confirm -> deleted');

  r = await aiCmd('list_tags', {});
  assert(r.ok === true && Array.isArray(r.result), 'list_tags round-trip');

  r = await aiCmd('add_task', { title: 'Timed work' });
  const tid3 = r.result.id;
  r = await aiCmd('add_time', { id: tid3, minutes: 25 });
  assert(r.ok === true && r.result.timeSpentMs === 25 * 60000, 'add_time accumulates ms');

  r = await aiCmd('notify', { title: 'Hello', body: 'from test' });
  assert(r.ok === true && r.result.sent === true, 'notify round-trip');

  r = await aiCmd('rotate_token', {});
  assert(r.ok === true && r.result.rotated === true && r.result.token !== token0, 'rotate_token returns a new token');
  token = r.result.token; // AI adopts the new token
  await sleep(300);
  r = await aiCmd('ping', {});
  assert(r.ok === true, 'new token works after rotation');

  srv.kill();
  console.log(failures ? 'HARNESS FAILED' : 'HARNESS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
