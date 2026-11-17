import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL_MESSAGE, BEARER_SECRET } from '../../lib/constants.js';
import { DAEMON_ROUTES, createDaemonClient } from '../../host/daemon.js';
import { openStack } from '../helpers/standalone.js';

const ROUTES = [
  'POST /api/missions',
  'GET /api/missions',
  'GET /api/missions/:id',
  'GET /api/missions/:id/messages/:eventId',
  'POST /api/agents/:id/send',
  'POST /api/missions/:id/steer',
  'POST /api/missions/:id/interrupt',
  'DELETE /api/missions/:id',
  'POST /api/stop',
  'POST /api/tasks',
  'GET /api/tasks/:id',
  'GET /api/tasks',
  'PUT /api/tasks/:id',
  'GET /api/projects',
  'GET /api/agents',
  'GET /api/agents/:name',
  'POST /api/messages',
  'GET /api/pipelines',
  'GET /api/pipelines/:auto',
  'GET /api/pipelines/runs/:auto',
  'POST /api/pipelines/:auto/run',
  'GET /api/workflows',
  'GET /api/workflows/:auto',
  'GET /api/workflows/:auto/runs',
  'POST /api/workflows/:auto/run',
  'GET /api/routines',
  'GET /api/routines/:auto',
  'GET /api/permissions',
];

test('the closed list is the twenty-eight daemon routes, including the permissions read', () => {
  assert.deepEqual(
    DAEMON_ROUTES.map((route) => `${route.method} ${route.path}`),
    ROUTES,
  );
});

test('each mission tool talks to the fake daemon and drops the prompt', async (t) => {
  const stack = await openStack(t, { foreignId: 'foreignmission01', env: { TIMON_MCP_SPAWN_MAX: '20' } });
  const before = stack.daemon.requests.length;

  const listed = await call(stack, 'list_all_missions', {});
  assert.equal(listed.body.result.isError, false);
  const missions = listed.body.result.structuredContent.missions;
  assert.equal(missions.some((row) => row.id === 'foreignmission01'), true);
  assert.equal(listed.text.includes('FULL PROMPT'), false);
  assert.equal(listed.text.includes('hidden-backend'), false);
  assert.equal(listed.text.includes('/secret/cwd'), false);
  assert.equal(listed.text.includes('hidden-owner'), false);
  assert.equal(stack.daemon.missions.get('foreignmission01').mission, 'FULL PROMPT');
  const listCall = stack.daemon.requests.at(-1);
  assert.equal(listCall.method, 'GET');
  assert.equal(listCall.path, '/api/missions');
  assert.equal(listCall.search, '?limit=50');
  assert.equal(listCall.authorization, `Bearer ${stack.token}`);

  const pluginList = await call(stack, 'list_missions', {});
  assert.equal(pluginList.body.result.structuredContent.missions.some((row) => row.id === 'foreignmission01'), false);
  const missed = await call(stack, 'get_reply', { mission_id: 'foreignmission01' });
  assert.equal(missed.body.result.isError, true);
  assert.match(missed.body.result.content[0].text, /Mission not found/);

  const state = await call(stack, 'get_mission_state', { mission_id: 'foreignmission01' });
  const detail = state.body.result.structuredContent;
  assert.equal(state.body.result.isError, false);
  assert.equal(detail.id, 'foreignmission01');
  assert.equal(detail.agent_name, '_main');
  assert.equal(detail.status, 'running');
  assert.equal(detail.liveness, 'idle');
  assert.equal(detail.running, true);
  assert.equal(detail.turn_complete, true);
  assert.equal(Object.hasOwn(detail, 'mission'), false);
  assert.equal(state.text.includes('FULL PROMPT'), false);
  assert.equal(state.text.includes('hidden-backend'), false);
  assert.equal(state.text.includes('/secret/cwd'), false);
  const stateCall = stack.daemon.requests.find((row) => row.path === '/api/missions/foreignmission01');
  assert.equal(stateCall.search, '?view=status');

  const message = await call(stack, 'get_mission_message', { mission_id: 'foreignmission01', event_id: 1 });
  assert.equal(message.body.result.isError, false);
  assert.deepEqual(message.body.result.structuredContent, {
    mission_id: 'foreignmission01',
    event_id: 1,
    role: 'agent',
    timestamp: 10,
    text: 'hello from foreignmission01',
    truncated: false,
  });
  assert.equal(message.text.includes('hidden-payload'), false);
  assert.equal(message.text.includes('FULL PROMPT'), false);

  const long = await call(stack, 'get_mission_message', { mission_id: 'foreignmission01', event_id: 2 });
  const body = long.body.result.structuredContent;
  assert.equal(body.truncated, true);
  assert.equal(body.text.length, 20_000);
  assert.equal(body.text.endsWith('TAIL'), false);
  assert.equal(body.role, 'user');

  const sent = await call(stack, 'send_mission', { mission_id: 'foreignmission01', message: 'follow up' });
  assert.deepEqual(sent.body.result.structuredContent, { mission_id: 'foreignmission01', resumed: false });
  const sendCall = stack.daemon.requests.find((row) => row.path === '/api/agents/foreignmission01/send');
  assert.deepEqual(JSON.parse(sendCall.bodyText), { input: 'follow up' });

  const steered = await call(stack, 'steer_mission', { mission_id: 'foreignmission01', message: 'turn left' });
  assert.deepEqual(steered.body.result.structuredContent, {
    mission_id: 'foreignmission01',
    ok: true,
    method: 'stdin',
  });
  const steerCall = stack.daemon.requests.find((row) => row.path === '/api/missions/foreignmission01/steer');
  assert.deepEqual(JSON.parse(steerCall.bodyText), { input: 'turn left' });

  const interrupted = await call(stack, 'interrupt_mission', { mission_id: 'foreignmission01' });
  assert.deepEqual(interrupted.body.result.structuredContent, {
    mission_id: 'foreignmission01',
    ok: true,
    status: 'interrupted',
    resumable: false,
    turn_active: true,
  });
  assert.equal(interrupted.text.includes('hidden-backend'), false);
  const interruptCall = stack.daemon.requests.find((row) => row.path.endsWith('/interrupt'));
  assert.equal(interruptCall.bodyText, '');

  const launched = await call(stack, 'launch_mission', { agent: 'alpha.coder', message: 'ship it' });
  assert.equal(launched.body.result.isError, false);
  const launchedId = launched.body.result.structuredContent.mission_id;
  assert.equal(launched.body.result.structuredContent.agent, 'alpha.coder');
  assert.equal(launched.body.result.structuredContent.status, 'running');
  const spawnCall = stack.daemon.requests.find((row) => row.method === 'POST' && row.path === '/api/missions');
  assert.deepEqual(JSON.parse(spawnCall.bodyText), { agent: 'alpha.coder', mission: 'ship it' });

  const byProject = await call(stack, 'list_all_missions', { project: 'alpha' });
  assert.deepEqual(byProject.body.result.structuredContent.missions.map((row) => row.agent_name), ['alpha.coder']);
  assert.equal(stack.daemon.requests.find((row) => row.search === '?project=alpha&limit=50').path, '/api/missions');

  const byAgent = await call(stack, 'list_all_missions', { agent: '_main', status: 'running' });
  assert.equal(byAgent.body.result.structuredContent.missions.every((row) => row.agent_name === '_main'), true);
  assert.equal(byAgent.body.result.structuredContent.missions.some((row) => row.id === launchedId), false);
  assert.equal(
    stack.daemon.requests.some((row) => row.search === '?agent=_main&status=running&limit=50'),
    true,
  );

  const scope = await call(stack, 'stop_scope', { project: 'alpha' });
  assert.equal(scope.body.result.isError, false);
  const scopeBody = scope.body.result.structuredContent;
  assert.deepEqual(scopeBody.scope, { kind: 'project', name: 'alpha' });
  assert.equal(scopeBody.task_count, 1);
  assert.equal(scopeBody.workflow_count, 1);
  assert.equal(scope.text.includes('SECRET TITLE'), false);
  assert.equal(scope.text.includes('SECRET MESSAGE'), false);
  assert.equal(scope.text.includes('SECRET TRIGGER'), false);
  const stopScopeCall = stack.daemon.requests.find((row) => row.path === '/api/stop' && row.bodyText.includes('alpha'));
  assert.deepEqual(JSON.parse(stopScopeCall.bodyText), { project: 'alpha' });

  const agentStop = await call(stack, 'stop_scope', { agent: '_main' });
  assert.equal(agentStop.body.result.structuredContent.scope.kind, 'agent');
  const agentStopCall = stack.daemon.requests.find((row) => row.bodyText === '{"agent":"_main"}');
  assert.equal(agentStopCall.method, 'POST');
  assert.equal(agentStopCall.path, '/api/stop');

  const stopped = await call(stack, 'stop_mission', { mission_id: launchedId });
  assert.deepEqual(stopped.body.result.structuredContent, { mission_id: launchedId, ok: true, outcome: 'killed' });
  const deleteCall = stack.daemon.requests.find((row) => row.method === 'DELETE');
  assert.equal(deleteCall.path, `/api/missions/${launchedId}`);
  assert.equal(deleteCall.bodyText, '');

  const terminated = await call(stack, 'list_all_missions', { status: 'terminated' });
  assert.equal(terminated.body.result.structuredContent.missions.some((row) => row.id === launchedId), true);
  assert.equal(terminated.text.includes('FULL PROMPT'), false);

  assert.equal(JSON.stringify(stack.journal).includes(stack.token), false);
  assert.equal(stack.daemon.requests.length > before, true);
  for (const row of stack.daemon.requests) {
    assert.equal(row.authorization, `Bearer ${stack.token}`);
    assert.equal(row.authorization.includes(stack.bearer), false);
  }
});

test('a mission tool without the plugin bearer never calls the daemon', async (t) => {
  const stack = await openStack(t, { foreignId: 'foreignmission01' });
  const response = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'launch_mission', arguments: { agent: '_main', message: 'no token' } },
    }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'unauthorized');
  assert.equal(stack.daemon.requests.length, 0);

  const listed = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  assert.equal(listed.status, 401);
  assert.equal(stack.daemon.requests.length, 0);
});

test('overrides, bad ids, and fields outside the list never reach the daemon', async (t) => {
  const stack = await openStack(t, { foreignId: 'foreignmission01' });
  const client = createDaemonClient({
    origin: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    env: { [BEARER_SECRET]: stack.bearer },
    bearerName: BEARER_SECRET,
  });

  const refused = [
    ['GET', '/api/missions/latest'],
    ['GET', '/api/missions/search'],
    ['GET', '/api/missions/ab%2fcd'],
    ['GET', '/api/missions/../tasks'],
    ['GET', '/api/missions/%2e%2e/messages/1'],
    ['GET', '/api/missions?limit=1'],
    ['PUT', '/api/stop'],
    ['POST', '/api/missions/foreignmission01/fork'],
    ['GET', '/api/missions/foreignmission01/stream'],
  ];
  for (const [method, path] of refused) {
    await assert.rejects(() => client.request(method, path), (err) => err.code === 'route_denied');
  }
  await assert.rejects(
    () => client.request('GET', '/api/missions', undefined, { origin: 'user' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/missions', undefined, { status: 'cancelled' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/missions', undefined, { project: '../x' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/missions/foreignmission01', undefined, { view: 'chat' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/stop', { agent: '_main', project: 'alpha' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/missions/foreignmission01/steer', { input: 'hi', model: 'other' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('DELETE', '/api/missions/foreignmission01', { force: true }),
    (err) => err.code === 'route_denied',
  );
  assert.equal(stack.daemon.requests.length, 0);

  const allowed = await client.request('GET', '/api/missions', undefined, { project: 'alpha', limit: '1' });
  assert.equal(allowed.status, 200);
  assert.equal(stack.daemon.requests.at(-1).search, '?project=alpha&limit=1');
  const afterQuery = stack.daemon.requests.length;

  const cases = [
    ['launch_mission', { agent: '_main', message: 'x', model: 'other' }],
    ['launch_mission', { agent: '_main', message: 'x', backend: 'other' }],
    ['launch_mission', { agent: '_main', message: 'x', extraSkills: ['s'] }],
    ['launch_mission', { agent: '_main', message: 'x', permissionMode: 'auto' }],
    ['launch_mission', { agent: 'other', message: 'x' }],
    ['launch_mission', { agent: 'alpha.coder.extra', message: 'x' }],
    ['steer_mission', { mission_id: 'foreignmission01', message: 'x', images: [] }],
    ['send_mission', { mission_id: 'foreignmission01', message: 'x', reply_to: { event_id: 1 } }],
    ['stop_scope', { agent: '_main', note: 'x' }],
    ['list_all_missions', { origin: 'user' }],
    ['list_all_missions', { status: 'cancelled' }],
    ['get_mission_message', { mission_id: 'foreignmission01', event_id: 0 }],
    ['get_mission_state', { mission_id: '../tasks' }],
  ];
  for (const [name, args] of cases) {
    const result = await call(stack, name, args);
    assert.equal(result.body.result, undefined, name);
    assert.equal(result.body.error.code, -32602, name);
  }
  assert.equal(stack.daemon.requests.length, afterQuery);

  const blank = await call(stack, 'launch_mission', { agent: '_main', message: '   ' });
  assert.equal(blank.body.result.isError, true);
  assert.match(blank.body.result.content[0].text, /mission is required/);
  const reserved = await call(stack, 'stop_mission', { mission_id: 'latest' });
  assert.equal(reserved.body.result.isError, true);
  assert.match(reserved.body.result.content[0].text, /mission id is invalid/);
  const both = await call(stack, 'stop_scope', { agent: '_main', project: 'alpha' });
  assert.equal(both.body.result.isError, true);
  assert.match(both.body.result.content[0].text, /expected agent or project/);
  const missing = await call(stack, 'get_mission_message', { mission_id: 'foreignmission01', event_id: 3 });
  assert.equal(missing.body.result.isError, true);
  assert.match(missing.body.result.content[0].text, /Message not found/);
  assert.equal(stack.daemon.requests.length, afterQuery + 1);
  assert.equal(stack.daemon.requests.at(-1).path, '/api/missions/foreignmission01/messages/3');
});

test('launch, send, steer, and both stops share the quota; reads and interrupt do not', async (t) => {
  const stack = await openStack(t, { foreignId: 'foreignmission01', env: { TIMON_MCP_SPAWN_MAX: '1' } });
  const reserved = await call(stack, 'stop_mission', { mission_id: 'latest' });
  assert.equal(reserved.body.result.isError, true);
  assert.equal(stack.daemon.requests.length, 0);

  const launched = await call(stack, 'launch_mission', { agent: '_main', message: 'one' });
  assert.equal(launched.body.result.isError, false);
  const afterLaunch = stack.daemon.requests.length;

  for (const [name, args] of [
    ['launch_mission', { agent: 'alpha.coder', message: 'two' }],
    ['send_mission', { mission_id: 'foreignmission01', message: 'more' }],
    ['steer_mission', { mission_id: 'foreignmission01', message: 'nope' }],
    ['stop_mission', { mission_id: 'foreignmission01' }],
    ['stop_scope', { agent: '_main' }],
  ]) {
    const refused = await call(stack, name, args);
    assert.equal(refused.body.result.isError, true, name);
    assert.equal(refused.body.result.content[0].text, APPROVAL_MESSAGE, name);
  }
  assert.equal(stack.daemon.requests.length, afterLaunch);

  const interrupted = await call(stack, 'interrupt_mission', { mission_id: 'foreignmission01' });
  assert.equal(interrupted.body.result.isError, false);
  const again = await call(stack, 'list_all_missions', {});
  assert.equal(again.body.result.isError, false);
  const state = await call(stack, 'get_mission_state', { mission_id: 'foreignmission01' });
  assert.equal(state.body.result.isError, false);
  assert.equal(stack.daemon.requests.length, afterLaunch + 3);
  assert.equal(stack.daemon.requests.slice(afterLaunch).some((row) => row.method === 'POST' && row.path === '/api/missions'), false);
});

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
