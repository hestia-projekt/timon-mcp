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
    const badTail = `${randomBytes(12).toString('base64')}*`;
    const badSecret = `whsec_${badTail}`;
    const unpadded = `whsec_${'abc'.repeat(6)}`;
    const nonCanonical = `whsec_${'ab=='.repeat(4)}`;
    for (const sample of [badSecret, unpadded, nonCanonical]) {
      assert.ok(sample.length >= 16 && sample.length <= 512);
      await assert.rejects(
        () => startStandalone({
          env: {
            TIMON_DAEMON_URL: 'http://127.0.0.1:9',
            TIMON_MCP_PENDING_WEBHOOK_URL: 'https://hooks.example/hook',
            TIMON_MCP_PENDING_WEBHOOK_SECRET: sample,
          },
          port: 0,
          tokenFile: join(dir, 'token'),
          dbFile: join(dir, 'state.db'),
          pendingPoll: false,
        }),
        (err) => err.message === 'pending webhook secret is not valid base64'
          && !err.message.includes(sample)
          && !String(err.stack || '').includes(sample)
          && !err.message.includes(badTail),
      );
    }
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

test('a permissions read past 1 MiB is too_large and a non-uuid resolve stays off the network', async (t) => {
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
  assert.equal(JSON.parse(stored.projection).command, 'echo [redacted]');
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
  assert.equal(header(receiver.requests[0].headers, 'webhook-id'), `pending_${APPROVAL_ID}_1`);
  assert.equal(header(receiver.requests[1].headers, 'webhook-id'), `pending_${APPROVAL_ID}_1`);
  verifySignature(receiver.requests[0], hookSecret);
  const delivered = receiver.requests[1];
  assert.equal(delivered.url, '/hook');
  assert.equal(delivered.body.includes(cardSecret), false);
  assert.equal(delivered.body.includes(hookSecret), false);
  assert.equal(delivered.body.includes('"input"'), false);
  assert.equal(delivered.body.includes('"entry"'), false);
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
    command: 'echo [redacted]',
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
  assert.equal(header(resolved.headers, 'webhook-id'), `resolved_${APPROVAL_ID}_1`);
  assert.notEqual(header(resolved.headers, 'webhook-id'), header(delivered.headers, 'webhook-id'));
  assertAbsent(JSON.stringify(stack.logs), [...secretMaterial(hookSecret), ...signatureMaterial(receiver.requests)]);
  assert.equal(JSON.stringify(stack.logs).includes(hookSecret), false);
  assert.equal(JSON.stringify(stack.logs).includes(cardSecret), false);
});

test('a whsec_ webhook is signed again on each attempt and keeps one id per event', async (t) => {
  const cardSecret = randomBytes(24).toString('hex');
  const decoded = randomBytes(24).toString('hex');
  const hookSecret = `whsec_${Buffer.from(decoded, 'utf8').toString('base64')}`;
  assert.notEqual(cardSecret, hookSecret);
  assert.notEqual(decoded, hookSecret);
  let failuresLeft = 1;
  const receiver = await startReceiver(() => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      return { status: 500 };
    }
    return { status: 204 };
  });
  t.after(() => receiver.close());
  let tick = 0;
  const origin = Date.now();
  const base = origin - (origin % 1000) + 123;
  const stack = await openStack(t, {
    env: {
      TIMON_MCP_PENDING_WEBHOOK_URL: receiver.url,
      TIMON_MCP_PENDING_WEBHOOK_SECRET: hookSecret,
    },
    sleep: async () => {},
    now: () => {
      tick += 1;
      return base + tick * 1000;
    },
  });
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(cardSecret));
  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 2);
  const [first, second] = receiver.requests;
  assert.equal(header(first.headers, 'webhook-id'), `pending_${APPROVAL_ID}_1`);
  assert.equal(header(second.headers, 'webhook-id'), `pending_${APPROVAL_ID}_1`);
  assert.notEqual(header(first.headers, 'webhook-timestamp'), header(second.headers, 'webhook-timestamp'));
  assert.notEqual(header(first.headers, 'webhook-signature'), header(second.headers, 'webhook-signature'));
  assert.notEqual(header(first.headers, 'x-timon-timestamp'), header(second.headers, 'x-timon-timestamp'));
  for (const request of [first, second]) {
    verifySignature(request, hookSecret);
    assert.equal(Number(header(request.headers, 'x-timon-timestamp')) % 1000, 123);
  }

  stack.daemon.permissions.delete(APPROVAL_ID);
  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 3);
  const resolved = receiver.requests[2];
  assert.equal(JSON.parse(resolved.body).event, 'resolved');
  assert.equal(header(resolved.headers, 'webhook-id'), `resolved_${APPROVAL_ID}_1`);
  assert.notEqual(header(resolved.headers, 'webhook-id'), header(first.headers, 'webhook-id'));
  verifySignature(resolved, hookSecret);

  const leaked = [
    ...secretMaterial(hookSecret),
    decoded,
    ...signatureMaterial(receiver.requests),
  ];
  assertAbsent(JSON.stringify(stack.logs), leaked);
  assertAbsent(JSON.stringify(stack.journal), leaked);
  for (const request of receiver.requests) {
    assert.equal(request.body.includes(hookSecret), false);
    assert.equal(request.body.includes(decoded), false);
    assert.equal(request.body.includes(cardSecret), false);
  }
});

test('a later occurrence gets a new webhook id, and a restart reuses an unrecorded one', async (t) => {
  const cardSecret = randomBytes(24).toString('hex');
  const hookSecret = randomBytes(32).toString('hex');
  let release = () => {};
  let hold = false;
  const receiver = await startReceiver(() => {
    if (!hold) return { status: 204 };
    return new Promise((resolve) => {
      release = () => resolve({ status: 204 });
    });
  });
  t.after(() => receiver.close());
  const env = {
    TIMON_MCP_PENDING_WEBHOOK_URL: receiver.url,
    TIMON_MCP_PENDING_WEBHOOK_SECRET: hookSecret,
  };
  const stack = await openStack(t, { env, sleep: async () => {} });
  /** @type {Awaited<ReturnType<typeof startStandalone>> | null} */
  let extra = null;
  t.after(async () => {
    if (extra) await extra.close();
  });

  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(cardSecret));
  hold = true;
  await stack.host.pollPending();
  await waitUntil(() => receiver.requests.length === 1, 1000);
  const pendingFirst = header(receiver.requests[0].headers, 'webhook-id');
  assert.equal(pendingFirst, `pending_${APPROVAL_ID}_1`);
  assert.equal(stack.host.ctx.sql.prepare('SELECT id FROM host_pending_cards WHERE id = ?').get(APPROVAL_ID), undefined);
  assert.equal(stack.host.ctx.sql.prepare('SELECT id FROM host_pending_webhook_seq WHERE id = ?').get(APPROVAL_ID), undefined);

  const closing = stack.host.close();
  release();
  hold = false;
  await closing;

  extra = await startStandalone({
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
  await extra.pollPending();
  await extra.settlePending();
  assert.equal(receiver.requests.length, 2);
  assert.equal(header(receiver.requests[1].headers, 'webhook-id'), pendingFirst);
  verifySignature(receiver.requests[0], hookSecret);
  verifySignature(receiver.requests[1], hookSecret);
  const recorded = extra.ctx.sql.prepare(
    'SELECT c.event AS event, s.pending_seq AS pending_seq, s.resolved_seq AS resolved_seq FROM host_pending_cards AS c JOIN host_pending_webhook_seq AS s ON s.id = c.id WHERE c.id = ?',
  ).get(APPROVAL_ID);
  assert.equal(recorded.event, 'pending');
  assert.equal(Number(recorded.pending_seq), 1);
  assert.equal(Number(recorded.resolved_seq), 0);

  stack.daemon.permissions.delete(APPROVAL_ID);
  await extra.pollPending();
  await extra.settlePending();
  assert.equal(receiver.requests.length, 3);
  const resolvedFirst = header(receiver.requests[2].headers, 'webhook-id');
  assert.equal(resolvedFirst, `resolved_${APPROVAL_ID}_1`);
  verifySignature(receiver.requests[2], hookSecret);

  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(cardSecret));
  await extra.pollPending();
  await extra.settlePending();
  assert.equal(receiver.requests.length, 4);
  const pendingSecond = header(receiver.requests[3].headers, 'webhook-id');
  assert.equal(pendingSecond, `pending_${APPROVAL_ID}_2`);
  verifySignature(receiver.requests[3], hookSecret);
  assert.equal(new Set([pendingFirst, resolvedFirst, pendingSecond]).size, 3);

  stack.daemon.permissions.delete(APPROVAL_ID);
  await extra.pollPending();
  await extra.settlePending();
  assert.equal(receiver.requests.length, 5);
  const resolvedSecond = header(receiver.requests[4].headers, 'webhook-id');
  assert.equal(resolvedSecond, `resolved_${APPROVAL_ID}_2`);
  assert.notEqual(resolvedSecond, resolvedFirst);
  verifySignature(receiver.requests[4], hookSecret);

  extra.ctx.sql.prepare('UPDATE host_pending_cards SET updated_at = 0 WHERE id = ?').run(APPROVAL_ID);
  const insert = extra.ctx.sql.prepare(
    'INSERT INTO host_pending_cards (id, event, projection, updated_at) VALUES (?, ?, ?, ?)',
  );
  for (let i = 0; i < RESOLVED_ROW_CAP; i += 1) {
    const id = `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`;
    insert.run(id, 'resolved', JSON.stringify({ id }), i + 1);
  }
  await extra.pollPending();
  await extra.settlePending();
  assert.equal(receiver.requests.length, 5, 'purging a resolved row does not send it again');
  assert.equal(extra.ctx.sql.prepare('SELECT id FROM host_pending_cards WHERE id = ?').get(APPROVAL_ID), undefined);
  const kept = extra.ctx.sql.prepare(
    'SELECT pending_seq, resolved_seq FROM host_pending_webhook_seq WHERE id = ?',
  ).get(APPROVAL_ID);
  assert.equal(Number(kept.pending_seq), 2);
  assert.equal(Number(kept.resolved_seq), 2);

  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(cardSecret));
  await extra.pollPending();
  await extra.settlePending();
  assert.equal(receiver.requests.length, 6);
  assert.equal(header(receiver.requests[5].headers, 'webhook-id'), `pending_${APPROVAL_ID}_3`);
  verifySignature(receiver.requests[5], hookSecret);
  for (const request of receiver.requests) {
    assert.equal(request.body.includes(cardSecret), false);
    assert.equal(request.body.includes(hookSecret), false);
    assert.match(header(request.headers, 'x-timon-signature'), /^v1=/);
    assert.match(header(request.headers, 'webhook-signature'), /^v1,/);
  }
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
    command: 'echo [redacted]',
  });
  assert.equal(delivered.body.includes(secret), false);
  assert.equal(delivered.body.includes(hookSecret), false);
  assert.equal(delivered.body.includes('"input"'), false);
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
    );
    CREATE TABLE host_pending_webhook_seq (
      id TEXT PRIMARY KEY,
      pending_seq INTEGER NOT NULL DEFAULT 0,
      resolved_seq INTEGER NOT NULL DEFAULT 0
    );
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
  assert.equal(JSON.parse(receiver.requests[1].body).card.command, 'echo [redacted]');
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
    assert.equal(JSON.parse(request.body).card.command, 'echo [redacted]');
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

test('a backtick tool name is the approval command on list_pending and on the webhook', async (t) => {
  const token = randomBytes(18).toString('hex');
  const hex40 = randomBytes(20).toString('hex');
  const hookSecret = randomBytes(32).toString('hex');
  assert.equal(token.length, 36);
  assert.equal(hex40.length, 40);
  assert.notEqual(token, hex40);
  assert.notEqual(token, hookSecret);

  const taskUuid = 'ecb49f3e-e001-4dfc-a68b-5c9181b7b6f9';
  assert.equal(taskUuid.replaceAll('-', '').length, 32);
  assert.equal(/[0-9a-fA-F]{32,}/.test(taskUuid), false, 'dashes split a UUID, so it is not a 32-hex run');

  const statusCmd = 'git status --short --branch';
  const logCmd = `git log --oneline timon/task/${taskUuid}..HEAD`;
  const diffCmd = `git diff --stat timon/task/${taskUuid}...HEAD | tail -5`;
  const sensitive = `curl -H Authorization: Bearer ${token} https://example.test/${hex40}`;
  const longCmd = `echo ${'x'.repeat(180)}`;
  assert.ok(longCmd.length > 160);
  const quote = (command) => `\`${command}\``;

  const receiver = await startReceiver(() => ({ status: 204 }));
  t.after(() => receiver.close());
  const stack = await openStack(t, {
    env: {
      TIMON_MCP_PENDING_WEBHOOK_URL: receiver.url,
      TIMON_MCP_PENDING_WEBHOOK_SECRET: hookSecret,
    },
    sleep: async () => {},
  });

  /**
   * @param {number} n
   * @param {string} toolName
   * @param {Record<string, unknown>} input
   */
  const approval = (n, toolName, input) => ({
    id: `aa000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    tool_name: toolName,
    tool_use_id: token,
    input,
    shell_command: token,
    script_previews: [{ body: hex40 }],
    onPaste: token,
    scopes: ['session'],
    created_at: n,
    timeout_ms: 1000,
  });
  const cases = [
    approval(1, quote(statusCmd), {}),
    approval(2, quote(logCmd), {}),
    approval(3, quote(diffCmd), {}),
    approval(4, quote(sensitive), {}),
    approval(5, quote(longCmd), {}),
    approval(6, 'rm -rf /tmp/x', {}),
    approval(7, '`a` `b`', {}),
    approval(8, '`git status', {}),
    approval(9, 'run `git status` now', {}),
    approval(10, ` ${quote(statusCmd)} `, {}),
    approval(11, quote(statusCmd), { command: `printf Authorization: Bearer ${token} ${hex40}`, note: token }),
    approval(12, quote(statusCmd), { command: '' }),
    approval(13, 'bash', {}),
  ];
  for (const raw of cases) stack.daemon.permissions.set(raw.id, raw);
  stack.daemon.permissions.set(QUESTION_ID, {
    id: QUESTION_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    tool_name: 'ask_user',
    input: {
      message: token,
      questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      secret: token,
    },
    shell_command: token,
    script_previews: [hex40],
    created_at: 100,
    timeout_ms: 1000,
  });
  stack.daemon.permissions.set(PLAN_ID, {
    id: PLAN_ID,
    mission_id: 'foreignmission01',
    agent: '_main',
    tool_name: 'ask_user',
    input: {
      message: token,
      form: {
        kind: 'series_plan',
        chantier: 'Notifications',
        volets: [{ title: 'Probe', description: 'Read cards', group: 'host', secret: token }],
      },
    },
    shell_command: token,
    script_previews: [hex40],
    created_at: 200,
    timeout_ms: 0,
  });

  const listed = await call(stack, 'list_pending', {});
  assert.equal(listed.body.result.isError, false);
  const cards = listed.body.result.structuredContent.cards;
  const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
  const approvalId = (n) => `aa000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const expectApproval = (n, toolName, command) => ({
    type: 'approval',
    id: approvalId(n),
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    created_at: n,
    expires_at: n + 1000,
    tool_name: toolName,
    command,
  });

  assert.deepEqual(byId[approvalId(1)], expectApproval(1, 'shell', statusCmd));
  assert.deepEqual(byId[approvalId(2)], expectApproval(2, 'shell', logCmd));
  assert.deepEqual(byId[approvalId(3)], expectApproval(3, 'shell', diffCmd));
  assert.equal(byId[approvalId(2)].command.includes(taskUuid), true);
  assert.equal(byId[approvalId(3)].command.includes(taskUuid), true);
  assert.equal(byId[approvalId(2)].command.includes('[redacted]'), false);
  assert.deepEqual(
    byId[approvalId(4)],
    expectApproval(4, 'shell', 'curl -H Authorization: Bearer [redacted] https://example.test/[redacted]'),
  );
  assert.equal(byId[approvalId(4)].command.includes(token), false);
  assert.equal(byId[approvalId(4)].command.includes(hex40), false);
  assert.equal(byId[approvalId(5)].command.length, 160);
  assert.equal(byId[approvalId(5)].command, longCmd.slice(0, 160));
  assert.deepEqual(byId[approvalId(5)], expectApproval(5, 'shell', longCmd.slice(0, 160)));
  for (const n of [6, 7, 8, 9, 10]) {
    assert.deepEqual(byId[approvalId(n)], expectApproval(n, 'tool', null));
  }
  assert.deepEqual(
    byId[approvalId(11)],
    expectApproval(11, 'tool', 'printf Authorization: Bearer [redacted] [redacted]'),
  );
  assert.equal(byId[approvalId(11)].command.includes(statusCmd), false);
  assert.deepEqual(byId[approvalId(12)], expectApproval(12, 'shell', statusCmd));
  assert.deepEqual(byId[approvalId(13)], expectApproval(13, 'bash', null));
  assert.deepEqual(byId[QUESTION_ID], {
    type: 'question',
    id: QUESTION_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    created_at: 100,
    expires_at: 1100,
    questions: [{
      question: 'Ship it?',
      header: null,
      options: [
        { label: 'Yes', description: null, actor: null },
        { label: 'No', description: null, actor: null },
      ],
      multi_select: false,
      placeholder: null,
    }],
    plan: null,
  });
  assert.deepEqual(byId[PLAN_ID], {
    type: 'series_plan',
    id: PLAN_ID,
    mission_id: 'foreignmission01',
    agent: '_main',
    created_at: 200,
    expires_at: null,
    questions: [],
    plan: {
      title: 'Notifications',
      volets: [{ title: 'Probe', description: 'Read cards', group: 'host' }],
    },
  });
  assert.equal(Object.hasOwn(byId[QUESTION_ID], 'command'), false);
  assert.equal(Object.hasOwn(byId[PLAN_ID], 'command'), false);
  for (const card of cards) {
    assert.equal(Object.hasOwn(card, 'input'), false);
    assert.equal(Object.hasOwn(card, 'entry'), false);
    assert.equal(Object.hasOwn(card, 'shell_command'), false);
    assert.equal(Object.hasOwn(card, 'script_previews'), false);
    assert.equal(Object.hasOwn(card, 'onPaste'), false);
    assert.equal(Object.hasOwn(card, 'tool_use_id'), false);
    const text = JSON.stringify(card);
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(hex40), false);
  }
  assert.equal(listed.text.includes(token), false);
  assert.equal(listed.text.includes(hex40), false);

  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, cards.length);
  for (const request of receiver.requests) {
    const payload = JSON.parse(request.body);
    assert.equal(payload.event, 'pending');
    assert.deepEqual(payload.card, byId[payload.card.id]);
    assert.equal(request.body.includes(token), false);
    assert.equal(request.body.includes(hex40), false);
    assert.equal(request.body.includes(hookSecret), false);
    assert.equal(request.body.includes('"input"'), false);
    assert.equal(request.body.includes('"entry"'), false);
    assert.equal(request.body.includes('shell_command'), false);
    assert.equal(request.body.includes('script_previews'), false);
    verifySignature(request, hookSecret);
  }
  const questionHook = receiver.requests.map((request) => JSON.parse(request.body).card).find((card) => card.id === QUESTION_ID);
  const planHook = receiver.requests.map((request) => JSON.parse(request.body).card).find((card) => card.id === PLAN_ID);
  assert.equal(Object.hasOwn(questionHook, 'command'), false);
  assert.equal(Object.hasOwn(planHook, 'command'), false);
  assert.equal(JSON.stringify(stack.logs).includes(token), false);
  assert.equal(JSON.stringify(stack.logs).includes(hex40), false);
  assert.equal(JSON.stringify(stack.logs).includes('git status'), false);
  assert.equal(JSON.stringify(stack.logs).includes('rm -rf'), false);
  assert.equal(JSON.stringify(stack.logs).includes(hookSecret), false);
});

test('a resolved webhook adds command null on an old approval and leaves a question', async (t) => {
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

  const oldApprovalId = '99999999-9999-4999-8999-999999999999';
  const oldQuestionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const oldPlanId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const keptId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const keptCommand = 'git status --short --branch';
  const approval = {
    type: 'approval',
    id: oldApprovalId,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    created_at: 1,
    expires_at: null,
    tool_name: 'bash',
  };
  const question = {
    type: 'question',
    id: oldQuestionId,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    created_at: 2,
    expires_at: null,
    questions: [{
      question: 'Ship it?',
      header: null,
      options: [
        { label: 'Yes', description: null, actor: null },
        { label: 'No', description: null, actor: null },
      ],
      multi_select: false,
      placeholder: null,
    }],
    plan: null,
  };
  const plan = {
    type: 'series_plan',
    id: oldPlanId,
    mission_id: 'foreignmission01',
    agent: '_main',
    created_at: 3,
    expires_at: null,
    questions: [],
    plan: { title: 'Notifications', volets: [] },
  };
  const kept = {
    type: 'approval',
    id: keptId,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    created_at: 4,
    expires_at: null,
    tool_name: 'shell',
    command: keptCommand,
  };
  assert.equal(Object.hasOwn(approval, 'command'), false);
  assert.equal(Object.hasOwn(question, 'command'), false);
  assert.equal(Object.hasOwn(plan, 'command'), false);
  assert.equal(stack.daemon.permissions.has(oldApprovalId), false);
  assert.equal(stack.daemon.permissions.has(oldQuestionId), false);

  const insert = stack.host.ctx.sql.prepare(
    'INSERT INTO host_pending_cards (id, event, projection, updated_at) VALUES (?, ?, ?, ?)',
  );
  insert.run(oldApprovalId, 'pending', JSON.stringify(approval), 1);
  insert.run(oldQuestionId, 'pending', JSON.stringify(question), 2);
  insert.run(oldPlanId, 'pending', JSON.stringify(plan), 3);
  insert.run(keptId, 'pending', JSON.stringify(kept), 4);

  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 4);
  /** @type {Record<string, Record<string, unknown>>} */
  const byId = {};
  for (const request of receiver.requests) {
    const payload = JSON.parse(request.body);
    assert.equal(payload.event, 'resolved');
    byId[payload.card.id] = payload.card;
    assert.equal(request.body.includes('"input"'), false);
    assert.equal(request.body.includes('shell_command'), false);
    verifySignature(request, hookSecret);
  }
  assert.deepEqual(byId[oldApprovalId], { ...approval, command: null });
  assert.equal(byId[oldApprovalId].command, null);
  assert.equal(Object.hasOwn(byId[oldApprovalId], 'command'), true);
  assert.deepEqual(byId[oldQuestionId], question);
  assert.equal(Object.hasOwn(byId[oldQuestionId], 'command'), false);
  assert.deepEqual(byId[oldPlanId], plan);
  assert.equal(Object.hasOwn(byId[oldPlanId], 'command'), false);
  assert.deepEqual(byId[keptId], kept);
  assert.equal(JSON.stringify(stack.logs).includes(keptCommand), false);
  assert.equal(JSON.stringify(stack.logs).includes(hookSecret), false);

  const stored = stack.host.ctx.sql.prepare(
    'SELECT event, projection FROM host_pending_cards WHERE id = ?',
  );
  const storedApproval = stored.get(oldApprovalId);
  const storedQuestion = stored.get(oldQuestionId);
  assert.equal(storedApproval.event, 'resolved');
  assert.equal(JSON.parse(storedApproval.projection).command, null);
  assert.equal(storedQuestion.event, 'resolved');
  assert.equal(Object.hasOwn(JSON.parse(storedQuestion.projection), 'command'), false);
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
  verifyStandardWebhook(request, secret);
}

/**
 * Standard Webhooks check, written here and not imported from the host.
 * A `whsec_` secret uses the decoded payload. Any other secret is UTF-8.
 * @param {{ headers: Record<string, string | string[] | undefined>, body: string }} request
 * @param {string} secret
 */
function verifyStandardWebhook(request, secret) {
  const id = header(request.headers, 'webhook-id');
  const timestamp = header(request.headers, 'webhook-timestamp');
  const signature = header(request.headers, 'webhook-signature');
  const millis = header(request.headers, 'x-timon-timestamp');
  assert.match(id, /^[A-Za-z0-9._-]+$/);
  assert.match(timestamp, /^[0-9]+$/);
  assert.equal(timestamp, String(Math.floor(Number(millis) / 1000)));
  assert.notEqual(timestamp, millis);
  const key = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${request.body}`).digest('base64');
  const got = signature.startsWith('v1,') ? signature.slice(3) : '';
  const left = Buffer.from(expected);
  const right = Buffer.from(got);
  assert.equal(left.length, right.length);
  assert.equal(left.length > 0, true);
  assert.equal(timingSafeEqual(left, right), true);
}

/**
 * @param {string} secret
 */
function secretMaterial(secret) {
  /** @type {string[]} */
  const values = [secret];
  if (secret.startsWith('whsec_')) {
    const encoded = secret.slice('whsec_'.length);
    values.push(encoded);
    const key = Buffer.from(encoded, 'base64');
    const utf8 = key.toString('utf8');
    if (Buffer.from(utf8, 'utf8').equals(key)) values.push(utf8);
    values.push(key.toString('hex'));
  }
  return values;
}

/**
 * @param {Array<{ headers: Record<string, string | string[] | undefined> }>} requests
 */
function signatureMaterial(requests) {
  /** @type {string[]} */
  const values = [];
  for (const request of requests) {
    const standard = header(request.headers, 'webhook-signature');
    const legacy = header(request.headers, 'x-timon-signature');
    if (standard.startsWith('v1,')) values.push(standard.slice(3), standard);
    if (legacy.startsWith('v1=')) values.push(legacy.slice(3), legacy);
  }
  return values;
}

/**
 * @param {string} text
 * @param {string[]} values
 */
function assertAbsent(text, values) {
  for (const value of values) {
    if (value.length < 8) continue;
    assert.equal(text.includes(value), false);
  }
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
