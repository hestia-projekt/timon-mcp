import assert from 'node:assert/strict';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BEARER_SECRET } from '../../lib/constants.js';
import { PERMISSIONS_TOO_LARGE, RESPONSE_MAX_BYTES, createDaemonClient } from '../../host/daemon.js';
import { PENDING_CARD_CAP } from '../../host/permissions.js';
import {
  DELIVERY_CONCURRENCY,
  DELIVERY_QUEUE_CAP,
  RESOLVED_ROW_CAP,
  createPendingWatcher,
} from '../../host/pending.js';
import { startStandalone } from '../../host/standalone.js';
import {
  WEBHOOK_ATTEMPTS,
  WEBHOOK_BACKOFF_MS,
  readPendingInterval,
  resolveWebhookUrl,
} from '../../host/webhook.js';
import { openStack } from '../helpers/standalone.js';

const QUESTION_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '33333333-3333-4333-8333-333333333333';
const BROKEN_ID = '44444444-4444-4444-8444-444444444444';
const EPH_ID = '66666666-6666-4666-8666-666666666666';
const BAD_AGENT_ID = '77777777-7777-4777-8777-777777777777';
const BAD_ID = 'not-a-uuid';

test('the poll interval is bounded and a non-https webhook URL is refused', () => {
  assert.equal(readPendingInterval(undefined), 5000);
  assert.equal(readPendingInterval(''), 5000);
  assert.equal(readPendingInterval('1000'), 1000);
  assert.equal(readPendingInterval('60000'), 60000);
  for (const raw of ['999', '60001', '0', '5s', '05000']) {
    assert.throws(() => readPendingInterval(raw), /TIMON_MCP_PENDING_INTERVAL_MS is invalid/);
  }
  assert.equal(WEBHOOK_ATTEMPTS, 3);
  assert.deepEqual(WEBHOOK_BACKOFF_MS, [200, 800]);

  const secret = randomBytes(24).toString('hex');
  assert.equal(resolveWebhookUrl('https://hooks.example/timon'), 'https://hooks.example/timon');
  assert.equal(resolveWebhookUrl('http://127.0.0.1:9/hook'), 'http://127.0.0.1:9/hook');
  assert.equal(resolveWebhookUrl('http://localhost/hook'), 'http://localhost/hook');
  assert.equal(resolveWebhookUrl('http://[::1]/hook'), 'http://[::1]/hook');
  for (const raw of [
    'http://evil.example/hook',
    'http://127.0.0.1.evil.example/hook',
    `http://evil.example/hook?token=${secret}`,
    `https://user:${secret}@hooks.example/hook`,
    'ftp://127.0.0.1/hook',
    'https://hooks.example/hook#frag',
  ]) {
    assert.throws(
      () => resolveWebhookUrl(raw),
      (err) => err.message === 'pending webhook URL is invalid' && !err.message.includes(secret),
    );
  }
});

test('the host refuses a non-https webhook URL and a missing secret before it listens', async () => {
  const secret = randomBytes(24).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'timon-mcp-hook-'));
  try {
    await assert.rejects(
      () => startStandalone({
        env: {
          TIMON_DAEMON_URL: 'http://127.0.0.1:9',
          TIMON_MCP_PENDING_WEBHOOK_URL: `http://evil.example/hook?token=${secret}`,
          TIMON_MCP_PENDING_WEBHOOK_SECRET: secret,
        },
        port: 0,
        tokenFile: join(dir, 'token'),
        dbFile: join(dir, 'state.db'),
        pendingPoll: false,
      }),
      (err) => err.message === 'pending webhook URL is invalid' && !String(err.message).includes(secret),
    );
    await assert.rejects(
      () => startStandalone({
        env: {
          TIMON_DAEMON_URL: 'http://127.0.0.1:9',
          TIMON_MCP_PENDING_WEBHOOK_URL: 'https://hooks.example/hook',
        },
        port: 0,
        tokenFile: join(dir, 'token'),
        dbFile: join(dir, 'state.db'),
        pendingPoll: false,
      }),
      (err) => err.message === 'pending webhook secret is missing',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list_pending projects questions, plans and approvals and drops the raw card', async (t) => {
  const secret = randomBytes(24).toString('hex');
  const stack = await openStack(t);
  stack.daemon.permissions.set(QUESTION_ID, {
    id: QUESTION_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    tool_name: 'ask_user',
    tool_use_id: `use-${secret}`,
    input: {
      message: `message ${secret}`,
      questions: [{
        question: 'Ship it?',
        header: 'Ship',
        options: [
          { label: 'Yes', description: 'Do it', actor: 'agent' },
          { label: 'No', description: 'Stop', actor: 'user', secret },
        ],
        multiSelect: false,
        leaked: secret,
      }],
      secret,
    },
    created_at: 1000,
    timeout_ms: 5000,
    shell_command: secret,
    script_previews: [secret],
    onPaste: secret,
    scopes: ['session'],
  });
  stack.daemon.permissions.set(PLAN_ID, {
    id: PLAN_ID,
    mission_id: 'foreignmission01',
    agent: '_main',
    tool_name: 'ask_user',
    input: {
      message: secret,
      form: {
        kind: 'series_plan',
        chantier: 'Notifications',
        volets: [{ title: 'Probe', description: 'Read cards', group: 'host', secret }],
        defaults: { token: secret },
      },
    },
    created_at: 2000,
    timeout_ms: 0,
  });
  stack.daemon.permissions.set(APPROVAL_ID, {
    id: APPROVAL_ID,
    mission_id: 'othermission01',
    agent: 'alpha.coder',
    tool_name: 'bash',
    tool_use_id: secret,
    input: {
      command: `echo ${secret} ${'z'.repeat(200)}`,
      token: secret,
      note: 'VISIBLE',
      timeout: 5,
      nested: { authorization: `Bearer ${secret}`, ok: 'kept' },
    },
    shell_command: secret,
    script_previews: [{ body: secret }],
    created_at: 3000,
    timeout_ms: 1000,
  });
  stack.daemon.permissions.set(BROKEN_ID, {
    id: BROKEN_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    tool_name: 'ask_user',
    input: { questions: [], token: secret },
    created_at: 4000,
    timeout_ms: 1000,
  });

  const listed = await call(stack, 'list_pending', {});
  assert.equal(listed.body.result.isError, false);
  const cards = listed.body.result.structuredContent.cards;
  assert.deepEqual(cards.map((card) => card.id), [QUESTION_ID, PLAN_ID, APPROVAL_ID, BROKEN_ID]);
  assert.deepEqual(cards[0], {
    type: 'question',
    id: QUESTION_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    created_at: 1000,
    expires_at: 6000,
    questions: [{
      question: 'Ship it?',
      header: 'Ship',
      options: [
        { label: 'Yes', description: 'Do it', actor: 'agent' },
        { label: 'No', description: 'Stop', actor: 'user' },
      ],
      multi_select: false,
      placeholder: null,
    }],
    plan: null,
  });
  assert.deepEqual(cards[1], {
    type: 'series_plan',
    id: PLAN_ID,
    mission_id: 'foreignmission01',
    agent: '_main',
    created_at: 2000,
    expires_at: null,
    questions: [],
    plan: {
      title: 'Notifications',
      volets: [{ title: 'Probe', description: 'Read cards', group: 'host' }],
    },
  });
  assert.equal(cards[2].type, 'approval');
  assert.equal(cards[2].tool_name, 'bash');
  assert.equal(cards[2].mission_id, 'othermission01');
  assert.equal(cards[2].expires_at, 4000);
  assert.equal(Object.hasOwn(cards[2], 'entry'), false);
  assert.equal(cards[2].command.length, 160);
  assert.equal(cards[2].command.startsWith('echo [redacted] '), true);
  assert.equal(cards[2].command.includes(secret), false);
  assert.equal(JSON.stringify(cards[2]).includes('VISIBLE'), false);
  assert.equal(JSON.stringify(cards[2]).includes('token'), false);
  assert.equal(cards[3].type, 'approval');
  assert.equal(cards[3].tool_name, 'ask_user');
  assert.equal(cards[3].command, null);
  assert.equal(JSON.stringify(cards[3]).includes(secret), false);
  for (const card of cards) {
    assert.equal(Object.hasOwn(card, 'input'), false);
    assert.equal(Object.hasOwn(card, 'entry'), false);
    assert.equal(Object.hasOwn(card, 'shell_command'), false);
    assert.equal(Object.hasOwn(card, 'tool_use_id'), false);
    assert.equal(Object.hasOwn(card, 'script_previews'), false);
    assert.equal(Object.hasOwn(card, 'onPaste'), false);
    if (card.type === 'approval') assert.equal(Object.hasOwn(card, 'command'), true);
    else assert.equal(Object.hasOwn(card, 'command'), false);
  }
  assert.equal(listed.text.includes(secret), false);
  assert.equal(listed.text.includes('Bearer'), false);

  const one = await call(stack, 'list_pending', { limit: 1 });
  assert.deepEqual(one.body.result.structuredContent.cards.map((card) => card.id), [QUESTION_ID]);
  const filtered = await call(stack, 'list_pending', { mission_id: 'othermission01' });
  assert.deepEqual(filtered.body.result.structuredContent.cards.map((card) => card.id), [APPROVAL_ID]);
  for (const row of stack.daemon.requests.filter((row) => row.path === '/api/permissions')) {
    assert.equal(row.method, 'GET');
    assert.equal(row.search, '');
  }
  assert.equal(stack.daemon.requests.some((row) => row.path.includes('resolve')), false);

  const before = stack.daemon.requests.length;
  const extra = await call(stack, 'list_pending', { note: 'no' });
  assert.equal(extra.body.error.code, -32602);
  assert.equal(stack.daemon.requests.length, before);

  const anonymous = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_pending', arguments: {} },
    }),
  });
  assert.equal(anonymous.status, 401);
  assert.equal(stack.daemon.requests.length, before);
});

test('a permissions read past 1 MiB is too_large and resolve stays off the list', async (t) => {
  const secret = randomBytes(24).toString('hex');
  const stack = await openStack(t);
  const client = createDaemonClient({
    origin: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    env: { [BEARER_SECRET]: stack.bearer },
    bearerName: BEARER_SECRET,
  });
  const marker = secret + 'x'.repeat(RESPONSE_MAX_BYTES);
  stack.daemon.setPermissionsRaw(marker);
  const huge = await call(stack, 'list_pending', {});
  assert.equal(huge.body.result.isError, true);
  assert.equal(huge.body.result.content[0].text, PERMISSIONS_TOO_LARGE);
  assert.equal(huge.text.includes(secret), false);
  assert.equal(huge.text.includes('daemon is unreachable'), false);

  stack.daemon.setPermissionsRaw(null);
  stack.daemon.failNext({ status: 500, body: { error: secret } });
  const failed = await call(stack, 'list_pending', {});
  assert.equal(failed.body.result.isError, true);
  assert.equal(failed.body.result.content[0].text, 'daemon is unreachable');
  assert.equal(failed.text.includes(secret), false);

  const before = stack.daemon.requests.length;
  await assert.rejects(
    () => client.request('POST', '/api/permissions/abc/resolve', { behavior: 'allow' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/permissions', undefined, { mission_id: 'abc' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/permissions', { raw: true }),
    (err) => err.code === 'route_denied',
  );
  assert.equal(stack.daemon.requests.length, before);
});

test('without a webhook URL the poller records cards and sends nothing', async (t) => {
  const secret = randomBytes(24).toString('hex');
  const receiver = await startReceiver(() => ({ status: 204 }));
  t.after(() => receiver.close());
  const stack = await openStack(t);
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(secret));
  await stack.host.pollPending();
  await stack.host.pollPending();
  assert.equal(receiver.requests.length, 0);
  assert.equal(stack.daemon.requests.filter((row) => row.method === 'POST').length, 0);
  assert.ok(stack.daemon.requests.some((row) => row.method === 'GET' && row.path === '/api/permissions'));
  const stored = stack.host.ctx.sql.prepare('SELECT projection FROM host_pending_cards WHERE id = ?').get(APPROVAL_ID);
  assert.equal(typeof stored.projection, 'string');
  assert.equal(stored.projection.includes(secret), false);
  assert.equal(stored.projection.includes('input'), false);
  assert.equal(stored.projection.includes('"entry"'), false);
  assert.equal(stored.projection.includes('"command"'), false);
  assert.equal(stored.projection.includes('VISIBLE'), false);
  assert.equal(JSON.stringify(stack.logs).includes(secret), false);
});

test('a webhook is signed, deduplicated, and retried a bounded number of times', async (t) => {
  const cardSecret = randomBytes(24).toString('hex');
  const hookSecret = randomBytes(32).toString('hex');
  assert.notEqual(cardSecret, hookSecret);
  const delays = [];
  let failuresLeft = 1;
  const receiver = await startReceiver(() => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      return { status: 500, body: hookSecret };
    }
    return { status: 204 };
  });
  t.after(() => receiver.close());
  const env = {
    TIMON_MCP_PENDING_WEBHOOK_URL: receiver.url,
    TIMON_MCP_PENDING_WEBHOOK_SECRET: hookSecret,
  };
  const stack = await openStack(t, {
    env,
    sleep: async (ms) => { delays.push(ms); },
  });
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(cardSecret));

  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.deepEqual(delays, [200]);
  assert.equal(receiver.requests.length, 2);
  const delivered = receiver.requests[1];
  assert.equal(delivered.url, '/hook');
  assert.equal(delivered.body.includes(cardSecret), false);
  assert.equal(delivered.body.includes(hookSecret), false);
  assert.equal(delivered.body.includes('"input"'), false);
  assert.equal(delivered.body.includes('"entry"'), false);
  assert.equal(delivered.body.includes('"command"'), false);
  assert.equal(delivered.body.includes('shell_command'), false);
  assert.equal(delivered.body.includes('script_previews'), false);
  assert.equal(delivered.body.includes('VISIBLE'), false);
  const payload = JSON.parse(delivered.body);
  assert.equal(payload.event, 'pending');
  assert.deepEqual(payload.card, {
    type: 'approval',
    id: APPROVAL_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    created_at: 3000,
    expires_at: 4000,
    tool_name: 'bash',
  });
  verifySignature(delivered, hookSecret);

  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 2);

  await stack.host.close();
  const again = await startStandalone({
    port: 0,
    daemonUrl: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    dbFile: stack.dbFile,
    env: { [BEARER_SECRET]: stack.bearer, ...env },
    pendingPoll: false,
    sleep: async () => {},
    journal: [],
    logs: [],
  });
  t.after(() => again.close());
  await again.pollPending();
  await again.settlePending();
  assert.equal(receiver.requests.length, 2, 'a restart must not send the same pending card');

  stack.daemon.permissions.delete(APPROVAL_ID);
  await again.pollPending();
  await again.settlePending();
  assert.equal(receiver.requests.length, 3);
  const resolved = receiver.requests[2];
  const resolvedBody = JSON.parse(resolved.body);
  assert.equal(resolvedBody.event, 'resolved');
  assert.equal(resolvedBody.card.id, APPROVAL_ID);
  assert.equal(resolved.body.includes(cardSecret), false);
  assert.equal(resolved.body.includes(hookSecret), false);
  verifySignature(resolved, hookSecret);
  assert.equal(JSON.stringify(stack.logs).includes(hookSecret), false);
  assert.equal(JSON.stringify(stack.logs).includes(cardSecret), false);
});

test('a refused webhook is abandoned after three tries and a redirect is not followed', async (t) => {
  const cardSecret = randomBytes(24).toString('hex');
  const hookSecret = randomBytes(32).toString('hex');
  const delays = [];
  const receiver = await startReceiver((request) => ({
    status: 302,
    headers: { location: '/followed' },
    body: `${hookSecret} ${cardSecret} ${request.url}`,
  }));
  t.after(() => receiver.close());
  const stack = await openStack(t, {
    env: {
      TIMON_MCP_PENDING_WEBHOOK_URL: receiver.url,
      TIMON_MCP_PENDING_WEBHOOK_SECRET: hookSecret,
    },
    sleep: async (ms) => { delays.push(ms); },
  });
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(cardSecret));
  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.deepEqual(delays, [200, 800]);
  assert.equal(receiver.requests.length, WEBHOOK_ATTEMPTS);
  assert.deepEqual(receiver.requests.map((row) => row.url), ['/hook', '/hook', '/hook']);
  const logged = JSON.stringify(stack.logs);
  assert.match(logged, /pending webhook abandoned event=pending id=33333333-3333-4333-8333-333333333333/);
  assert.equal(logged.includes(hookSecret), false);
  assert.equal(logged.includes(cardSecret), false);
  assert.equal(logged.includes('VISIBLE'), false);
  assert.equal(logged.includes('/followed'), false);

  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, WEBHOOK_ATTEMPTS, 'an abandoned event is not tried again');
});

test('the poller does not treat an over-cap list as resolved', async (t) => {
  const secret = randomBytes(24).toString('hex');
  const hookSecret = randomBytes(32).toString('hex');
  const receiver = await startReceiver(() => ({ status: 204 }));
  t.after(() => receiver.close());
  const stack = await openStack(t, {
    env: {
      TIMON_MCP_PENDING_WEBHOOK_URL: receiver.url,
      TIMON_MCP_PENDING_WEBHOOK_SECRET: hookSecret,
    },
    sleep: async () => {},
  });
  for (let i = 0; i < PENDING_CARD_CAP + 1; i += 1) {
    const id = `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`;
    stack.daemon.permissions.set(id, { ...approvalCard(secret), id, created_at: i });
  }
  await stack.host.pollPending();
  assert.equal(receiver.requests.length, 0);
  assert.match(JSON.stringify(stack.logs), /pending list is over the cap/);
  assert.equal(JSON.stringify(stack.logs).includes(secret), false);
  const stored = stack.host.ctx.sql.prepare('SELECT COUNT(*) AS n FROM host_pending_cards').get();
  assert.equal(Number(stored.n), 0);
});

test('an ephemeral agent is listed and notified, and a bad card is dropped by id', async (t) => {
  const secret = randomBytes(24).toString('hex');
  const hookSecret = randomBytes(32).toString('hex');
  assert.notEqual(secret, hookSecret);
  const receiver = await startReceiver(() => ({ status: 204 }));
  t.after(() => receiver.close());
  const stack = await openStack(t, {
    env: {
      TIMON_MCP_PENDING_WEBHOOK_URL: receiver.url,
      TIMON_MCP_PENDING_WEBHOOK_SECRET: hookSecret,
    },
    sleep: async () => {},
  });
  stack.daemon.permissions.set(EPH_ID, {
    id: EPH_ID,
    mission_id: 'foreignmission01',
    agent: '_eph-1a2b3c4d',
    tool_name: 'bash',
    tool_use_id: secret,
    input: { command: `echo ${secret}`, token: secret },
    shell_command: secret,
    script_previews: [secret],
    scopes: ['session'],
    choices: [secret],
    onPaste: secret,
    created_at: 1000,
    timeout_ms: 1000,
  });
  stack.daemon.permissions.set(BAD_AGENT_ID, {
    id: BAD_AGENT_ID,
    mission_id: 'foreignmission01',
    agent: 'bad agent',
    tool_name: 'bash',
    input: { command: secret, token: secret },
    shell_command: secret,
    created_at: 2000,
    timeout_ms: 1000,
  });
  stack.daemon.permissions.set(BAD_ID, {
    id: BAD_ID,
    mission_id: 'foreignmission01',
    agent: '_eph-1a2b3c4d',
    tool_name: 'bash',
    input: { command: secret },
    shell_command: secret,
    created_at: 3000,
    timeout_ms: 1000,
  });

  const listed = await call(stack, 'list_pending', {});
  assert.equal(listed.body.result.isError, false);
  const cards = listed.body.result.structuredContent.cards;
  assert.deepEqual(cards.map((card) => card.id), [EPH_ID]);
  assert.equal(cards[0].agent, '_eph-1a2b3c4d');
  assert.equal(cards[0].type, 'approval');
  assert.equal(cards[0].command, 'echo [redacted]');
  assert.equal(Object.hasOwn(cards[0], 'entry'), false);
  assert.equal(listed.text.includes(secret), false);
  assert.equal(listed.text.includes('bad agent'), false);
  assert.equal(listed.text.includes(BAD_ID), false);

  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 1);
  const delivered = receiver.requests[0];
  const payload = JSON.parse(delivered.body);
  assert.equal(payload.event, 'pending');
  assert.deepEqual(payload.card, {
    type: 'approval',
    id: EPH_ID,
    mission_id: 'foreignmission01',
    agent: '_eph-1a2b3c4d',
    created_at: 1000,
    expires_at: 2000,
    tool_name: 'bash',
  });
  assert.equal(delivered.body.includes(secret), false);
  assert.equal(delivered.body.includes(hookSecret), false);
  assert.equal(delivered.body.includes('"input"'), false);
  assert.equal(delivered.body.includes('"command"'), false);
  assert.equal(delivered.body.includes('"entry"'), false);
  assert.equal(delivered.body.includes('bad agent'), false);
  assert.equal(delivered.body.includes(BAD_ID), false);
  verifySignature(delivered, hookSecret);

  const dropped = stack.logs
    .map((row) => row.message)
    .filter((message) => message.startsWith('pending card dropped'));
  assert.ok(dropped.filter((message) => message === `pending card dropped id=${BAD_AGENT_ID}`).length >= 2);
  assert.ok(dropped.filter((message) => message === `pending card dropped id=${BAD_ID}`).length >= 2);
  for (const message of dropped) {
    assert.equal(message.includes(secret), false);
    assert.equal(message.includes(hookSecret), false);
    assert.equal(message.includes('input'), false);
  }
  const stored = stack.host.ctx.sql.prepare('SELECT id FROM host_pending_cards').all();
  assert.deepEqual(stored.map((row) => row.id), [EPH_ID]);
});

test('resolved rows stay bounded and a busy poll ignores the next tick', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE host_pending_cards (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL CHECK (event IN ('pending', 'resolved')),
      projection TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const insert = db.prepare(
    'INSERT INTO host_pending_cards (id, event, projection, updated_at) VALUES (?, ?, ?, ?)',
  );
  for (let i = 0; i < RESOLVED_ROW_CAP + 5; i += 1) {
    const id = `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`;
    insert.run(id, 'resolved', JSON.stringify({ id }), i);
  }
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const watcher = createPendingWatcher({
    client: {
      async request() {
        calls += 1;
        if (calls === 1) await gate;
        return { status: 200, json: { pending: [] } };
      },
    },
    sql: db,
    webhook: null,
    log() {},
  });
  const first = watcher.poll();
  const second = watcher.poll();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(calls, 1);
  release();
  await first;
  await second;
  assert.equal(calls, 1);
  const kept = db.prepare("SELECT COUNT(*) AS n FROM host_pending_cards WHERE event = 'resolved'").get();
  assert.equal(Number(kept.n), RESOLVED_ROW_CAP);
  const oldest = db.prepare("SELECT MIN(updated_at) AS n FROM host_pending_cards").get();
  assert.equal(Number(oldest.n), 5);
  await watcher.poll();
  assert.equal(calls, 2);
  db.close();
});

test('the poller fires on the configured interval', async (t) => {
  const stack = await openStack(t, {
    pendingPoll: true,
    env: { TIMON_MCP_PENDING_INTERVAL_MS: '1000' },
  });
  const started = Date.now();
  while (!stack.daemon.requests.some((row) => row.method === 'GET' && row.path === '/api/permissions' && row.search === '')) {
    if (Date.now() - started > 4000) assert.fail('poller did not fire');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test('a question webhook keeps the question projection and no tool input', async (t) => {
  const secret = randomBytes(24).toString('hex');
  const hookSecret = randomBytes(32).toString('hex');
  const receiver = await startReceiver(() => ({ status: 204 }));
  t.after(() => receiver.close());
  const stack = await openStack(t, {
    env: {
      TIMON_MCP_PENDING_WEBHOOK_URL: receiver.url,
      TIMON_MCP_PENDING_WEBHOOK_SECRET: hookSecret,
    },
    sleep: async () => {},
  });
  stack.daemon.permissions.set(QUESTION_ID, {
    id: QUESTION_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    tool_name: 'ask_user',
    input: {
      message: secret,
      questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      secret,
    },
    shell_command: secret,
    script_previews: [secret],
    created_at: 1000,
    timeout_ms: 1000,
  });
  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 1);
  const body = receiver.requests[0].body;
  const payload = JSON.parse(body);
  assert.equal(payload.event, 'pending');
  assert.equal(payload.card.type, 'question');
  assert.equal(payload.card.questions[0].question, 'Ship it?');
  assert.equal(payload.card.plan, null);
  assert.equal(Object.hasOwn(payload.card, 'command'), false);
  assert.equal(Object.hasOwn(payload.card, 'entry'), false);
  assert.equal(Object.hasOwn(payload.card, 'input'), false);
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes('shell_command'), false);
  assert.equal(body.includes('script_previews'), false);
  verifySignature(receiver.requests[0], hookSecret);
});

test('a card the daemon still lists is not resolved when the projection rejects it', async (t) => {
  const secret = randomBytes(24).toString('hex');
  const hookSecret = randomBytes(32).toString('hex');
  const receiver = await startReceiver(() => ({ status: 204 }));
  t.after(() => receiver.close());
  const stack = await openStack(t, {
    env: {
      TIMON_MCP_PENDING_WEBHOOK_URL: receiver.url,
      TIMON_MCP_PENDING_WEBHOOK_SECRET: hookSecret,
    },
    sleep: async () => {},
  });
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(secret));
  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 1);

  stack.daemon.permissions.set(APPROVAL_ID, {
    ...approvalCard(secret),
    agent: 'bad agent',
    input: { command: secret, token: secret },
    shell_command: secret,
    script_previews: [secret],
  });
  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 1);
  const row = stack.host.ctx.sql.prepare('SELECT event FROM host_pending_cards WHERE id = ?').get(APPROVAL_ID);
  assert.equal(row.event, 'pending');
  const dropped = stack.logs
    .map((entry) => entry.message)
    .filter((message) => message.startsWith('pending card dropped'));
  assert.ok(dropped.includes(`pending card dropped id=${APPROVAL_ID}`));
  for (const message of dropped) assert.equal(message.includes(secret), false);
  assert.equal(JSON.stringify(stack.logs).includes(secret), false);

  stack.daemon.permissions.delete(APPROVAL_ID);
  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 2);
  assert.equal(JSON.parse(receiver.requests[1].body).event, 'resolved');
  assert.equal(receiver.requests[1].body.includes(secret), false);
  assert.equal(receiver.requests[1].body.includes('"command"'), false);
});

test('a poll does not wait for a silent receiver, and the delivery queue is capped', async (t) => {
  const secret = randomBytes(24).toString('hex');
  const hookSecret = randomBytes(32).toString('hex');
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const receiver = await startReceiver(async () => {
    await gate;
    return { status: 204 };
  });
  t.after(() => {
    release();
    return receiver.close();
  });
  const stack = await openStack(t, {
    env: {
      TIMON_MCP_PENDING_WEBHOOK_URL: receiver.url,
      TIMON_MCP_PENDING_WEBHOOK_SECRET: hookSecret,
    },
    sleep: async () => {},
  });
  const total = DELIVERY_QUEUE_CAP + 3;
  for (let i = 0; i < total; i += 1) {
    const id = `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`;
    stack.daemon.permissions.set(id, {
      ...approvalCard(secret),
      id,
      created_at: i,
      shell_command: secret,
      script_previews: [secret],
    });
  }

  await within(1000, stack.host.pollPending(), 'poll waited for the silent receiver');
  await waitUntil(() => receiver.requests.length >= DELIVERY_CONCURRENCY, 1000);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(receiver.requests.length, DELIVERY_CONCURRENCY);

  await within(1000, stack.host.pollPending(), 'a later poll waited for the silent receiver');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(receiver.requests.length, DELIVERY_CONCURRENCY);
  assert.match(JSON.stringify(stack.logs), /pending delivery queue is full/);
  assert.equal(JSON.stringify(stack.logs).includes(secret), false);
  assert.equal(JSON.stringify(stack.logs).includes(hookSecret), false);

  release();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, DELIVERY_QUEUE_CAP);
  for (const request of receiver.requests) {
    assert.equal(request.body.includes(secret), false);
    assert.equal(request.body.includes('"command"'), false);
    assert.equal(request.body.includes('"entry"'), false);
    assert.equal(request.body.includes('shell_command'), false);
    assert.equal(request.body.includes('script_previews'), false);
  }
  const stored = stack.host.ctx.sql.prepare("SELECT COUNT(*) AS n FROM host_pending_cards WHERE event = 'pending'").get();
  assert.equal(Number(stored.n), DELIVERY_QUEUE_CAP);

  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, total);
  const all = stack.host.ctx.sql.prepare("SELECT COUNT(*) AS n FROM host_pending_cards WHERE event = 'pending'").get();
  assert.equal(Number(all.n), total);
});

/**
 * @param {string} secret
 */
function approvalCard(secret) {
  return {
    id: APPROVAL_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    tool_name: 'bash',
    tool_use_id: secret,
    input: {
      command: `echo ${secret}`,
      token: secret,
      note: 'VISIBLE',
      timeout: 5,
    },
    shell_command: secret,
    created_at: 3000,
    timeout_ms: 1000,
  };
}

/**
 * @param {{ headers: Record<string, string | string[] | undefined>, body: string }} request
 * @param {string} secret
 */
function verifySignature(request, secret) {
  const timestamp = header(request.headers, 'x-timon-timestamp');
  const signature = header(request.headers, 'x-timon-signature');
  assert.match(timestamp, /^[0-9]{10,16}$/);
  assert.ok(Math.abs(Date.now() - Number(timestamp)) < 5 * 60 * 1000);
  const expected = createHmac('sha256', secret).update(`${timestamp}.${request.body}`).digest('hex');
  const presented = signature.startsWith('v1=') ? signature.slice(3) : '';
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  assert.equal(left.length, right.length);
  assert.equal(timingSafeEqual(left, right), true);
  assert.equal(request.body.includes(secret), false);
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} name
 */
function header(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * @param {Awaited<ReturnType<typeof openStack>>} stack
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function call(stack, name, args) {
  const response = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stack.bearer}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  return { httpStatus: response.status, text, body: JSON.parse(text) };
}

/**
 * @param {(request: { url: string, body: string, headers: import('node:http').IncomingHttpHeaders }) => { status: number, headers?: Record<string, string>, body?: string }} handler
 */
async function startReceiver(handler) {
  /** @type {Array<{ url: string, body: string, headers: import('node:http').IncomingHttpHeaders }>} */
  const requests = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = {
      url: req.url || '',
      body: Buffer.concat(chunks).toString('utf8'),
      headers: req.headers,
    };
    requests.push(record);
    try {
      const outcome = await handler(record);
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(outcome.status, outcome.headers || {});
      res.end(outcome.body || '');
    } catch {
      if (!res.destroyed) res.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('receiver failed to bind');
  return {
    url: `http://127.0.0.1:${bound.port}/hook`,
    requests,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/**
 * @param {number} ms
 * @param {Promise<unknown>} work
 * @param {string} label
 */
async function within(ms, work, label) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitUntil(predicate, timeoutMs) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) assert.fail('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
