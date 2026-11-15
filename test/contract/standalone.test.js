import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APPROVAL_MESSAGE, BEARER_SECRET } from '../../lib/constants.js';
import { DAEMON_ROUTES, createDaemonClient } from '../../host/daemon.js';
import { clientAddress, startStandalone } from '../../host/standalone.js';
import { startFakeDaemon } from '../helpers/fake-daemon.js';
import { openStack } from '../helpers/standalone.js';

const PREFIX = '/api/plugins/timon-mcp';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const FORBIDDEN = [
  ['DELETE', '/api/missions/abc'],
  ['DELETE', '/api/tasks/abc'],
  ['GET', '/api/agents/abc/config'],
  ['PUT', '/api/agents/abc/config'],
  ['GET', '/api/secrets'],
  ['POST', '/api/secrets'],
  ['GET', '/api/plugins'],
  ['POST', '/api/plugins'],
  ['DELETE', '/api/plugins/timon-mcp'],
  ['POST', '/api/missions/abc/fork'],
  ['POST', '/api/missions/abc/interrupt'],
  ['POST', '/api/missions/abc/steer'],
  ['GET', '/api/missions'],
  ['GET', '/api/tasks'],
  ['PUT', '/api/tasks/abc'],
  ['POST', '/api/tasks/abc/worktree'],
  ['GET', '/api/agents'],
  ['POST', '/api/agents/spawn'],
  ['POST', '/api/missions/delegate'],
  ['GET', '/api/missions/abc/messages/1'],
  ['POST', '/api/admin'],
  ['GET', '/api/mcp-servers'],
  ['GET', '/api/skills'],
  ['GET', '/api/tasks/abc/'],
  ['GET', '/api/missions/abc?x=1'],
  ['GET', '/api/missions/ab%2fcd'],
  ['GET', '/api/missions/../tasks'],
];

test('the daemon client refuses every route outside the closed list', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-mcp-routes-'));
  const token = randomBytes(32).toString('hex');
  const tokenFile = join(dir, 'daemon-token');
  const daemon = await startFakeDaemon({ token });
  const journal = [];
  const client = createDaemonClient({
    origin: daemon.origin,
    tokenFile,
    env: { [BEARER_SECRET]: randomBytes(32).toString('hex') },
    bearerName: BEARER_SECRET,
    journal,
  });
  t.after(async () => {
    await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(DAEMON_ROUTES.length, 5);
  for (const [method, path] of FORBIDDEN) {
    await assert.rejects(() => client.request(method, path), (err) => {
      assert.equal(err.code, 'route_denied');
      assert.equal(err.message, 'daemon route is not allowed');
      assert.equal(String(err.message).includes(token), false);
      return true;
    });
  }
  assert.equal(daemon.requests.length, 0);
  await assert.rejects(
    () => client.request('POST', '/api/missions', { agent: '_main', mission: 'hello' }),
    /daemon token is unreadable/,
  );
  assert.equal(daemon.requests.length, 0);

  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const created = await client.request('POST', '/api/missions', { agent: '_main', mission: 'hello' });
  assert.equal(created.status, 201);
  assert.equal(daemon.requests.length, 1);
  assert.deepEqual(JSON.parse(daemon.requests[0].bodyText), { agent: '_main', mission: 'hello' });
  assert.equal(daemon.requests[0].authorization, `Bearer ${token}`);
  assert.deepEqual(Object.keys(journal[0]).sort(), ['method', 'path', 'status']);
  assert.equal(JSON.stringify(journal).includes(token), false);

  daemon.failNext({ status: 302, redirect: true });
  await assert.rejects(() => client.request('GET', `/api/missions/${created.json.mission_id}`), (err) => {
    assert.equal(err.message, 'daemon is unreachable');
    assert.equal(err.message.includes(token), false);
    return true;
  });
});

test('scope stays on missions and tasks this host created', async (t) => {
  const stack = await openStack(t, { foreignId: 'foreignmission01' });
  const { host, daemon } = stack;

  await assert.rejects(
    () => host.ctx.missions.spawn({ agent: '_main', mission: 'x', model: 'other' }),
    (err) => err.name === 'PluginMissionError' && err.code === 'override_denied',
  );
  await assert.rejects(
    () => host.ctx.missions.spawn({ agent: 'other', mission: 'x' }),
    (err) => err.name === 'PluginMissionError' && err.code === 'invalid',
  );
  await assert.rejects(
    () => host.ctx.missions.send('foreignmission01', 'hello'),
    (err) => err.name === 'PluginMissionError' && err.code === 'not_found',
  );
  assert.equal(await host.ctx.missions.get('foreignmission01'), undefined);
  assert.equal(daemon.requests.length, 0);

  const missionId = await host.ctx.missions.spawn({ agent: '_main', mission: 'first' });
  const second = await host.ctx.missions.spawn({ agent: 'alpha.main', mission: 'second' });
  host.ctx.sql.prepare('UPDATE host_missions SET created_at = ? WHERE id = ?').run(1, missionId);
  const mission = await host.ctx.missions.get(missionId);
  assert.equal(mission.agent_name, '_main');
  assert.equal(mission.status, 'running');
  assert.equal(Object.hasOwn(mission, 'mission'), false);
  assert.equal(Object.hasOwn(mission, 'events'), false);
  const listed = await host.ctx.missions.list();
  assert.equal(listed[0].id, second);
  assert.equal(listed.some((row) => row.id === 'foreignmission01'), false);
  assert.equal(daemon.requests.some((row) => row.path.endsWith('foreignmission01')), false);

  daemon.missions.delete(second);
  const afterGone = await host.ctx.missions.list();
  assert.equal(afterGone.some((row) => row.id === second), false);
  const forgotten = host.ctx.sql.prepare('SELECT id FROM host_missions WHERE id = ?').get(second);
  assert.equal(forgotten, undefined);

  const sent = await host.ctx.missions.send(missionId, 'follow up');
  assert.deepEqual(sent, { resumed: false });
  const sendCall = daemon.requests.find((row) => row.path.endsWith('/send'));
  assert.deepEqual(JSON.parse(sendCall.bodyText), { input: 'follow up' });

  await assert.rejects(
    () => host.ctx.kanban.add({
      project: 'alpha', title: 'T', description: 'D', agent: 'alpha.main', type: 'chore', backend: 'other',
    }),
    (err) => err.name === 'PluginTaskError' && err.code === 'forbidden',
  );
  await assert.rejects(
    () => host.ctx.kanban.add({ project: 'alpha', title: 'T', description: 'D', agent: '_main', type: 'chore' }),
    (err) => err.code === 'invalid',
  );
  await assert.rejects(
    () => host.ctx.kanban.add({ project: 'alpha', title: 'T', description: 'D', agent: 'alpha.main', type: 'code' }),
    (err) => err.code === 'invalid',
  );
  assert.equal(daemon.requests.some((row) => row.path === '/api/tasks'), false);

  const task = await host.ctx.kanban.add({
    project: 'alpha',
    title: 'Write notes',
    description: 'details',
    agent: 'alpha.main',
    type: 'chore',
  });
  assert.equal(task.agent, 'alpha.main');
  assert.equal(task.status, 'PENDING');
  assert.equal(task.effective_backend, undefined);
  assert.equal(task.attachments, undefined);
  const created = daemon.requests.find((row) => row.method === 'POST' && row.path === '/api/tasks');
  assert.deepEqual(JSON.parse(created.bodyText), {
    title: 'Write notes',
    description: 'details',
    agent_name: 'alpha.main',
    type: 'chore',
    project: 'alpha',
  });
  const tasks = await host.ctx.kanban.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, task.id);

  const unknown = await rpc(stack, 'tools/call', {
    name: 'ask_main',
    arguments: { message: 'nope', mission_id: 'not-ours' },
  });
  assert.equal(unknown.body.result.isError, true);
  assert.match(unknown.body.result.content[0].text, /Mission not found/);
});

test('public guards match the daemon and health stays private', async (t) => {
  const stack = await openStack(t, { daemon: false, env: { TIMON_MCP_TRUST_PROXY: '1' } });
  assert.equal(stack.host.address, '127.0.0.1');
  const base = stack.host.baseUrl;

  for (let i = 0; i < 61; i += 1) {
    const health = await rawCall(base, { path: `${PREFIX}/health` });
    assert.equal(health.status, 401);
    assert.deepEqual(health.json, { error: 'unauthorized' });
  }
  const afterHealth = await rawCall(base, { path: `${PREFIX}/oauth/protected-resource` });
  assert.equal(afterHealth.status, 503);
  assert.equal(afterHealth.json.error, 'not_configured');

  const mcpGet = await rawCall(base, { path: `${PREFIX}/mcp` });
  assert.deepEqual(mcpGet.json, { error: 'unauthorized' });
  const outside = await rawCall(base, { path: '/api/secrets' });
  assert.equal(outside.status, 404);

  const one = '203.0.113.10';
  for (let i = 0; i < 60; i += 1) {
    const ok = await rawCall(base, {
      path: `${PREFIX}/oauth/protected-resource`,
      headers: { 'x-real-ip': one },
    });
    assert.equal(ok.status, 503);
  }
  const limited = await rawCall(base, {
    path: `${PREFIX}/oauth/protected-resource`,
    headers: { 'x-real-ip': one },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, 'too_many_attempts');
  assert.ok(limited.headers['retry-after']);
  const other = await rawCall(base, {
    path: `${PREFIX}/oauth/protected-resource`,
    headers: { 'x-real-ip': '203.0.113.11' },
  });
  assert.equal(other.status, 503);

  const tooBig = Buffer.alloc(65537, 0x61);
  const huge = await rawCall(base, {
    method: 'POST',
    path: `${PREFIX}/mcp`,
    headers: {
      'content-type': 'application/json',
      'content-length': String(tooBig.length),
      'x-real-ip': '203.0.113.12',
    },
    body: tooBig,
  });
  assert.equal(huge.status, 413);
  assert.equal(huge.json.code, 'payload_too_large');
  const fit = Buffer.alloc(65536, 0x61);
  const accepted = await rawCall(base, {
    method: 'POST',
    path: `${PREFIX}/mcp`,
    headers: {
      'content-type': 'application/json',
      'content-length': String(fit.length),
      'x-real-ip': '203.0.113.12',
    },
    body: fit,
  });
  assert.notEqual(accepted.status, 413);

  const opaque = await rawCall(base, {
    method: 'POST',
    path: `${PREFIX}/mcp`,
    headers: { origin: 'null', 'content-type': 'application/json', 'x-real-ip': '203.0.113.13' },
    body: '{}',
  });
  assert.equal(opaque.status, 403);
  assert.deepEqual(opaque.json, { error: 'cross-site request refused' });
  const fetched = await rawCall(base, {
    method: 'POST',
    path: `${PREFIX}/mcp`,
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json', 'x-real-ip': '203.0.113.14' },
    body: '{}',
  });
  assert.equal(fetched.status, 403);
  const mismatch = await rawCall(base, {
    method: 'POST',
    path: `${PREFIX}/mcp`,
    headers: {
      origin: 'https://evil.example',
      host: 'mcp.example',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.15',
    },
    body: '{}',
  });
  assert.equal(mismatch.status, 403);
  const same = await rawCall(base, {
    method: 'POST',
    path: `${PREFIX}/mcp`,
    headers: {
      origin: 'https://mcp.example',
      host: 'mcp.example',
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.16',
    },
    body: '{}',
  });
  assert.equal(same.status, 401);
  assert.equal(same.json.message, 'authentication required');
  assert.ok(same.headers['www-authenticate']);

  for (let i = 0; i < 61; i += 1) {
    const refused = await rawCall(base, {
      method: 'POST',
      path: `${PREFIX}/mcp`,
      headers: { origin: 'null', 'content-type': 'application/json', 'x-real-ip': '203.0.113.20' },
      body: '{}',
    });
    assert.equal(refused.status, 403);
  }
  const afterCrossSite = await rawCall(base, {
    path: `${PREFIX}/oauth/protected-resource`,
    headers: { 'x-real-ip': '203.0.113.20' },
  });
  assert.equal(afterCrossSite.status, 503);

  const oversized = await rawCall(base, {
    method: 'POST',
    path: `${PREFIX}/mcp`,
    headers: {
      'content-type': 'application/json',
      'content-length': String(tooBig.length),
      'x-real-ip': '203.0.113.21',
    },
    body: tooBig,
  });
  assert.equal(oversized.status, 413);
  for (let i = 0; i < 60; i += 1) {
    const stillOpen = await rawCall(base, {
      path: `${PREFIX}/oauth/protected-resource`,
      headers: { 'x-real-ip': '203.0.113.21' },
    });
    assert.equal(stillOpen.status, 503);
  }
});

test('spawn, send and task creation share a ceiling and stop before the daemon', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '1' } });
  const missionId = await stack.host.ctx.missions.spawn({ agent: '_main', mission: 'one' });
  const calls = stack.daemon.requests.length;
  await assert.rejects(
    () => stack.host.ctx.missions.send(missionId, 'more'),
    (err) => err.name === 'PluginPolicyError' && err.rule === 'spawn',
  );
  await assert.rejects(
    () => stack.host.ctx.kanban.add({
      project: 'alpha', title: 'T', description: 'D', agent: 'alpha.main', type: 'chore',
    }),
    (err) => err.name === 'PluginPolicyError' && err.rule === 'spawn',
  );
  assert.equal(stack.daemon.requests.length, calls);

  const refused = await rpc(stack, 'tools/call', {
    name: 'ask_main',
    arguments: { message: 'over the ceiling' },
  });
  assert.equal(refused.body.result.isError, true);
  assert.equal(refused.body.result.content[0].text, APPROVAL_MESSAGE);
  const task = await rpc(stack, 'tools/call', {
    name: 'create_task',
    arguments: { project: 'alpha', title: 'Notes', description: 'details' },
  });
  assert.equal(task.body.result.isError, true);
  assert.equal(task.body.result.content[0].text, APPROVAL_MESSAGE);
  assert.equal(stack.daemon.requests.length, calls);
  assert.equal(stack.daemon.requests.some((row) => row.path === '/api/tasks'), false);
  assert.equal(stack.daemon.requests.some((row) => row.path.endsWith('/send')), false);
});

test('the spawn ceiling slides forward with the window', async (t) => {
  let now = 0;
  const stack = await openStack(t, {
    env: { TIMON_MCP_SPAWN_MAX: '1', TIMON_MCP_SPAWN_WINDOW_MS: '1000' },
    now: () => now,
  });
  await stack.host.ctx.missions.spawn({ agent: '_main', mission: 'first' });
  const afterFirst = stack.daemon.requests.length;
  now = 999;
  await assert.rejects(
    () => stack.host.ctx.missions.spawn({ agent: '_main', mission: 'early' }),
    (err) => err.name === 'PluginPolicyError' && err.rule === 'spawn',
  );
  assert.equal(stack.daemon.requests.length, afterFirst);
  now = 1000;
  await stack.host.ctx.missions.spawn({ agent: '_main', mission: 'later' });
  const posts = stack.daemon.requests.filter((row) => row.method === 'POST' && row.path === '/api/missions');
  assert.equal(posts.length, 2);
});

test('list reads at most the 50 newest ids and forgets a 404', async (t) => {
  const stack = await openStack(t);
  const insertMission = stack.host.ctx.sql.prepare(
    'INSERT INTO host_missions (id, agent_name, created_at) VALUES (?, ?, ?)',
  );
  const insertTask = stack.host.ctx.sql.prepare(
    'INSERT INTO host_tasks (id, project, agent_name, title, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 51; i += 1) {
    const id = `m${String(i).padStart(3, '0')}`;
    insertMission.run(id, '_main', i + 1);
    insertTask.run(`t${String(i).padStart(3, '0')}`, 'alpha', 'alpha.main', 't', i + 1);
  }
  const before = stack.daemon.requests.length;
  const missions = await stack.host.ctx.missions.list();
  const tasks = await stack.host.ctx.kanban.list();
  const gets = stack.daemon.requests.slice(before).filter((row) => row.method === 'GET');
  assert.equal(missions.length, 0);
  assert.equal(tasks.length, 0);
  assert.equal(gets.length, 100);
  assert.equal(gets.filter((row) => row.path.startsWith('/api/missions/')).length, 50);
  assert.equal(gets.filter((row) => row.path.startsWith('/api/tasks/')).length, 50);
  assert.equal(gets.some((row) => row.path.endsWith('/m000')), false);
  assert.equal(gets.some((row) => row.path.endsWith('/m050')), true);
  assert.equal(gets.some((row) => row.path.endsWith('/t000')), false);
  assert.equal(stack.host.ctx.sql.prepare('SELECT id FROM host_missions WHERE id = ?').get('m000').id, 'm000');
  assert.equal(stack.host.ctx.sql.prepare('SELECT id FROM host_missions WHERE id = ?').get('m050'), undefined);
  assert.equal(stack.host.ctx.sql.prepare('SELECT id FROM host_tasks WHERE id = ?').get('t000').id, 't000');
  assert.equal(stack.host.ctx.sql.prepare('SELECT id FROM host_tasks WHERE id = ?').get('t050'), undefined);
});

test('a failed start names the cause and leaves the secret out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-mcp-start-'));
  const secret = randomBytes(32).toString('hex');
  const env = { ...process.env };
  delete env.TIMON_MCP_BEARER_TOKEN;
  env.TIMON_MCP_BEARER_TOKEN = secret;
  env.TIMON_MCP_PORT = 'nope';
  env.TIMON_DAEMON_URL = 'http://127.0.0.1:9';
  env.TIMON_DAEMON_TOKEN_FILE = join(dir, 'token');
  env.TIMON_MCP_DB = join(dir, 'state.db');
  const child = spawn(process.execPath, [join(ROOT, 'bin/timon-mcp-standalone.js')], {
    cwd: ROOT,
    env,
    timeout: 4000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(stderr, /TIMON_MCP_PORT is invalid/);
  assert.equal(stdout.includes(secret), false);
  assert.equal(stderr.includes(secret), false);
});

test('a declared oversized body is refused without reading it', async (t) => {
  const stack = await openStack(t, { daemon: false, env: { TIMON_MCP_TRUST_PROXY: '1' } });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for 413')), 1500);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: stack.host.port,
      path: `${PREFIX}/mcp`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(1024 * 1024),
        'x-real-ip': '203.0.113.77',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      const done = () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json });
      };
      res.on('end', done);
      res.on('aborted', done);
    });
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        clearTimeout(timer);
        reject(err);
      }
    });
    req.write('{}');
  });
  assert.equal(result.status, 413);
  assert.equal(result.json.code, 'payload_too_large');
});

test('X-Real-IP is ignored unless the peer is a trusted loopback proxy', async (t) => {
  const stack = await openStack(t, { daemon: false, env: { TIMON_MCP_TRUST_PROXY: 'true' } });
  for (let i = 0; i < 60; i += 1) {
    const ok = await rawCall(stack.host.baseUrl, {
      path: `${PREFIX}/oauth/protected-resource`,
      headers: { 'x-real-ip': `203.0.113.${i % 40}` },
    });
    assert.equal(ok.status, 503);
  }
  const spoofed = await rawCall(stack.host.baseUrl, {
    path: `${PREFIX}/oauth/protected-resource`,
    headers: { 'x-real-ip': '198.51.100.20' },
  });
  assert.equal(spoofed.status, 429);

  const remote = { headers: { 'x-real-ip': '198.51.100.8' }, socket: { remoteAddress: '203.0.113.4' } };
  assert.equal(clientAddress(remote, true), '203.0.113.4');
  const loop = { headers: { 'x-real-ip': '198.51.100.8, 203.0.113.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientAddress(loop, false), '127.0.0.1');
  assert.equal(clientAddress(loop, true), '198.51.100.8');
  assert.equal(clientAddress({
    headers: { 'x-forwarded-for': '198.51.100.9', 'x-real-ip': '198.51.100.8' },
    socket: { remoteAddress: '::1' },
  }, true), '198.51.100.8');
  assert.equal(clientAddress({
    headers: { 'x-real-ip': '203.0.113.9' },
    socket: { remoteAddress: '::ffff:127.0.0.1' },
  }, true), '203.0.113.9');
  assert.equal(clientAddress({
    headers: { 'x-real-ip': '203.0.113.9' },
    socket: { remoteAddress: '::ffff:203.0.113.4' },
  }, true), '::ffff:203.0.113.4');
});

test('a forwarded-for header does not pick the rate bucket', async (t) => {
  const stack = await openStack(t, { daemon: false });
  for (let i = 0; i < 60; i += 1) {
    const ok = await rawCall(stack.host.baseUrl, {
      path: `${PREFIX}/oauth/protected-resource`,
      headers: { 'x-forwarded-for': `198.51.100.${i}` },
    });
    assert.equal(ok.status, 503);
  }
  const limited = await rawCall(stack.host.baseUrl, {
    path: `${PREFIX}/oauth/protected-resource`,
    headers: { 'x-forwarded-for': '203.0.113.99' },
  });
  assert.equal(limited.status, 429);
});

test('configured settings answer the protected-resource metadata', async (t) => {
  const stack = await openStack(t, {
    daemon: false,
    settings: {
      public_url: 'https://mcp.example',
      issuer: 'https://mcp.example',
      resource: 'https://mcp.example/mcp',
    },
  });
  const meta = await rawCall(stack.host.baseUrl, { path: `${PREFIX}/oauth/protected-resource` });
  assert.equal(meta.status, 200);
  assert.equal(meta.json.resource, 'https://mcp.example/mcp');
  assert.deepEqual(meta.json.authorization_servers, ['https://mcp.example']);
});

test('migrations apply once and the state file reopens', async (t) => {
  const stack = await openStack(t, { daemon: false });
  const names = stack.host.ctx.sql.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all().map((row) => row.name);
  for (const name of ['oauth_clients', 'host_missions', 'host_tasks', 'schema_migrations']) {
    assert.ok(names.includes(name), name);
  }
  const pragma = stack.host.ctx.sql.prepare('PRAGMA busy_timeout').get();
  assert.match(JSON.stringify(pragma), /3000/);
  await stack.host.close();
  const again = await startStandalone({
    port: 0,
    daemonUrl: stack.daemonUrl,
    tokenFile: stack.tokenFile,
    dbFile: stack.dbFile,
    env: { [BEARER_SECRET]: stack.bearer },
    journal: [],
    logs: [],
  });
  t.after(() => again.close());
  const count = again.ctx.sql.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
  assert.equal(Number(count.n), 1);
  await again.close();
  await again.close();
});

test('a passed env without a daemon URL does not default to a port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-mcp-url-'));
  try {
    await assert.rejects(
      () => startStandalone({
        env: {},
        port: 0,
        tokenFile: join(dir, 'token'),
        dbFile: join(dir, 'state.db'),
      }),
      /daemon URL is required/,
    );
    await assert.rejects(
      () => startStandalone({
        env: {},
        daemonUrl: 'http://example.com',
        port: 0,
        tokenFile: join(dir, 'token'),
        dbFile: join(dir, 'state.db'),
      }),
      /loopback/,
    );
    await assert.rejects(
      () => startStandalone({
        env: { TIMON_DAEMON_URL: 'http://127.0.0.1:9' },
        port: 70000,
        tokenFile: join(dir, 'token'),
        dbFile: join(dir, 'state.db'),
      }),
      /TIMON_MCP_PORT is invalid/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the token is absent from responses, logs and the journal', async (t) => {
  const stack = await openStack(t, { echoToken: true });
  const spy = spyWrites();
  t.after(() => spy.restore());

  const asked = await rpc(stack, 'tools/call', {
    name: 'ask_main',
    arguments: { message: 'keep the secret out' },
  });
  assert.equal(asked.body.result.isError, false);
  assert.equal(asked.text.includes(stack.token), false);
  assert.equal(asked.text.includes('[redacted]'), false);

  const missionId = asked.body.result.structuredContent.mission_id;
  const reply = await rpc(stack, 'tools/call', {
    name: 'get_reply',
    arguments: { mission_id: missionId },
  });
  assert.equal(reply.body.result.isError, false);
  assert.equal(reply.text.includes(stack.token), false);
  assert.equal(reply.body.result.structuredContent.title, '[redacted]');
  assert.equal(reply.body.result.structuredContent.summary, '[redacted]');

  stack.daemon.failNext({ status: 400, body: { error: stack.token, code: 'bad' } });
  const failed = await rpc(stack, 'tools/call', {
    name: 'ask_main',
    arguments: { message: 'this one fails' },
  });
  assert.equal(failed.body.result.isError, true);
  assert.equal(failed.text.includes(stack.token), false);
  assert.match(failed.body.result.content[0].text, /\[redacted\]/);
  assert.equal(JSON.stringify(stack.logs).includes(stack.token), false);
  assert.equal(JSON.stringify(stack.journal).includes(stack.token), false);
  assert.equal(spy.chunks.join('').includes(stack.token), false);
});

test('lib has no standalone branch', () => {
  const lib = fileURLToPath(new URL('../../lib/', import.meta.url));
  const files = walk(lib).filter((file) => file.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes('TIMON_MCP_PORT'), false, file);
    assert.equal(text.includes('TIMON_DAEMON'), false, file);
    assert.equal(text.includes('standalone'), false, file);
  }
});

test('importing the cli does not listen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-mcp-cli-'));
  const env = { ...process.env };
  delete env.TIMON_MCP_BEARER_TOKEN;
  delete env.TIMON_DAEMON_TOKEN;
  env.TIMON_DAEMON_URL = 'http://127.0.0.1:9';
  env.TIMON_DAEMON_TOKEN_FILE = join(dir, 'absent-token');
  env.TIMON_MCP_DB = join(dir, 'cli.db');
  env.TIMON_MCP_PORT = '0';
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import './bin/timon-mcp-standalone.js'"], {
    cwd: ROOT,
    env,
    timeout: 4000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0);
  assert.equal(stdout.includes('listening'), false);
  assert.equal(stderr.includes('failed to start'), false);
});

/**
 * @param {string} baseUrl
 * @param {{ method?: string, path?: string, headers?: Record<string, string>, body?: string | Buffer }} [options]
 */
function rawCall(baseUrl, options = {}) {
  const url = new URL(options.path || '/', baseUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (err) => {
      if (settled || responseStarted) return;
      settled = true;
      reject(err);
    };
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers: options.headers,
    }, (res) => {
      responseStarted = true;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      const done = () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        finish({ status: res.statusCode, headers: res.headers, text, json });
      };
      res.on('end', done);
      res.on('aborted', done);
    });
    req.on('error', fail);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * @param {Awaited<ReturnType<typeof openStack>>} stack
 * @param {string} method
 * @param {unknown} params
 */
async function rpc(stack, method, params) {
  const response = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stack.bearer}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  return { httpStatus: response.status, text, body: JSON.parse(text) };
}

function spyWrites() {
  /** @type {string[]} */
  const chunks = [];
  const originals = {
    stdout: process.stdout.write,
    stderr: process.stderr.write,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const push = (chunk) => { chunks.push(String(chunk)); };
  process.stdout.write = (chunk, ...rest) => {
    push(chunk);
    return originals.stdout.call(process.stdout, chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    push(chunk);
    return originals.stderr.call(process.stderr, chunk, ...rest);
  };
  for (const key of ['log', 'info', 'warn', 'error', 'debug']) {
    console[key] = (...args) => {
      push(args.map((part) => String(part)).join(' '));
      return originals[key](...args);
    };
  }
  return {
    chunks,
    restore() {
      process.stdout.write = originals.stdout;
      process.stderr.write = originals.stderr;
      console.log = originals.log;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
      console.debug = originals.debug;
    },
  };
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}
