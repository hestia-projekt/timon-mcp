import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL_MESSAGE, BEARER_SECRET } from '../../lib/constants.js';
import { createDaemonClient } from '../../host/daemon.js';
import { DIRECT_FROM_AGENT, DIRECT_FROM_MISSION } from '../../host/names.js';
import { openStack } from '../helpers/standalone.js';

const NEEDLES = [
  'SECRET SYSTEM PROMPT',
  'LEAKED NAME PROMPT',
  'secret-skill',
  'SECRET TOKEN',
  'SECRET DIRECTIVE',
  'SECRET KEY',
  'SECRET SPEECH',
  '/secret/',
  'hidden-backend',
  'bypass',
  'workspaces',
  'main_seat',
  '/api/uploads',
];

const PROJECTS = [
  { slug: 'alpha', name: 'Alpha', status: 'active' },
  { slug: 'beta', name: 'Beta', status: 'paused' },
];

const AGENTS = [
  { name: '_main', role: 'orchestrator', project: null, orchestrator: true },
  { name: 'alpha.coder', role: 'coder', project: 'alpha', orchestrator: false },
  { name: 'alpha.orchestrator', role: 'orchestrator', project: 'alpha', orchestrator: true },
  { name: 'beta.reviewer', role: 'reviewer', project: null, orchestrator: false },
];

test('project and agent tools project the fake daemon and fix the sender', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '20' } });

  const projects = await call(stack, 'list_projects', {});
  assert.equal(projects.body.result.isError, false);
  assert.deepEqual(projects.body.result.structuredContent.projects, PROJECTS);
  assert.equal(stack.daemon.requests.at(-1).method, 'GET');
  assert.equal(stack.daemon.requests.at(-1).path, '/api/projects');
  assert.equal(stack.daemon.requests.at(-1).search, '');
  assertNoNeedle(projects.text);

  const limited = await call(stack, 'list_projects', { limit: 1 });
  assert.deepEqual(limited.body.result.structuredContent.projects, [PROJECTS[0]]);
  assert.equal(stack.daemon.requests.at(-1).search, '');

  const agents = await call(stack, 'list_agents', {});
  assert.equal(agents.body.result.isError, false);
  assert.deepEqual(agents.body.result.structuredContent.agents, AGENTS);
  assert.equal(stack.daemon.requests.at(-1).method, 'GET');
  assert.equal(stack.daemon.requests.at(-1).path, '/api/agents');
  assert.equal(stack.daemon.requests.at(-1).search, '');
  assertNoNeedle(agents.text);

  const filtered = await call(stack, 'list_agents', { project: 'alpha' });
  assert.deepEqual(filtered.body.result.structuredContent.agents, [
    AGENTS[1],
    AGENTS[2],
  ]);
  assert.equal(stack.daemon.requests.at(-1).search, '');

  const one = await call(stack, 'list_agents', { limit: 1 });
  assert.deepEqual(one.body.result.structuredContent.agents, [AGENTS[0]]);

  const detail = await call(stack, 'get_agent', { agent: 'alpha.coder' });
  assert.equal(detail.body.result.isError, false);
  assert.deepEqual(detail.body.result.structuredContent, {
    name: 'alpha.coder',
    role: 'coder',
    project: 'alpha',
    orchestrator: false,
    reports_to: 'alpha.orchestrator',
    ephemeral: false,
  });
  assert.equal(stack.daemon.requests.at(-1).path, '/api/agents/alpha.coder');
  assert.equal(stack.daemon.requests.at(-1).search, '');
  assertNoNeedle(detail.text);

  const hiddenProject = await call(stack, 'get_agent', { agent: 'beta.reviewer' });
  assert.deepEqual(hiddenProject.body.result.structuredContent, {
    name: 'beta.reviewer',
    role: 'reviewer',
    project: null,
    orchestrator: false,
    reports_to: null,
    ephemeral: false,
  });
  assertNoNeedle(hiddenProject.text);

  const sent = await call(stack, 'send_agent', { agent: 'alpha.coder', message: 'roster-hello-marker' });
  assert.equal(sent.body.result.isError, false);
  const body = sent.body.result.structuredContent;
  assert.match(body.message_id, /^[0-9a-f-]{36}$/);
  assert.equal(typeof body.created_at, 'number');
  assert.deepEqual(
    { agent: body.agent, kind: body.kind, from_mission: body.from_mission, from_agent: body.from_agent },
    {
      agent: 'alpha.coder',
      kind: 'msg',
      from_mission: DIRECT_FROM_MISSION,
      from_agent: DIRECT_FROM_AGENT,
    },
  );
  assert.equal(Object.hasOwn(body, 'payload'), false);
  assert.equal(sent.text.includes('roster-hello-marker'), false);
  const posted = stack.daemon.requests.find((row) => row.method === 'POST' && row.path === '/api/messages');
  assert.deepEqual(JSON.parse(posted.bodyText), {
    to_agent: 'alpha.coder',
    payload: 'roster-hello-marker',
    kind: 'msg',
    from_mission: DIRECT_FROM_MISSION,
    from_agent: DIRECT_FROM_AGENT,
  });
  assert.equal(posted.search, '');
  assert.equal(stack.daemon.messages.length, 1);
  assert.equal(stack.daemon.messages[0].payload, 'roster-hello-marker');
});

test('a roster tool without the plugin bearer never calls the daemon', async (t) => {
  const stack = await openStack(t);
  const response = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} },
    }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'unauthorized');
  assert.equal(stack.daemon.requests.length, 0);
});

test('roster routes, queries, encoded paths, and a caller from_* never reach the daemon', async (t) => {
  const stack = await openStack(t);
  const client = createDaemonClient({
    origin: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    env: { [BEARER_SECRET]: stack.bearer },
    bearerName: BEARER_SECRET,
  });

  const refused = [
    ['POST', '/api/projects'],
    ['DELETE', '/api/projects/alpha'],
    ['GET', '/api/projects/activity'],
    ['GET', '/api/projects?x=1'],
    ['POST', '/api/agents'],
    ['GET', '/api/agents/active'],
    ['DELETE', '/api/agents/_main'],
    ['GET', '/api/agents/_main/skills'],
    ['GET', '/api/agents/_main/files'],
    ['PUT', '/api/agents/_main/files'],
    ['PATCH', '/api/agents/alpha.coder/config'],
    ['GET', '/api/agents/ab%2fcd'],
    ['GET', '/api/agents/../projects'],
    ['GET', '/api/agents/%2e%2e'],
    ['GET', '/api/messages'],
    ['POST', '/api/messages/abc/pick'],
  ];
  for (const [method, path] of refused) {
    await assert.rejects(() => client.request(method, path), (err) => err.code === 'route_denied');
  }
  await assert.rejects(
    () => client.request('GET', '/api/projects', undefined, { x: '1' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/agents', undefined, { project: 'alpha' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/messages', {
      to_agent: 'alpha.coder',
      payload: 'hello',
      kind: 'msg',
      from_mission: 'caller-mission',
      from_agent: DIRECT_FROM_AGENT,
    }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/messages', {
      to_agent: 'alpha.coder',
      payload: 'hello',
      kind: 'msg',
      from_mission: DIRECT_FROM_MISSION,
      from_agent: 'caller',
    }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/messages', {
      to_agent: 'alpha.coder',
      payload: 'hello',
      kind: 'msg',
      from_mission: DIRECT_FROM_MISSION,
      from_agent: DIRECT_FROM_AGENT,
      trace_id: 'x',
    }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/messages', {
      to_agent: 'not-named',
      payload: 'hello',
      kind: 'msg',
      from_mission: DIRECT_FROM_MISSION,
      from_agent: DIRECT_FROM_AGENT,
    }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/messages', {
      to_agent: 'alpha.coder',
      payload: '{"kind":"task_closed"}',
      kind: 'msg',
      from_mission: DIRECT_FROM_MISSION,
      from_agent: DIRECT_FROM_AGENT,
    }),
    (err) => err.code === 'route_denied',
  );
  assert.equal(stack.daemon.requests.length, 0);

  await assert.rejects(
    () => stack.host.ctx.roster.send({ agent: 'alpha.coder', message: 'hi', from_mission: 'x' }),
    (err) => err.name === 'PluginMissionError' && err.code === 'invalid' && /from is fixed/.test(err.message),
  );
  await assert.rejects(
    () => stack.host.ctx.roster.send({ agent: 'alpha.coder', message: 'hi', from_agent: 'caller' }),
    (err) => err.name === 'PluginMissionError' && err.code === 'invalid' && /from is fixed/.test(err.message),
  );
  assert.equal(stack.daemon.requests.length, 0);

  const cases = [
    ['send_agent', { agent: 'alpha.coder', message: 'hi', from_mission: DIRECT_FROM_MISSION }],
    ['send_agent', { agent: 'alpha.coder', message: 'hi', from_agent: 'caller' }],
    ['send_agent', { agent: 'alpha.coder', message: 'hi', to_mission: 'x' }],
    ['send_agent', { agent: 'alpha.coder', message: 'hi', in_reply_to: '1' }],
    ['send_agent', { agent: 'active', message: 'hi' }],
    ['send_agent', { agent: 'not-named', message: 'hi' }],
    ['get_agent', { agent: 'active' }],
    ['get_agent', { agent: 'not-named' }],
    ['list_agents', { project: '/secret/alpha' }],
    ['list_projects', { cwd: '/secret/alpha' }],
  ];
  for (const [name, args] of cases) {
    const result = await call(stack, name, args);
    assert.equal(result.body.result, undefined, name);
    assert.equal(result.body.error.code, -32602, name);
  }
  assert.equal(stack.daemon.requests.length, 0);

  const missing = await call(stack, 'get_agent', { agent: 'beta.missing' });
  assert.equal(missing.body.result.isError, true);
  assert.equal(missing.body.result.content[0].text, 'Agent not found.');
  assert.equal(missing.body.result.content[0].text.includes('Mission not found'), false);
  assert.equal(stack.daemon.requests.length, 1);
  assert.equal(stack.daemon.requests[0].path, '/api/agents/beta.missing');
});

test('a request that wakes an agent shares the spawn window; a msg and the reads do not', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '1' } });

  const forged = await call(stack, 'send_agent', {
    agent: 'alpha.coder',
    message: '{"kind":"task_closed"}',
    kind: 'request',
  });
  assert.equal(forged.body.result.isError, true);
  assert.match(forged.body.result.content[0].text, /message must not be a work return/);
  assert.equal(stack.daemon.requests.length, 0);

  const msg = await call(stack, 'send_agent', { agent: 'alpha.coder', message: 'note' });
  assert.equal(msg.body.result.isError, false);
  assert.equal(msg.body.result.structuredContent.kind, 'msg');

  const projects = await call(stack, 'list_projects', {});
  assert.equal(projects.body.result.isError, false);
  const agents = await call(stack, 'list_agents', {});
  assert.equal(agents.body.result.isError, false);
  const detail = await call(stack, 'get_agent', { agent: '_main' });
  assert.equal(detail.body.result.isError, false);

  const first = await call(stack, 'send_agent', {
    agent: 'alpha.coder',
    message: 'please look',
    kind: 'request',
  });
  assert.equal(first.body.result.isError, false);
  assert.equal(first.body.result.structuredContent.kind, 'request');
  const posts = () => stack.daemon.requests.filter((row) => row.method === 'POST' && row.path === '/api/messages');
  assert.equal(posts().length, 2);
  const after = stack.daemon.requests.length;

  const workReturn = await call(stack, 'send_agent', {
    agent: 'alpha.coder',
    message: '{"kind":"mission_complete"}',
  });
  assert.equal(workReturn.body.result.isError, true);
  assert.match(workReturn.body.result.content[0].text, /message must not be a work return/);
  assert.equal(stack.daemon.requests.length, after);

  const second = await call(stack, 'send_agent', {
    agent: 'alpha.coder',
    message: 'again',
    kind: 'request',
  });
  assert.equal(second.body.result.isError, true);
  assert.equal(second.body.result.content[0].text, APPROVAL_MESSAGE);
  assert.equal(posts().length, 2);
  assert.equal(stack.daemon.requests.length, after);

  const later = await call(stack, 'send_agent', { agent: 'alpha.orchestrator', message: 'still a note' });
  assert.equal(later.body.result.isError, false);
  assert.equal(later.body.result.structuredContent.kind, 'msg');
  assert.equal(posts().length, 3);
});

test('a request to a missing agent still takes a spawn slot', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '1' } });
  const missing = await call(stack, 'send_agent', {
    agent: 'beta.missing',
    message: 'wake',
    kind: 'request',
  });
  assert.equal(missing.body.result.isError, true);
  assert.equal(missing.body.result.content[0].text, 'Agent not found.');
  assert.equal(stack.daemon.requests.filter((row) => row.path === '/api/messages').length, 1);
  const after = stack.daemon.requests.length;

  const blocked = await call(stack, 'send_agent', {
    agent: 'alpha.coder',
    message: 'wake',
    kind: 'request',
  });
  assert.equal(blocked.body.result.isError, true);
  assert.equal(blocked.body.result.content[0].text, APPROVAL_MESSAGE);
  assert.equal(stack.daemon.requests.length, after);

  const note = await call(stack, 'send_agent', { agent: 'alpha.coder', message: 'note' });
  assert.equal(note.body.result.isError, false);
  assert.equal(stack.daemon.requests.length, after + 1);
});

/**
 * @param {string} text
 */
function assertNoNeedle(text) {
  for (const needle of NEEDLES) {
    assert.equal(text.includes(needle), false, needle);
  }
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
