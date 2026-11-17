import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL_MESSAGE, BEARER_SECRET } from '../../lib/constants.js';
import { DaemonBodyError, DaemonCallError } from '../../host/errors.js';
import {
  RESPONSE_MAX_BYTES,
  TASK_LIST_MAX_BYTES,
  TASK_LIST_TOO_LARGE,
  createDaemonClient,
} from '../../host/daemon.js';
import { openStack } from '../helpers/standalone.js';

const FOREIGN = 'foreigntask01';

test('kanban tools talk to the fake daemon and drop overrides and paths', async (t) => {
  const stack = await openStack(t, { foreignTaskId: FOREIGN, env: { TIMON_MCP_SPAWN_MAX: '20' } });

  const listed = await call(stack, 'list_all_tasks', {});
  assert.equal(listed.body.result.isError, false);
  const tasks = listed.body.result.structuredContent.tasks;
  assert.equal(tasks.some((row) => row.id === FOREIGN), true);
  assert.equal(listed.text.includes('SECRET DESCRIPTION'), false);
  assert.equal(listed.text.includes('SECRET COMMENT'), false);
  assert.equal(listed.text.includes('hidden-backend'), false);
  assert.equal(listed.text.includes('hidden-fallback'), false);
  assert.equal(listed.text.includes('hidden-skill'), false);
  assert.equal(listed.text.includes('hidden-owner'), false);
  assert.equal(listed.text.includes('/secret/worktree'), false);
  const listCall = stack.daemon.requests.at(-1);
  assert.equal(listCall.method, 'GET');
  assert.equal(listCall.path, '/api/tasks');
  assert.equal(listCall.search, '');
  assert.equal(listCall.authorization, `Bearer ${stack.token}`);

  const state = await call(stack, 'get_task', { task_id: FOREIGN });
  assert.equal(state.body.result.isError, false);
  const detail = state.body.result.structuredContent;
  assert.equal(detail.id, FOREIGN);
  assert.equal(detail.description, 'SECRET DESCRIPTION');
  assert.equal(detail.done_comment, 'SECRET COMMENT');
  assert.equal(detail.blocked_reason, 'needs a human');
  assert.equal(detail.base, 'main');
  assert.deepEqual(detail.deps, ['dep-1']);
  assert.equal(detail.status, 'BLOCKED');
  assert.equal(detail.agent_name, 'beta.reviewer');
  assert.equal(detail.project, 'beta');
  assert.equal(detail.type, 'review');
  assert.equal(detail.priority, 4);
  assert.equal(detail.truncated, false);
  assert.equal(state.text.includes('hidden-backend'), false);
  assert.equal(state.text.includes('/secret/worktree'), false);
  assert.equal(state.text.includes('hidden-owner'), false);
  assert.equal(stack.daemon.requests.at(-1).path, `/api/tasks/${FOREIGN}`);

  const created = await call(stack, 'add_task', {
    project: 'alpha',
    title: 'Ship the board',
    description: 'notes',
    agent: 'alpha.coder',
    type: 'code',
    base: 'main',
    deps: [FOREIGN],
    priority: 4,
  });
  assert.equal(created.body.result.isError, false);
  const createdId = created.body.result.structuredContent.id;
  assert.equal(created.body.result.structuredContent.agent_name, 'alpha.coder');
  assert.equal(created.body.result.structuredContent.type, 'code');
  assert.equal(created.body.result.structuredContent.status, 'PENDING');
  assert.equal(created.body.result.structuredContent.base, 'main');
  assert.deepEqual(created.body.result.structuredContent.deps, [FOREIGN]);
  assert.equal(created.text.includes('hidden-backend'), false);
  assert.equal(created.text.includes('/secret/worktree'), false);
  const createCall = stack.daemon.requests.find((row) => row.method === 'POST' && row.path === '/api/tasks');
  assert.deepEqual(JSON.parse(createCall.bodyText), {
    title: 'Ship the board',
    description: 'notes',
    agent_name: 'alpha.coder',
    type: 'code',
    project: 'alpha',
    priority: 4,
    deps: [FOREIGN],
    base: 'main',
  });
  const stored = stack.host.ctx.sql.prepare(
    'SELECT project, agent_name, title FROM host_tasks WHERE id = ?',
  ).get(createdId);
  assert.equal(stored.project, 'alpha');
  assert.equal(stored.agent_name, 'alpha.coder');

  const pluginList = await call(stack, 'list_tasks', {});
  const pluginIds = pluginList.body.result.structuredContent.tasks.map((row) => row.id);
  assert.equal(pluginIds.includes(FOREIGN), false);
  assert.equal(pluginIds.includes(createdId), true);

  const byProject = await call(stack, 'list_all_tasks', { project: 'beta' });
  assert.deepEqual(byProject.body.result.structuredContent.tasks.map((row) => row.id), [FOREIGN]);
  assert.equal(stack.daemon.requests.at(-1).search, '');

  const byAgent = await call(stack, 'list_all_tasks', { agent: 'alpha.coder', type: 'code' });
  assert.deepEqual(byAgent.body.result.structuredContent.tasks.map((row) => row.id), [createdId]);
  assert.equal(stack.daemon.requests.at(-1).search, '');

  const byStatus = await call(stack, 'list_all_tasks', { status: 'BLOCKED', project: 'beta' });
  assert.deepEqual(byStatus.body.result.structuredContent.tasks.map((row) => row.id), [FOREIGN]);
  assert.equal(stack.daemon.requests.at(-1).search, '?status=BLOCKED');

  const none = await call(stack, 'list_all_tasks', { status: 'PENDING', project: 'beta' });
  assert.deepEqual(none.body.result.structuredContent.tasks, []);
  assert.equal(stack.daemon.requests.at(-1).search, '?status=PENDING');

  const limited = await call(stack, 'list_all_tasks', { limit: 1 });
  assert.equal(limited.body.result.structuredContent.tasks.length, 1);
  assert.equal(limited.body.result.structuredContent.tasks[0].id, FOREIGN);

  const bare = await call(stack, 'move_task', { task_id: createdId, status: 'BLOCKED' });
  assert.equal(bare.body.result.isError, true);
  assert.match(bare.body.result.content[0].text, /reason is required/);
  const beforeMove = stack.daemon.requests.length;

  const moved = await call(stack, 'move_task', {
    task_id: createdId,
    status: 'BLOCKED',
    reason: 'needs eyes',
    comment: 'paused',
  });
  assert.equal(moved.body.result.isError, false);
  assert.equal(moved.body.result.structuredContent.status, 'BLOCKED');
  assert.equal(moved.body.result.structuredContent.blocked_reason, 'needs eyes');
  assert.equal(moved.body.result.structuredContent.done_comment, 'paused');
  const moveCall = stack.daemon.requests[beforeMove];
  assert.equal(moveCall.method, 'PUT');
  assert.equal(moveCall.path, `/api/tasks/${createdId}`);
  assert.deepEqual(JSON.parse(moveCall.bodyText), {
    status: 'BLOCKED',
    blocked_reason: 'needs eyes',
    done_comment: 'paused',
  });

  const updated = await call(stack, 'update_task', {
    task_id: createdId,
    title: 'Ship the notes',
    description: 'more notes',
    priority: 1,
    deps: [],
    agent: 'alpha.reviewer',
  });
  assert.equal(updated.body.result.isError, false);
  assert.equal(updated.body.result.structuredContent.title, 'Ship the notes');
  assert.equal(updated.body.result.structuredContent.agent_name, 'alpha.reviewer');
  assert.equal(updated.body.result.structuredContent.priority, 1);
  assert.deepEqual(updated.body.result.structuredContent.deps, []);
  const updateCall = stack.daemon.requests.find((row) => row.bodyText.includes('Ship the notes'));
  assert.equal(updateCall.method, 'PUT');
  assert.deepEqual(JSON.parse(updateCall.bodyText), {
    title: 'Ship the notes',
    description: 'more notes',
    priority: 1,
    deps: [],
    agent_name: 'alpha.reviewer',
  });

  const done = await call(stack, 'move_task', { task_id: FOREIGN, status: 'DONE', comment: 'shipped' });
  assert.equal(done.body.result.isError, false);
  const doneCall = stack.daemon.requests.find((row) => row.bodyText === '{"status":"DONE","done_comment":"shipped"}');
  assert.equal(doneCall.path, `/api/tasks/${FOREIGN}`);

  assert.equal(JSON.stringify(stack.journal).includes(stack.token), false);
  for (const row of stack.daemon.requests) {
    assert.equal(row.authorization, `Bearer ${stack.token}`);
    assert.equal(row.authorization.includes(stack.bearer), false);
  }
});

test('a kanban tool without the plugin bearer never calls the daemon', async (t) => {
  const stack = await openStack(t, { foreignTaskId: FOREIGN });
  const response = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'add_task', arguments: { project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'chore' } },
    }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'unauthorized');
  assert.equal(stack.daemon.requests.length, 0);
});

test('task routes, queries, encoded paths, and override fields never reach the daemon', async (t) => {
  const stack = await openStack(t, { foreignTaskId: FOREIGN });
  const client = createDaemonClient({
    origin: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    env: { [BEARER_SECRET]: stack.bearer },
    bearerName: BEARER_SECRET,
  });

  const refused = [
    ['DELETE', `/api/tasks/${FOREIGN}`],
    ['GET', '/api/tasks/ab%2fcd'],
    ['GET', '/api/tasks/%2e%2e/missions'],
    ['GET', '/api/tasks/../missions'],
    ['POST', '/api/tasks/close'],
    ['PUT', `/api/tasks/${FOREIGN}/worktree`],
    ['GET', `/api/tasks/${FOREIGN}/attachments`],
    ['GET', '/api/tasks?status=PENDING'],
    ['PUT', '/api/tasks'],
  ];
  for (const [method, path] of refused) {
    await assert.rejects(() => client.request(method, path), (err) => err.code === 'route_denied');
  }
  await assert.rejects(
    () => client.request('GET', '/api/tasks', undefined, { full: '1' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/tasks', undefined, { project: 'alpha' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/tasks', undefined, { status: 'running' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/tasks', undefined, { status: 'PENDING', limit: '1' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/missions', undefined, { status: 'PENDING' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('PUT', `/api/tasks/${FOREIGN}`, {}),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('PUT', `/api/tasks/${FOREIGN}`, { title: 'x', backend_override: 'other' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('PUT', `/api/tasks/${FOREIGN}`, { status: 'BLOCKED', model: 'other' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/tasks', {
      title: 'T', description: '', agent_name: 'alpha.coder', type: 'code', project: 'alpha', permission_mode: 'auto',
    }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/tasks', {
      description: '', agent_name: 'alpha.coder', type: 'code', project: 'alpha',
    }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('DELETE', `/api/tasks/${FOREIGN}`, { force: true }),
    (err) => err.code === 'route_denied',
  );
  assert.equal(stack.daemon.requests.length, 0);

  const allowed = await client.request('GET', '/api/tasks', undefined, { status: 'BLOCKED' });
  assert.equal(allowed.status, 200);
  assert.equal(stack.daemon.requests.at(-1).search, '?status=BLOCKED');
  const afterQuery = stack.daemon.requests.length;

  await assert.rejects(
    () => stack.host.ctx.kanban.create({
      project: 'alpha', title: 'T', description: 'D', agent: 'alpha.coder', type: 'code', backend: 'other',
    }),
    (err) => err.name === 'PluginTaskError' && err.code === 'forbidden',
  );
  await assert.rejects(
    () => stack.host.ctx.kanban.create({
      project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', fallback: 'none',
    }),
    (err) => err.code === 'forbidden',
  );
  await assert.rejects(
    () => stack.host.ctx.kanban.create({
      project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', extra_skills: ['s'],
    }),
    (err) => err.code === 'forbidden',
  );
  await assert.rejects(
    () => stack.host.ctx.kanban.create({
      project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', permission_mode: 'auto',
    }),
    (err) => err.code === 'forbidden',
  );
  await assert.rejects(
    () => stack.host.ctx.kanban.create({
      project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', extra_mcp_servers: [], extra_allowed_tools: [],
    }),
    (err) => err.code === 'forbidden',
  );
  await assert.rejects(
    () => stack.host.ctx.kanban.update(FOREIGN, { title: 'T', model: 'other' }),
    (err) => err.code === 'forbidden',
  );
  await assert.rejects(
    () => stack.host.ctx.kanban.create({
      project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', pipeline: 'full',
    }),
    (err) => err.code === 'invalid',
  );
  assert.equal(stack.daemon.requests.length, afterQuery);

  const cases = [
    ['add_task', { project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', backend: 'other' }],
    ['add_task', { project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', model: 'other' }],
    ['add_task', { project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', permission_mode: 'auto' }],
    ['add_task', { project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', extra_skills: ['s'] }],
    ['add_task', { project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', extra_mcp_servers: ['s'] }],
    ['add_task', { project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', extra_allowed_tools: ['s'] }],
    ['add_task', { project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', fallback: 'none' }],
    ['add_task', { project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'ops' }],
    ['add_task', { project: 'alpha', title: 'T', agent: 'other', type: 'chore' }],
    ['add_task', { project: 'nope/../x', title: 'T', agent: 'alpha.coder', type: 'chore' }],
    ['update_task', { task_id: FOREIGN, title: 'T', backend_override: 'other' }],
    ['update_task', { task_id: FOREIGN, model_override: 'other' }],
    ['move_task', { task_id: FOREIGN, status: 'DONE', permissionMode: 'auto' }],
    ['list_all_tasks', { status: 'running' }],
    ['list_all_tasks', { origin: 'user' }],
    ['get_task', { task_id: '../tasks' }],
    ['get_task', { task_id: 'ab/cd' }],
  ];
  for (const [name, args] of cases) {
    const result = await call(stack, name, args);
    assert.equal(result.body.result, undefined, name);
    assert.equal(result.body.error.code, -32602, name);
  }
  assert.equal(stack.daemon.requests.length, afterQuery);

  const dotted = await call(stack, 'add_task', {
    project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', base: '..',
  });
  assert.equal(dotted.body.result.isError, true);
  assert.match(dotted.body.result.content[0].text, /base is invalid/);
  const flagged = await call(stack, 'add_task', {
    project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', base: '-main',
  });
  assert.equal(flagged.body.result.isError, true);
  const badDeps = await call(stack, 'add_task', {
    project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', deps: '../x',
  });
  assert.equal(badDeps.body.result.isError, true);
  assert.match(badDeps.body.result.content[0].text, /deps is invalid/);
  const reserved = await call(stack, 'get_task', { task_id: 'latest' });
  assert.equal(reserved.body.result.isError, true);
  assert.match(reserved.body.result.content[0].text, /task id is invalid/);
  const emptyUpdate = await call(stack, 'update_task', { task_id: FOREIGN });
  assert.equal(emptyUpdate.body.result.isError, true);
  assert.match(emptyUpdate.body.result.content[0].text, /task update is empty/);
  const reasonOnDone = await call(stack, 'move_task', { task_id: FOREIGN, status: 'DONE', reason: 'nope' });
  assert.equal(reasonOnDone.body.result.isError, true);
  assert.match(reasonOnDone.body.result.content[0].text, /reason is only accepted/);
  const missing = await call(stack, 'get_task', { task_id: 'missing-task' });
  assert.equal(missing.body.result.isError, true);
  assert.match(missing.body.result.content[0].text, /Task not found/);
  assert.equal(stack.daemon.requests.length, afterQuery + 1);
  assert.equal(stack.daemon.requests.at(-1).path, '/api/tasks/missing-task');
});

test('task creation shares the quota; list, read, update, and move do not', async (t) => {
  const stack = await openStack(t, { foreignTaskId: FOREIGN, env: { TIMON_MCP_SPAWN_MAX: '1' } });
  const bad = await call(stack, 'add_task', {
    project: 'alpha', title: 'T', agent: 'alpha.coder', type: 'code', backend: 'other',
  });
  assert.equal(bad.body.error.code, -32602);
  assert.equal(stack.daemon.requests.length, 0);

  const first = await call(stack, 'add_task', {
    project: 'alpha', title: 'One', agent: 'alpha.coder', type: 'chore',
  });
  assert.equal(first.body.result.isError, false);
  const createdId = first.body.result.structuredContent.id;
  const after = stack.daemon.requests.length;
  assert.equal(stack.daemon.requests.filter((row) => row.method === 'POST' && row.path === '/api/tasks').length, 1);

  const second = await call(stack, 'add_task', {
    project: 'alpha', title: 'Two', agent: 'alpha.coder', type: 'chore',
  });
  assert.equal(second.body.result.isError, true);
  assert.equal(second.body.result.content[0].text, APPROVAL_MESSAGE);
  assert.equal(stack.daemon.requests.length, after);

  const listed = await call(stack, 'list_all_tasks', {});
  assert.equal(listed.body.result.isError, false);
  const read = await call(stack, 'get_task', { task_id: FOREIGN });
  assert.equal(read.body.result.isError, false);
  const updated = await call(stack, 'update_task', { task_id: createdId, title: 'Renamed' });
  assert.equal(updated.body.result.isError, false);
  const moved = await call(stack, 'move_task', { task_id: createdId, status: 'BLOCKED', reason: 'stop' });
  assert.equal(moved.body.result.isError, false);
  assert.equal(stack.daemon.requests.length, after + 4);
  assert.equal(stack.daemon.requests.filter((row) => row.method === 'POST' && row.path === '/api/tasks').length, 1);
});

test('a task list past 1 MiB is read, and past the list ceiling it is too_large', async (t) => {
  const stack = await openStack(t, { foreignTaskId: FOREIGN });
  const client = createDaemonClient({
    origin: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    env: { [BEARER_SECRET]: stack.bearer },
    bearerName: BEARER_SECRET,
  });

  const wide = taskPage(RESPONSE_MAX_BYTES + 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) > RESPONSE_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) < TASK_LIST_MAX_BYTES);
  stack.daemon.setTaskList(wide);
  const listed = await call(stack, 'list_all_tasks', { status: 'BLOCKED', project: 'beta' });
  assert.equal(listed.body.result.isError, false);
  assert.deepEqual(listed.body.result.structuredContent.tasks.map((row) => row.id), ['keep-me']);
  assert.equal(listed.text.includes('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), false);
  assert.equal(stack.daemon.requests.at(-1).search, '?status=BLOCKED');

  const over = taskPage(TASK_LIST_MAX_BYTES + 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(over)) > TASK_LIST_MAX_BYTES);
  stack.daemon.setTaskList(over);
  const huge = await call(stack, 'list_all_tasks', { project: 'beta', status: 'BLOCKED' });
  assert.equal(huge.body.result.isError, true);
  assert.equal(huge.body.result.content[0].text, TASK_LIST_TOO_LARGE);
  assert.equal(huge.text.includes('daemon is unreachable'), false);
  assert.equal(huge.text.includes('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), false);

  stack.daemon.failNext({
    status: 200,
    body: { task: { id: FOREIGN, description: 'y'.repeat(RESPONSE_MAX_BYTES + 128) } },
  });
  await assert.rejects(
    () => client.request('GET', `/api/tasks/${FOREIGN}`),
    (err) => err instanceof DaemonCallError && err.code === 'unreachable' && !(err instanceof DaemonBodyError),
  );
});

test('done_comment is stored only when the status changes', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '5' } });
  const client = createDaemonClient({
    origin: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    env: { [BEARER_SECRET]: stack.bearer },
    bearerName: BEARER_SECRET,
  });
  const created = await call(stack, 'add_task', {
    project: 'alpha', title: 'Note', agent: 'alpha.coder', type: 'chore',
  });
  assert.equal(created.body.result.isError, false);
  const id = created.body.result.structuredContent.id;
  assert.equal(stack.daemon.tasks.get(id).done_comment, null);

  const alone = await client.request('PUT', `/api/tasks/${id}`, { done_comment: 'silent' });
  assert.equal(alone.status, 200);
  assert.equal(stack.daemon.tasks.get(id).done_comment, null);
  assert.equal(stack.daemon.tasks.get(id).status, 'PENDING');

  const same = await client.request('PUT', `/api/tasks/${id}`, { status: 'PENDING', done_comment: 'silent' });
  assert.equal(same.status, 200);
  assert.equal(stack.daemon.tasks.get(id).done_comment, null);

  const moved = await call(stack, 'move_task', { task_id: id, status: 'DONE', comment: 'shipped' });
  assert.equal(moved.body.result.isError, false);
  assert.equal(moved.body.result.structuredContent.done_comment, 'shipped');
  assert.equal(stack.daemon.tasks.get(id).done_comment, 'shipped');

  const cleared = await client.request('PUT', `/api/tasks/${id}`, { status: 'BLOCKED', blocked_reason: 'stop' });
  assert.equal(cleared.status, 200);
  assert.equal(stack.daemon.tasks.get(id).status, 'BLOCKED');
  assert.equal(stack.daemon.tasks.get(id).blocked_reason, 'stop');
  assert.equal(stack.daemon.tasks.get(id).done_comment, null);

  const before = stack.daemon.requests.length;
  const gone = await call(stack, 'comment_task', { task_id: id, comment: 'nope' });
  assert.equal(gone.body.result.isError, true);
  assert.equal(gone.body.result.content[0].text, 'unknown tool');
  assert.equal(stack.daemon.requests.length, before);
});

/**
 * A `{ tasks }` document of `bytes` UTF-8 bytes. Two rows, so a host-side
 * project filter still has something to drop after the body is read.
 * @param {number} bytes
 */
function taskPage(bytes) {
  const tasks = [
    {
      id: 'keep-me',
      title: 'Keep',
      status: 'BLOCKED',
      agent_name: 'beta.reviewer',
      project: 'beta',
      type: 'review',
      priority: 1,
      deps: '[]',
      created_at: 1,
      updated_at: 2,
      description: '',
    },
    {
      id: 'drop-me',
      title: 'Drop',
      status: 'BLOCKED',
      agent_name: 'alpha.coder',
      project: 'alpha',
      type: 'code',
      priority: 1,
      deps: '[]',
      created_at: 3,
      updated_at: 4,
      description: '',
    },
  ];
  const bare = Buffer.byteLength(JSON.stringify({ tasks, view: 'board' }));
  const pad = bytes - bare;
  assert.ok(pad > 0);
  tasks[1].description = 'x'.repeat(pad);
  const body = { tasks, view: 'board' };
  assert.equal(Buffer.byteLength(JSON.stringify(body)), bytes);
  return body;
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
