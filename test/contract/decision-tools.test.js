import assert from 'node:assert/strict';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { sha256Hex } from '../../lib/auth/crypto.js';
import { APPROVAL_MESSAGE, BEARER_SECRET } from '../../lib/constants.js';
import { FORM_CANCELLED } from '../../host/answers.js';
import { PERMISSIONS_TOO_LARGE, RESPONSE_MAX_BYTES, createDaemonClient } from '../../host/daemon.js';
import { CARD_ID } from '../../host/permissions.js';
import {
  FAKE_ACCOUNT_EMAIL,
  FAKE_ACCOUNT_ID,
  FAKE_ACCOUNT_NAME,
  FAKE_ACCOUNT_THEME,
} from '../helpers/fake-daemon.js';
import { openStack } from '../helpers/standalone.js';

const QUESTION_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '33333333-3333-4333-8333-333333333333';
const DENY_ID = '55555555-5555-4555-8555-555555555555';
const BROKEN_ID = '44444444-4444-4444-8444-444444444444';
const RESOURCE = 'https://mcp.example/mcp';
const CARD_LEAK = 'secret-card-body';
const NOTE = 'private-note-value';
const RELAY_EMAIL = 'relay@example.test';

test('resolve and auth/me stay on the closed list and a bad body never leaves', async (t) => {
  const stack = await openStack(t);
  const journal = [];
  const client = createDaemonClient({
    origin: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    env: { [BEARER_SECRET]: stack.bearer },
    bearerName: BEARER_SECRET,
    journal,
  });
  const id = APPROVAL_ID;
  const refused = [
    ['POST', `/api/permissions/${id}/resolve`, { behavior: 'paste' }],
    ['POST', `/api/permissions/${id}/resolve`, { behavior: 'allow', scope: 'session' }],
    ['POST', `/api/permissions/${id}/resolve`, { behavior: 'allow', updatedInput: { command: 'rm' } }],
    ['POST', `/api/permissions/${id}/resolve`, { behavior: 'allow', message: 'no' }],
    ['POST', `/api/permissions/${id}/resolve`, { behavior: 'deny', updatedInput: { answers: {} } }],
    ['POST', `/api/permissions/${id}/resolve`, { behavior: 'allow', extra: true }],
    ['POST', `/api/permissions/${id}/resolve`, { behavior: 'allow', updatedInput: { answers: {}, plan: {} } }],
    ['GET', '/api/auth/me', { user: FAKE_ACCOUNT_EMAIL }],
    ['GET', '/api/auth/me', undefined, { user: FAKE_ACCOUNT_ID }],
    ['POST', '/api/permissions/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/resolve', { behavior: 'allow' }],
  ];
  for (const [method, path, body, query] of refused) {
    await assert.rejects(() => client.request(method, path, body, query), (err) => err.code === 'route_denied', `${method} ${path}`);
  }
  assert.equal(stack.daemon.requests.length, 0);

  const me = await client.request('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.id, FAKE_ACCOUNT_ID);
  assert.equal(me.json.user.email, FAKE_ACCOUNT_EMAIL);
  assert.deepEqual(journal, [{ method: 'GET', path: '/api/auth/me', status: 200 }]);
  assertNoLeak(journal);

  stack.daemon.permissions.set(id, approvalCard(id));
  const resolved = await client.request('POST', `/api/permissions/${id}/resolve`, { behavior: 'allow' });
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.json, { ok: true });
  assert.equal(stack.daemon.permissions.has(id), false);
  assert.deepEqual(JSON.parse(stack.daemon.requests.at(-1).bodyText), { behavior: 'allow' });
  assert.equal(stack.daemon.requests.at(-1).search, '');
  assertNoLeak(journal);
});

test('allow and deny record the account id and the static relay, never the address', async (t) => {
  let time = 1000;
  const stack = await openStack(t, { now: () => { time += 1; return time; } });
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(APPROVAL_ID));
  stack.daemon.permissions.set(DENY_ID, approvalCard(DENY_ID));

  const allowed = await call(stack, 'resolve_approval', {
    id: APPROVAL_ID,
    behavior: 'allow',
    relay_channel: 'hermes',
  });
  assert.equal(allowed.body.result.isError, false);
  assert.deepEqual(allowed.body.result.structuredContent, {
    id: APPROVAL_ID,
    type: 'approval',
    status: 'allow',
  });
  assert.equal(stack.daemon.permissions.has(APPROVAL_ID), false);
  assert.deepEqual(posted(stack, APPROVAL_ID), { behavior: 'allow' });
  assert.deepEqual(tail(stack, 3), [
    'GET /api/permissions',
    'GET /api/auth/me',
    `POST /api/permissions/${APPROVAL_ID}/resolve`,
  ]);

  const denied = await call(stack, 'resolve_approval', {
    id: DENY_ID,
    behavior: 'deny',
    message: '  no thanks  ',
  });
  assert.deepEqual(denied.body.result.structuredContent, {
    id: DENY_ID,
    type: 'approval',
    status: 'deny',
  });
  assert.deepEqual(posted(stack, DENY_ID), { behavior: 'deny', message: '  no thanks  ' });

  const listed = await call(stack, 'list_decisions', {});
  assert.deepEqual(listed.body.result.structuredContent.decisions.map((row) => row.id), [DENY_ID, APPROVAL_ID]);
  assert.equal(listed.body.result.structuredContent.decisions[0].relayed_by, 'static:hermes');
  assert.equal(listed.body.result.structuredContent.decisions[0].decided_by, FAKE_ACCOUNT_ID);
  const stored = rows(stack);
  assert.equal(stored.length, 2);
  assert.equal(stored[1].status, 'allow');
  assert.equal(stored[0].status, 'deny');
  assert.equal(Number(stack.host.ctx.sql.prepare('SELECT COUNT(*) AS n FROM host_pending_cards').get().n), 0);
  assertNoLeak([allowed.text, denied.text, listed.text, stack.logs, stack.journal, stored]);
  assert.equal(JSON.stringify(stored).includes(stack.token), false);
  assert.equal(JSON.stringify(stored).includes(stack.bearer), false);
});

test('a question, a plan and a cancel post only the accepted body', async (t) => {
  const stack = await openStack(t);
  stack.daemon.permissions.set(QUESTION_ID, questionCard());
  const answered = await call(stack, 'answer_question', {
    id: QUESTION_ID,
    answers: {
      'Ship it?': 'yes',
      'Which parts?': ['api'],
    },
    note: `  ${NOTE}  `,
  });
  assert.deepEqual(answered.body.result.structuredContent, {
    id: QUESTION_ID,
    type: 'question',
    status: 'answered',
  });
  assert.deepEqual(posted(stack, QUESTION_ID), {
    behavior: 'allow',
    updatedInput: {
      answers: { 'Ship it?': 'yes', 'Which parts?': ['api'] },
      note: NOTE,
    },
  });
  assert.equal(stack.daemon.permissions.has(QUESTION_ID), false);

  stack.daemon.permissions.set(QUESTION_ID, questionCard());
  const blank = await call(stack, 'answer_question', {
    id: QUESTION_ID,
    answers: { 'Ship it?': 'no', 'Which parts?': ['ui'] },
    note: '   ',
  });
  assert.equal(blank.body.result.structuredContent.status, 'answered');
  const blankBody = posted(stack, QUESTION_ID);
  assert.deepEqual(Object.keys(blankBody.updatedInput), ['answers']);

  stack.daemon.permissions.set(PLAN_ID, planCard());
  const planned = await call(stack, 'answer_question', {
    id: PLAN_ID,
    plan: {
      mode: 'kanban-full',
      roles: { code: { backend: 'grok', model: 'grok-4' } },
      groups: { core: { code: { backend: 'grok', model: 'grok-4' } } },
      note: 'go',
    },
  });
  assert.deepEqual(planned.body.result.structuredContent, {
    id: PLAN_ID,
    type: 'series_plan',
    status: 'answered',
  });
  const planBody = posted(stack, PLAN_ID);
  assert.deepEqual(Object.keys(planBody), ['behavior', 'updatedInput']);
  assert.deepEqual(Object.keys(planBody.updatedInput), ['plan']);
  assert.equal(planBody.updatedInput.plan.note, 'go');
  assert.equal(planBody.updatedInput.plan.mode, 'kanban-full');

  stack.daemon.permissions.set(QUESTION_ID, questionCard());
  const cancelled = await call(stack, 'answer_question', { id: QUESTION_ID, cancel: true });
  assert.deepEqual(cancelled.body.result.structuredContent, {
    id: QUESTION_ID,
    type: 'question',
    status: 'cancelled',
  });
  assert.deepEqual(posted(stack, QUESTION_ID), { behavior: 'deny', message: FORM_CANCELLED });
  assertNoLeak([answered.text, blank.text, planned.text, cancelled.text, stack.logs, stack.journal, rows(stack)]);
});

test('a bad call is refused before resolve, and the wrong tool cannot change the card', async (t) => {
  const stack = await openStack(t);
  stack.daemon.permissions.set(QUESTION_ID, questionCard());
  stack.daemon.permissions.set(PLAN_ID, planCard());
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(APPROVAL_ID));
  stack.daemon.permissions.set(BROKEN_ID, brokenAsk());

  const before = () => stack.daemon.requests.length;
  const local = [
    ['answer_question', { id: QUESTION_ID, answers: { 'Ship it?': 'yes' }, plan: { mode: 'sequential-here' } }, 'give an answer or a plan, not both'],
    ['answer_question', { id: QUESTION_ID, cancel: true, note: 'x' }, 'cancel does not take an answer'],
    ['answer_question', { id: QUESTION_ID, cancel: false }, 'cancel must be true'],
    ['answer_question', { id: PLAN_ID, plan: { mode: 'sequential-here' }, note: 'x' }, 'a plan answer has no separate note'],
    ['resolve_approval', { id: APPROVAL_ID, behavior: 'allow', message: 'no' }, 'an approval allow takes no message'],
    ['resolve_approval', { id: APPROVAL_ID, behavior: 'deny', message: 'bad\u0000message' }, 'message is invalid'],
  ];
  for (const [name, args, message] of local) {
    const mark = before();
    const result = await call(stack, name, args);
    assert.equal(result.body.result.isError, true, name);
    assert.equal(result.body.result.content[0].text, message);
    assert.equal(stack.daemon.requests.length, mark);
  }

  const schema = [
    ['resolve_approval', { id: APPROVAL_ID, behavior: 'allow', scope: 'always' }, 'unexpected property `scope`'],
    ['resolve_approval', { id: APPROVAL_ID, behavior: 'allow', updatedInput: { command: 'rm' } }, 'unexpected property `updatedInput`'],
    ['resolve_approval', { id: APPROVAL_ID, behavior: 'paste' }, '`behavior` is not an accepted value'],
    ['answer_question', { id: QUESTION_ID, answers: {}, decided_by_note: 'me' }, 'unexpected property `decided_by_note`'],
    ['resolve_approval', { id: APPROVAL_ID, behavior: 'deny', relay_channel: 'telegram' }, '`relay_channel` is not an accepted value'],
    ['answer_question', { id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', cancel: true }, `\`id\` does not match ${CARD_ID.source}`],
    ['resolve_approval', { id: APPROVAL_ID, behavior: 'deny', message: 'x'.repeat(2001) }, '`message` is too long'],
    ['list_decisions', { limit: 0 }, '`limit` is below 1'],
    ['list_decisions', { limit: 101 }, '`limit` is above 100'],
  ];
  for (const [name, args, message] of schema) {
    const mark = before();
    const result = await call(stack, name, args);
    assert.equal(result.body.error && result.body.error.code, -32602, `${name} ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error.message, message);
    assert.equal(stack.daemon.requests.length, mark);
  }

  const readOnly = [
    ['answer_question', { id: QUESTION_ID, answers: { 'Ship it?': 'maybe', 'Which parts?': ['api'] } }, 'unknown option'],
    ['answer_question', { id: PLAN_ID, answers: { 'Ship it?': 'yes' } }, 'this question is a Kanban plan'],
    ['answer_question', { id: QUESTION_ID, plan: { mode: 'sequential-here', roles: {} } }, 'this question is a form'],
    ['answer_question', { id: APPROVAL_ID, cancel: true }, 'this card is not a question'],
    ['resolve_approval', { id: QUESTION_ID, behavior: 'deny' }, 'this card is not an approval'],
    ['resolve_approval', { id: PLAN_ID, behavior: 'allow' }, 'this card is not an approval'],
    ['answer_question', { id: DENY_ID, cancel: true }, 'card not found'],
  ];
  for (const [name, args, message] of readOnly) {
    const mark = before();
    const result = await call(stack, name, args);
    assert.equal(result.body.result.isError, true, message);
    assert.match(result.body.result.content[0].text, new RegExp(message));
    assert.deepEqual(tail(stack, stack.daemon.requests.length - mark), ['GET /api/permissions']);
  }
  assert.equal(stack.daemon.requests.some((row) => row.method === 'POST'), false);
  assert.equal(stack.daemon.requests.some((row) => row.path === '/api/auth/me'), false);
  assert.equal(rows(stack).length, 0);
  assert.equal(stack.daemon.permissions.has(QUESTION_ID), true);
  assert.equal(stack.daemon.permissions.has(APPROVAL_ID), true);

  const broken = await call(stack, 'resolve_approval', { id: BROKEN_ID, behavior: 'allow' });
  assert.deepEqual(broken.body.result.structuredContent, { id: BROKEN_ID, type: 'approval', status: 'allow' });
  const asQuestion = await call(stack, 'answer_question', { id: BROKEN_ID, cancel: true });
  assert.equal(asQuestion.body.result.content[0].text, 'card not found');
});

test('the status is the one the daemon accepted, and a bad account is not posted', async (t) => {
  const stack = await openStack(t);
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(APPROVAL_ID));
  stack.daemon.setNextResolve({
    status: 200,
    body: { ok: true, behavior: 'deny', email: FAKE_ACCOUNT_EMAIL, theme: FAKE_ACCOUNT_THEME },
  });
  const echoed = await call(stack, 'resolve_approval', { id: APPROVAL_ID, behavior: 'allow' });
  assert.deepEqual(echoed.body.result.structuredContent, {
    id: APPROVAL_ID,
    type: 'approval',
    status: 'deny',
  });
  assert.equal(rows(stack)[0].status, 'deny');
  assert.equal(stack.daemon.permissions.has(APPROVAL_ID), false);

  stack.daemon.permissions.set(QUESTION_ID, questionCard());
  stack.daemon.setNextResolve({ status: 200, body: { ok: true, behavior: 'allow' } });
  const cancelEcho = await call(stack, 'answer_question', { id: QUESTION_ID, cancel: true });
  assert.equal(cancelEcho.body.result.structuredContent.status, 'answered');
  assert.equal(rows(stack)[0].status, 'answered');

  stack.daemon.permissions.set(QUESTION_ID, questionCard());
  stack.daemon.setNextResolve({
    status: 404,
    body: { error: 'permission request not found (already resolved or expired)', code: 'permission_request_gone' },
  });
  const gone = await call(stack, 'answer_question', { id: QUESTION_ID, cancel: true });
  assert.equal(gone.body.result.content[0].text, 'card not found');
  assert.equal(stack.daemon.permissions.has(QUESTION_ID), true);
  assert.equal(rows(stack).some((row) => row.id === QUESTION_ID && row.status === 'cancelled'), false);

  stack.daemon.setNextResolve({ status: 500, body: { error: FAKE_ACCOUNT_EMAIL } });
  const refused = await call(stack, 'answer_question', { id: QUESTION_ID, cancel: true });
  assert.equal(refused.body.result.content[0].text, 'daemon refused the decision');
  assert.equal(stack.daemon.permissions.has(QUESTION_ID), true);

  stack.daemon.setNextResolve({ status: 200, body: { ok: true, behavior: 'paste' } });
  const paste = await call(stack, 'answer_question', { id: QUESTION_ID, cancel: true });
  assert.equal(paste.body.result.content[0].text, 'daemon refused the decision');
  assert.equal(rows(stack).some((row) => row.status === 'cancelled'), false);

  stack.daemon.permissions.set(PLAN_ID, planCard());
  stack.daemon.setAccount({ id: `bad ${FAKE_ACCOUNT_EMAIL}`, email: FAKE_ACCOUNT_EMAIL });
  const unusable = await call(stack, 'answer_question', {
    id: PLAN_ID,
    plan: { mode: 'sequential-here', roles: {} },
  });
  assert.equal(unusable.body.result.content[0].text, 'account id is unusable');
  assert.equal(unusable.text.includes(FAKE_ACCOUNT_EMAIL), false);
  assert.equal(unusable.text.includes('bad '), false);
  assert.equal(stack.daemon.requests.at(-1).path, '/api/auth/me');
  assert.equal(stack.daemon.permissions.has(PLAN_ID), true);

  stack.daemon.setAccount('omit');
  const posts = stack.daemon.requests.filter((row) => row.method === 'POST').length;
  const omitted = await call(stack, 'answer_question', {
    id: PLAN_ID,
    plan: { mode: 'sequential-here', roles: {} },
  });
  assert.equal(omitted.body.result.content[0].text, 'account id is unusable');
  assert.equal(stack.daemon.requests.filter((row) => row.method === 'POST').length, posts);

  stack.daemon.setAccount(null);
  const tokenOnly = await call(stack, 'answer_question', {
    id: PLAN_ID,
    plan: { mode: 'sequential-here', roles: {} },
  });
  assert.equal(tokenOnly.body.result.structuredContent.status, 'answered');
  assert.equal(tokenOnly.body.result.structuredContent.decided_by, undefined);
  assert.equal(rows(stack).find((row) => row.id === PLAN_ID).decided_by, 'daemon-token');
  assertNoLeak([echoed.text, cancelEcho.text, gone.text, refused.text, paste.text, unusable.text, omitted.text, tokenOnly.text, stack.logs, stack.journal, rows(stack)]);
});

test('an oauth caller is relayed by subject digest, and a subject that is not a digest is refused', async (t) => {
  const stack = await openStack(t, {
    settings: {
      public_url: 'https://mcp.example',
      issuer: 'https://mcp.example',
      resource: RESOURCE,
    },
  });
  const subject = sha256Hex(RELAY_EMAIL);
  const access = randomBytes(32).toString('hex');
  insertAccess(stack, access, subject);
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(APPROVAL_ID));
  const mark = stack.daemon.requests.length;
  const allowed = await call(stack, 'resolve_approval', { id: APPROVAL_ID, behavior: 'allow' }, access);
  assert.equal(allowed.body.result.structuredContent.status, 'allow');
  assert.equal(rows(stack)[0].relayed_by, `${subject}:hermes`);
  assert.equal(rows(stack)[0].relayed_by.includes('@'), false);
  assert.equal(allowed.text.includes(RELAY_EMAIL), false);
  assert.ok(stack.daemon.requests.length > mark);

  const bad = randomBytes(32).toString('hex');
  insertAccess(stack, bad, 'not-a-digest');
  stack.daemon.permissions.set(DENY_ID, approvalCard(DENY_ID));
  const again = stack.daemon.requests.length;
  const missing = await call(stack, 'resolve_approval', { id: DENY_ID, behavior: 'deny' }, bad);
  assert.equal(missing.body.result.content[0].text, 'caller subject is missing');
  assert.equal(stack.daemon.requests.length, again);
  assert.equal(stack.daemon.permissions.has(DENY_ID), true);
  assertNoLeak([allowed.text, missing.text, stack.logs, stack.journal, rows(stack)], [RELAY_EMAIL, access, bad]);
});

test('listing the journal does not call the daemon, and answering does not take a spawn slot', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '1' } });
  const empty = await call(stack, 'list_decisions', {});
  assert.deepEqual(empty.body.result.structuredContent, { decisions: [] });
  assert.equal(stack.daemon.requests.length, 0);

  const launched = await call(stack, 'launch_mission', { agent: '_main', message: 'hello' });
  assert.equal(launched.body.result.isError, false);
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(APPROVAL_ID));
  const allowed = await call(stack, 'resolve_approval', { id: APPROVAL_ID, behavior: 'allow' });
  assert.equal(allowed.body.result.structuredContent.status, 'allow');
  const blocked = await call(stack, 'launch_mission', { agent: '_main', message: 'again' });
  assert.equal(blocked.body.result.isError, true);
  assert.equal(blocked.body.result.content[0].text, APPROVAL_MESSAGE);
  assert.equal(stack.daemon.requests.filter((row) => row.path === '/api/missions' && row.method === 'POST').length, 1);

  const one = await call(stack, 'list_decisions', { limit: 1 });
  assert.equal(one.body.result.structuredContent.decisions.length, 1);
  const mark = stack.daemon.requests.length;
  await call(stack, 'list_decisions', { limit: 1 });
  assert.equal(stack.daemon.requests.length, mark);

  stack.daemon.permissions.set(DENY_ID, approvalCard(DENY_ID));
  const extra = new DatabaseSync(stack.dbFile);
  extra.exec(`
    CREATE TRIGGER host_decisions_fail BEFORE INSERT ON host_decisions
    BEGIN SELECT RAISE(ABORT, 'forced'); END
  `);
  extra.close();
  const kept = await call(stack, 'resolve_approval', { id: DENY_ID, behavior: 'deny', message: 'no' });
  assert.equal(kept.body.result.structuredContent.status, 'deny');
  assert.equal(rows(stack).some((row) => row.id === DENY_ID), false);
  assert.match(JSON.stringify(stack.logs), new RegExp(`decision record failed id=${DENY_ID}`));
  assertNoLeak([empty.text, allowed.text, kept.text, stack.logs, stack.journal, rows(stack)]);
});

test('a huge permissions body is too_large and a long list can still answer one card', async (t) => {
  const stack = await openStack(t);
  stack.daemon.setPermissionsRaw(`${CARD_LEAK}${'x'.repeat(RESPONSE_MAX_BYTES)}`);
  const huge = await call(stack, 'answer_question', { id: QUESTION_ID, cancel: true });
  assert.equal(huge.body.result.content[0].text, PERMISSIONS_TOO_LARGE);
  assert.equal(huge.text.includes(CARD_LEAK), false);
  assert.equal(stack.daemon.requests.some((row) => row.method === 'POST'), false);

  stack.daemon.setPermissionsRaw(null);
  for (let index = 0; index < 200; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    stack.daemon.permissions.set(id, approvalCard(id));
  }
  stack.daemon.permissions.set(APPROVAL_ID, approvalCard(APPROVAL_ID));
  const allowed = await call(stack, 'resolve_approval', { id: APPROVAL_ID, behavior: 'deny' });
  assert.equal(allowed.body.result.structuredContent.status, 'deny');
  assert.equal(stack.daemon.permissions.has(APPROVAL_ID), false);
  assertNoLeak([huge.text, allowed.text, stack.logs, rows(stack)]);
});

test('the host does not serve /api/auth/me', async (t) => {
  const stack = await openStack(t);
  const mark = stack.daemon.requests.length;
  const response = await fetch(`${stack.host.baseUrl}/api/auth/me`);
  const text = await response.text();
  assert.equal(response.status, 404);
  assert.equal(stack.daemon.requests.length, mark);
  assertNoLeak(text);
});

test('answering a waiting card emits resolved once, on the next poll', async (t) => {
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
  stack.daemon.permissions.set(QUESTION_ID, questionCard());
  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 1);
  assert.equal(JSON.parse(receiver.requests[0].body).event, 'pending');

  const answered = await call(stack, 'answer_question', {
    id: QUESTION_ID,
    answers: { 'Ship it?': 'yes', 'Which parts?': ['api'] },
    note: `  ${NOTE}  `,
  });
  assert.equal(answered.body.result.structuredContent.status, 'answered');
  assert.equal(stack.daemon.permissions.has(QUESTION_ID), false);
  assert.equal(receiver.requests.length, 1);
  const pendingRow = stack.host.ctx.sql.prepare('SELECT event FROM host_pending_cards WHERE id = ?').get(QUESTION_ID);
  assert.equal(pendingRow.event, 'pending');

  const visible = await call(stack, 'list_pending', {});
  assert.equal(visible.body.result.structuredContent.cards.some((row) => row.id === QUESTION_ID), false);
  const mark = stack.daemon.requests.length;
  const journal = await call(stack, 'list_decisions', {});
  assert.equal(stack.daemon.requests.length, mark);
  assert.equal(journal.body.result.structuredContent.decisions[0].decided_by, FAKE_ACCOUNT_ID);
  assert.equal(journal.body.result.structuredContent.decisions[0].relayed_by, 'static:hermes');
  assert.equal(journal.body.result.structuredContent.decisions[0].status, 'answered');

  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 2);
  const resolved = JSON.parse(receiver.requests[1].body);
  assert.equal(resolved.event, 'resolved');
  assert.equal(resolved.card.id, QUESTION_ID);
  assert.equal(resolved.card.type, 'question');

  await stack.host.pollPending();
  await stack.host.settlePending();
  assert.equal(receiver.requests.length, 2);
  const stored = stack.host.ctx.sql.prepare('SELECT event FROM host_pending_cards WHERE id = ?').get(QUESTION_ID);
  assert.equal(stored.event, 'resolved');

  for (const request of receiver.requests) {
    assertNoLeak(request.body, [NOTE, CARD_LEAK, hookSecret]);
    const timestamp = header(request.headers, 'x-timon-timestamp');
    const signature = header(request.headers, 'x-timon-signature');
    const expected = createHmac('sha256', hookSecret).update(`${timestamp}.${request.body}`).digest('hex');
    const presented = signature.startsWith('v1=') ? signature.slice(3) : '';
    assert.equal(timingSafeEqual(Buffer.from(expected), Buffer.from(presented)), true);
  }
  assertNoLeak([answered.text, visible.text, journal.text, stack.logs, stack.journal, rows(stack)], [NOTE, CARD_LEAK, hookSecret]);
});

/**
 * @param {unknown} value
 * @param {string[]} [extra]
 */
function assertNoLeak(value, extra = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [FAKE_ACCOUNT_EMAIL, FAKE_ACCOUNT_NAME, FAKE_ACCOUNT_THEME, ...extra]) {
    assert.equal(text.includes(secret), false);
  }
}

/**
 * @param {Awaited<ReturnType<typeof openStack>>} stack
 * @param {number} count
 */
function tail(stack, count) {
  return stack.daemon.requests.slice(-count).map((row) => `${row.method} ${row.path}`);
}

/**
 * @param {Awaited<ReturnType<typeof openStack>>} stack
 * @param {string} id
 */
function posted(stack, id) {
  const row = [...stack.daemon.requests].reverse().find((item) => item.method === 'POST' && item.path === `/api/permissions/${id}/resolve`);
  assert.ok(row, id);
  return JSON.parse(row.bodyText);
}

/**
 * @param {Awaited<ReturnType<typeof openStack>>} stack
 */
function rows(stack) {
  return stack.host.ctx.sql.prepare(
    'SELECT id, type, status, decided_by, relayed_by, created_at FROM host_decisions ORDER BY created_at DESC, id DESC',
  ).all();
}

/**
 * @param {Awaited<ReturnType<typeof openStack>>} stack
 * @param {string} token
 * @param {string} subject
 */
function insertAccess(stack, token, subject) {
  stack.host.ctx.sql.prepare(
    `INSERT INTO oauth_tokens
      (token_hash, kind, client_id, resource, subject, family_id, expires_at, revoked_at, created_at)
     VALUES (?, 'access', 'client-1', ?, ?, ?, ?, NULL, ?)`,
  ).run(sha256Hex(token), RESOURCE, subject, `family-${subject}`, Date.now() + 60_000, Date.now());
}

/**
 * @param {string} id
 */
function approvalCard(id) {
  return {
    id,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    tool_name: 'bash',
    tool_use_id: CARD_LEAK,
    input: { command: `echo ${CARD_LEAK}`, leak: FAKE_ACCOUNT_EMAIL },
    shell_command: CARD_LEAK,
    created_at: 3000,
    timeout_ms: 1000,
  };
}

function questionCard() {
  return {
    id: QUESTION_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    tool_name: 'ask_user',
    tool_use_id: CARD_LEAK,
    created_at: 1000,
    timeout_ms: 1000,
    input: {
      leak: CARD_LEAK,
      questions: [
        {
          question: 'Ship it?',
          header: 'Ship',
          options: [
            { label: 'yes', description: 'ship' },
            { label: 'no', description: 'hold' },
          ],
        },
        {
          question: 'Which parts?',
          multiSelect: true,
          options: [
            { label: 'api', description: 'api' },
            { label: 'ui', description: 'ui' },
          ],
        },
      ],
    },
  };
}

function planCard() {
  return {
    id: PLAN_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    tool_name: 'ask_user',
    tool_use_id: CARD_LEAK,
    created_at: 2000,
    timeout_ms: 1000,
    input: {
      leak: CARD_LEAK,
      form: {
        kind: 'series_plan',
        chantier: 'Build the journal',
        volets: [
          { title: 'Write', description: 'code', group: 'core' },
          { title: 'Check', group: 'core' },
        ],
      },
    },
  };
}

function brokenAsk() {
  return {
    id: BROKEN_ID,
    mission_id: 'foreignmission01',
    agent: 'alpha.coder',
    tool_name: 'ask_user',
    created_at: 1500,
    timeout_ms: 1000,
    input: { questions: [] },
  };
}

/**
 * @param {Awaited<ReturnType<typeof openStack>>} stack
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string} [bearer]
 */
async function call(stack, name, args, bearer = stack.bearer) {
  const response = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
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
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} name
 */
function header(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * @param {(request: { body: string }) => { status: number, body?: string }} handler
 */
async function startReceiver(handler) {
  /** @type {Array<{ url: string, body: string, headers: import('node:http').IncomingHttpHeaders }>} */
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = {
      url: req.url || '',
      body: Buffer.concat(chunks).toString('utf8'),
      headers: req.headers,
    };
    requests.push(record);
    const result = handler(record);
    res.writeHead(result.status);
    res.end(result.body || '');
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
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
