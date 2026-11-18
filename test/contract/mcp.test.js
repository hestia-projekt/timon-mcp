import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { apply } from '../../lib/index.js';
import { APPROVAL_MESSAGE, BEARER_SECRET } from '../../lib/constants.js';
import { assertHermesHandshake } from '../helpers/hermes-handshake.js';
import {
  createFakeCtx,
  PluginMissionError,
  PluginPolicyError,
  PluginTaskError,
  requestContext,
} from '../helpers/fake-ctx.js';

const PLUGIN = 'timon-mcp';
const BEARER = randomBytes(32).toString('base64url');
const PUBLIC = 'https://mcp.example';
const CHALLENGE = `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`;

test('initialize negotiates a supported version and answers an unknown one with the latest', async (t) => {
  const ctx = await open(t);
  const current = await post(ctx, rpc('initialize', client('2025-06-18')));
  assert.equal(current.response.status, 200);
  assert.match(current.response.headers.get('content-type') || '', /application\/json/);
  assert.equal(current.json.result.protocolVersion, '2025-06-18');
  assert.equal(current.json.result.serverInfo.name, PLUGIN);
  assert.equal(current.response.headers.get('mcp-session-id'), null);

  const previous = await post(ctx, rpc('initialize', client('2025-03-26')));
  assert.equal(previous.json.result.protocolVersion, '2025-03-26');

  const unknown = await post(ctx, rpc('initialize', client('1999-01-01')));
  assert.equal(unknown.response.status, 200);
  assert.equal(unknown.json.error, undefined);
  assert.equal(unknown.json.result.protocolVersion, '2025-06-18');

  const missing = await post(ctx, rpc('initialize', { capabilities: {}, clientInfo: { name: 't', version: '0' } }));
  assert.equal(missing.json.error.code, -32602);
});

test('Hermes initialize negotiates from the body and the header applies afterwards', async (t) => {
  const ctx = await open(t);
  await assertHermesHandshake(async (body, headers = {}) => {
    const sent = await post(ctx, body, headers);
    return { status: sent.response.status, json: sent.json };
  });

  const note = await post(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' }, {
    'mcp-protocol-version': '2026-07-28',
  });
  assert.equal(note.response.status, 400);
  assert.equal(note.json.error.code, -32600);
});

test('an unsupported MCP-Protocol-Version header is rejected and a session id is optional', async (t) => {
  const ctx = await open(t);
  const rejected = await post(ctx, rpc('ping'), { 'mcp-protocol-version': '1999-01-01' });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.json.error.code, -32600);

  const accepted = await post(ctx, rpc('ping'), { 'mcp-protocol-version': '2025-03-26', 'mcp-session-id': 'optional' });
  assert.equal(accepted.response.status, 200);
  assert.deepEqual(accepted.json.result, {});
  assert.equal(accepted.response.headers.get('mcp-session-id'), null);
});

test('notifications get an empty 202, and GET or DELETE are refused', async (t) => {
  const ctx = await open(t);
  const note = await post(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.response.status, 202);
  assert.equal(note.text, '');

  const root = `${ctx.baseUrl}/api/plugins/${PLUGIN}/mcp`;
  const got = await fetch(root);
  assert.equal(got.status, 405);
  assert.match(got.headers.get('allow') || '', /POST/);
  assert.equal((await got.json()).error, 'method_not_allowed');

  const deleted = await fetch(root, { method: 'DELETE' });
  assert.equal(deleted.status, 405);

  const batch = await post(ctx, [rpc('ping'), rpc('ping', undefined, 2)]);
  assert.equal(batch.response.status, 400);
  assert.equal(batch.json.error.code, -32600);
});

test('a request without a token is rejected', async (t) => {
  const ctx = await open(t);
  const response = await fetch(`${ctx.baseUrl}/api/plugins/${PLUGIN}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(rpc('ping')),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), CHALLENGE);
  const body = await response.json();
  assert.deepEqual(body, { error: 'unauthorized', message: 'authentication required' });
});

test('tools/list returns exactly the six tools, each with a strict schema', async (t) => {
  const ctx = await open(t);
  const listed = await post(ctx, rpc('tools/list'));
  const names = listed.json.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['ask_main', 'get_reply', 'wait', 'list_missions', 'list_tasks', 'create_task']);
  for (const tool of listed.json.result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.type, 'object');
  }
  assert.equal(ctx.state.calls.length, 0);
});

test('an unknown tool is refused without calling a facade', async (t) => {
  const ctx = await open(t);
  const refused = await post(ctx, rpc('tools/call', { name: 'kill_mission', arguments: { mission_id: 'x' } }));
  assert.equal(refused.response.status, 200);
  assert.equal(refused.json.result.isError, true);
  assert.equal(refused.json.result.content[0].text, 'unknown tool');
  assert.equal(ctx.state.calls.length, 0);

  const extra = await post(ctx, rpc('tools/call', { name: 'ask_main', arguments: { message: 'bonjour', agent: 'other' } }));
  assert.equal(extra.json.error.code, -32602);
  assert.equal(ctx.state.calls.length, 0);
});

test('a foreign Origin is refused and the same host is accepted', async (t) => {
  const ctx = await open(t);
  const foreign = await post(ctx, rpc('ping'), { origin: 'http://evil.example' });
  assert.equal(foreign.response.status, 403);
  assert.equal(foreign.json.error, 'forbidden_origin');
  assert.equal(ctx.state.calls.length, 0);

  const port = new URL(ctx.baseUrl).port;
  const same = await post(ctx, rpc('ping'), { origin: `http://127.0.0.1:${port}` });
  assert.equal(same.response.status, 200);
});

test('ask_main spawns _main or <project>.main and never an arbitrary agent', async (t) => {
  const ctx = await open(t);
  const before = ctx.state.calls.length;
  const started = await post(ctx, rpc('tools/call', { name: 'ask_main', arguments: { message: 'bonjour' } }));
  const body = payload(started.json);
  assert.equal(body.agent, '_main');
  assert.equal(body.status, 'running');
  assert.equal(typeof body.mission_id, 'string');
  const spawned = callsSince(ctx, before).filter((call) => call.method === 'spawn');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args[0], { agent: '_main', mission: 'bonjour' });

  const project = await post(ctx, rpc('tools/call', {
    name: 'ask_main',
    arguments: { message: 'suite', project: 'facturation' },
  }));
  assert.equal(payload(project.json).agent, 'facturation.main');
  const second = ctx.state.calls.filter((call) => call.method === 'spawn').at(-1);
  assert.deepEqual(second.args[0], { agent: 'facturation.main', mission: 'suite' });

  const mark = ctx.state.calls.length;
  for (const projectName of ['Facturation', 'a.b', '_main', '../pilot']) {
    const refused = await post(ctx, rpc('tools/call', {
      name: 'ask_main',
      arguments: { message: 'non', project: projectName },
    }));
    assert.equal(refused.json.error.code, -32602, projectName);
  }
  assert.equal(ctx.state.calls.length, mark);
});

test('ask_main with mission_id sends, and turn or process errors stay tool errors', async (t) => {
  const ctx = await open(t);
  const started = payload((await post(ctx, rpc('tools/call', {
    name: 'ask_main',
    arguments: { message: 'bonjour' },
  }))).json);
  const before = ctx.state.calls.length;
  const sent = await post(ctx, rpc('tools/call', {
    name: 'ask_main',
    arguments: { message: 'suite', mission_id: started.mission_id },
  }));
  const body = payload(sent.json);
  assert.equal(body.mission_id, started.mission_id);
  assert.equal(body.agent, '_main');
  const during = callsSince(ctx, before);
  assert.equal(during.some((call) => call.method === 'spawn'), false);
  const send = during.find((call) => call.method === 'send');
  assert.deepEqual(send.args, [started.mission_id, 'suite']);

  ctx.missions.send = async () => {
    throw new PluginMissionError('turn_in_progress', 'a turn is in progress');
  };
  const busy = await post(ctx, rpc('tools/call', {
    name: 'ask_main',
    arguments: { message: 'encore', mission_id: started.mission_id },
  }));
  assert.equal(busy.response.status, 200);
  assert.equal(busy.json.result.isError, true);
  assert.match(busy.json.result.content[0].text, /turn is in progress/);

  ctx.missions.send = async () => {
    throw new PluginMissionError('not_running', 'no process');
  };
  const dead = await post(ctx, rpc('tools/call', {
    name: 'ask_main',
    arguments: { message: 'encore', mission_id: started.mission_id },
  }));
  assert.equal(dead.response.status, 200);
  assert.match(dead.json.result.content[0].text, /no running process/);
});

test('facade calls from the route are outside the request store', async (t) => {
  const ctx = await open(t);
  const before = ctx.state.calls.length;
  await post(ctx, rpc('tools/call', { name: 'ask_main', arguments: { message: 'bonjour' } }));
  const during = callsSince(ctx, before);
  assert.ok(during.some((call) => call.facade === 'missions' && call.method === 'spawn'));
  for (const call of during) assert.equal(call.store, null);

  await requestContext.run({ scope: 'request' }, () => ctx.missions.list());
  assert.equal(ctx.state.calls.at(-1).store.scope, 'request');
});

test('spawn policy and kanban spawn_policy are readable tool errors, once', async (t) => {
  const ctx = await open(t);
  ctx.missions.spawn = async () => {
    throw new PluginPolicyError('timon-mcp', 'spawn', 'unsigned plugin');
  };
  const refused = await post(ctx, rpc('tools/call', { name: 'ask_main', arguments: { message: 'bonjour' } }));
  assert.equal(refused.response.status, 200);
  assert.equal(refused.json.result.isError, true);
  assert.equal(refused.json.result.content[0].text, APPROVAL_MESSAGE);
  assert.equal(ctx.state.calls.filter((call) => call.method === 'spawn').length, 1);

  ctx.kanban.add = async () => {
    throw new PluginTaskError('forbidden', 'needs approval', 'spawn_policy');
  };
  const task = await post(ctx, rpc('tools/call', {
    name: 'create_task',
    arguments: { project: 'facturation', title: 'Relire', description: 'le devis' },
  }));
  assert.equal(task.response.status, 200);
  assert.equal(task.json.result.isError, true);
  assert.equal(task.json.result.content[0].text, APPROVAL_MESSAGE);
  assert.equal(ctx.state.calls.filter((call) => call.method === 'add').length, 1);
});

test('get_reply returns summary and state when the message body is not readable', async (t) => {
  const ctx = await open(t);
  const prompt = `prompt-${Date.now()}`;
  const started = payload((await post(ctx, rpc('tools/call', {
    name: 'ask_main',
    arguments: { message: prompt },
  }))).json);
  const mission = await ctx.missions.get(started.mission_id);
  mission.messages = [];
  mission.summary = 'résumé court';
  const reply = payload((await post(ctx, rpc('tools/call', {
    name: 'get_reply',
    arguments: { mission_id: started.mission_id },
  }))).json);
  assert.equal(reply.message, null);
  assert.equal(reply.summary, 'résumé court');
  assert.equal(reply.status, 'running');
  assert.equal(reply.mission_id, started.mission_id);
  assert.equal(JSON.stringify(reply).includes(prompt), false);

  mission.messages = [{ text: 'réponse du pilote' }];
  const withMessage = payload((await post(ctx, rpc('tools/call', {
    name: 'get_reply',
    arguments: { mission_id: started.mission_id },
  }))).json);
  assert.equal(withMessage.message, 'réponse du pilote');

  const missing = await post(ctx, rpc('tools/call', { name: 'get_reply', arguments: { mission_id: 'absent' } }));
  assert.equal(missing.response.status, 200);
  assert.equal(missing.json.result.isError, true);
  assert.match(missing.json.result.content[0].text, /not found/);
});

test('list_missions hides the prompt and list_tasks hides the description', async (t) => {
  const ctx = await open(t);
  const prompt = `secret-prompt-${Date.now()}`;
  await post(ctx, rpc('tools/call', { name: 'ask_main', arguments: { message: prompt } }));
  const missions = payload((await post(ctx, rpc('tools/call', {
    name: 'list_missions',
    arguments: { status: 'running', limit: 10 },
  }))).json);
  assert.equal(missions.missions.length, 1);
  assert.deepEqual(Object.keys(missions.missions[0]).sort(), ['agent_name', 'ended_at', 'id', 'started_at', 'status', 'title']);
  assert.equal(JSON.stringify(missions).includes(prompt), false);

  const brief = `secret-brief-${Date.now()}`;
  const created = payload((await post(ctx, rpc('tools/call', {
    name: 'create_task',
    arguments: { project: 'facturation', title: 'Relire', description: brief },
  }))).json);
  assert.equal(created.agent, 'facturation.main');
  assert.equal(created.type, 'chore');
  assert.equal(created.status, 'PENDING');
  const added = ctx.state.calls.filter((call) => call.method === 'add').at(-1);
  assert.deepEqual(added.args[0], {
    project: 'facturation',
    title: 'Relire',
    description: brief,
    agent: 'facturation.main',
    type: 'chore',
  });

  const refused = await post(ctx, rpc('tools/call', {
    name: 'create_task',
    arguments: { project: 'facturation', title: 'Relire', description: brief, model: 'sonnet', pipeline: 'full' },
  }));
  assert.equal(refused.json.error.code, -32602);
  assert.equal(ctx.state.calls.filter((call) => call.method === 'add').length, 1);

  const tasks = payload((await post(ctx, rpc('tools/call', {
    name: 'list_tasks',
    arguments: { project: 'facturation', status: 'PENDING' },
  }))).json);
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].id, created.id);
  assert.equal(Object.hasOwn(tasks.tasks[0], 'description'), false);
  assert.equal(JSON.stringify(tasks).includes(brief), false);
});

test('wait returns immediately when the mission is finished and bounds a running one', async (t) => {
  const ctx = await open(t);
  const started = payload((await post(ctx, rpc('tools/call', {
    name: 'ask_main',
    arguments: { message: 'bonjour' },
  }))).json);
  const mission = await ctx.missions.get(started.mission_id);
  mission.status = 'completed';
  mission.summary = 'fait';
  const fastStart = Date.now();
  const fast = payload((await post(ctx, rpc('tools/call', {
    name: 'wait',
    arguments: { mission_id: started.mission_id, timeout_s: 5 },
  }))).json);
  assert.equal(fast.done, true);
  assert.equal(fast.summary, 'fait');
  assert.ok(Date.now() - fastStart < 1000);

  mission.status = 'running';
  const slowStart = Date.now();
  const slow = payload((await post(ctx, rpc('tools/call', {
    name: 'wait',
    arguments: { mission_id: started.mission_id, timeout_s: 0.2 },
  }))).json);
  const elapsed = Date.now() - slowStart;
  assert.equal(slow.done, false);
  assert.equal(slow.status, 'running');
  assert.ok(elapsed >= 150, `elapsed ${elapsed}`);
  assert.ok(elapsed < 1500, `elapsed ${elapsed}`);
});

test('wait completes when turn_complete fires', async (t) => {
  const ctx = await open(t);
  const started = payload((await post(ctx, rpc('tools/call', {
    name: 'ask_main',
    arguments: { message: 'bonjour' },
  }))).json);
  const pending = post(ctx, rpc('tools/call', {
    name: 'wait',
    arguments: { mission_id: started.mission_id, timeout_s: 5 },
  }));
  const start = Date.now();
  await until(() => ctx.state.listeners.some((entry) => entry.kind === 'turn_complete'));
  ctx.state.emit('turn_complete', { missionId: started.mission_id, outcome: 'completed' });
  const body = payload((await pending).json);
  assert.equal(body.done, true);
  assert.ok(Date.now() - start < 2000);
});

/**
 * @param {import('node:test').TestContext} t
 */
async function open(t) {
  const opened = await createFakeCtx({
    id: PLUGIN,
    secrets: { [BEARER_SECRET]: BEARER },
    settings: {
      public_url: PUBLIC,
      issuer: PUBLIC,
      resource: `${PUBLIC}/mcp`,
    },
  });
  t.after(() => opened.close());
  apply(opened.ctx);
  return Object.assign(opened, {
    missions: opened.ctx.missions,
    kanban: opened.ctx.kanban,
  });
}

/**
 * @param {{ baseUrl: string }} ctx
 * @param {object | unknown[]} body
 * @param {Record<string, string>} [headers]
 */
async function post(ctx, body, headers = {}) {
  const extra = { ...headers };
  let authorization = `Bearer ${BEARER}`;
  if (Object.prototype.hasOwnProperty.call(extra, 'authorization')) {
    authorization = extra.authorization;
    delete extra.authorization;
  }
  const sent = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
  if (authorization) sent.authorization = authorization;
  const response = await fetch(`${ctx.baseUrl}/api/plugins/${PLUGIN}/mcp`, {
    method: 'POST',
    headers: sent,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text) json = JSON.parse(text);
  return { response, text, json };
}

/**
 * @param {string} method
 * @param {object} [params]
 * @param {number} [id]
 */
function rpc(method, params, id = 1) {
  const message = { jsonrpc: '2.0', id, method };
  if (params !== undefined) message.params = params;
  return message;
}

/**
 * @param {string} protocolVersion
 */
function client(protocolVersion) {
  return { protocolVersion, capabilities: {}, clientInfo: { name: 'contract', version: '0' } };
}

/**
 * @param {object} json
 */
function payload(json) {
  assert.equal(json.result.isError, false);
  return JSON.parse(json.result.content[0].text);
}

/**
 * @param {{ state: { calls: object[] } }} ctx
 * @param {number} before
 */
function callsSince(ctx, before) {
  return ctx.state.calls.slice(before);
}

/**
 * @param {() => boolean} predicate
 */
async function until(predicate) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1000) throw new Error('timed out waiting for the listener');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
