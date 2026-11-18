import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BEARER_SECRET } from '../../lib/constants.js';
import { validateInput } from '../../lib/mcp/tools.js';
import { ROSTER_TOOLS } from '../../host/agent-tools.js';
import { createDaemonClient } from '../../host/daemon.js';
import { KANBAN_TOOLS } from '../../host/kanban-tools.js';
import { MISSION_TOOLS } from '../../host/mission-tools.js';
import {
  AGENT_NAME_MAX,
  AGENT_PATH,
  AGENT_READ_MAX,
  DIRECT_FROM_AGENT,
  DIRECT_FROM_MISSION,
  DISPLAY_AGENT,
  NAMED_AGENT,
  isAgentPath,
  isDisplayAgent,
  isNamedAgent,
  shownAgent,
} from '../../host/names.js';
import { openStack } from '../helpers/standalone.js';

/** Release 0.1.8 `projects.js` `SLUG_RE` is `{1,64}`. */
const PROJECT_MAX = 64;
/** Release 0.1.8 `agent-roles.js` `ID_RE` is 2..32. */
const ROLE_MAX = 32;
/** `createEphemeralAgent`: `_eph-` + hint(24) + `-` + 8 hex. */
const EPHEMERAL_MINTED = 5 + 24 + 1 + 8;

const CANONICAL = `${'a'.repeat(PROJECT_MAX)}.${'b'.repeat(ROLE_MAX)}`;
const MINTED_EPHEMERAL = `_eph-${'a'.repeat(24)}-0123abcd`;
/** `PROJECT_PATTERN` is 1..40, so `<project>.<role>` is at most 81. */
const PLUGIN_NAMED = `${'a'.repeat(40)}.${'b'.repeat(40)}`;
const NAMED_OVER = `${'a'.repeat(41)}.${'b'.repeat(40)}`;
/** Plugin facade `NameSchema` stops a write at 100. A stored name of that length is still a read. */
const STORED = 'c'.repeat(100);
const READ_MAX = 'd'.repeat(AGENT_READ_MAX);
const READ_OVER = 'e'.repeat(AGENT_READ_MAX + 1);

const HOST_TOOLS = [...ROSTER_TOOLS, ...MISSION_TOOLS, ...KANBAN_TOOLS];
const READ_TOOLS = ['get_agent', 'list_all_missions', 'list_all_tasks', 'stop_scope'];
const LAUNCH_TOOLS = ['add_task', 'launch_mission', 'send_agent', 'update_task'];

test('97 is the fabricated name, and a read stops at one directory', () => {
  assert.equal(CANONICAL.length, PROJECT_MAX + 1 + ROLE_MAX);
  assert.equal(AGENT_NAME_MAX, CANONICAL.length);
  assert.equal(AGENT_NAME_MAX, 97);
  assert.equal(AGENT_READ_MAX, 255);
  assert.equal(MINTED_EPHEMERAL.length, EPHEMERAL_MINTED);
  assert.ok(EPHEMERAL_MINTED < AGENT_NAME_MAX);
  assert.equal(PLUGIN_NAMED.length, 81);
  assert.equal(NAMED_OVER.length, 82);
  assert.equal(STORED.length, 100);
  assert.equal(READ_OVER.length, AGENT_READ_MAX + 1);
  assert.equal(NAMED_AGENT.source.includes('(?='), false);
  assert.equal(NAMED_AGENT.source.includes(`{1,${AGENT_NAME_MAX}}`), false);
  assert.equal(NAMED_AGENT.source.includes(`{1,${AGENT_READ_MAX}}`), false);
  for (const source of [DISPLAY_AGENT.source, AGENT_PATH.source]) {
    assert.equal(source.includes(`{1,${AGENT_READ_MAX}}`), true, source);
    assert.equal(source.includes(`{1,${AGENT_NAME_MAX}}`), false, source);
  }
});

test('a read keeps a stored name through 255 characters and drops one past it', () => {
  for (const name of [CANONICAL, MINTED_EPHEMERAL, PLUGIN_NAMED, STORED, READ_MAX]) {
    assert.equal(isDisplayAgent(name), true, name);
    assert.equal(isAgentPath(name), true, name);
    assert.equal(shownAgent(name), name, name);
  }
  assert.equal(isDisplayAgent(READ_OVER), false);
  assert.equal(isAgentPath(READ_OVER), false);
  assert.equal(shownAgent(READ_OVER), null);
  assert.equal(isNamedAgent(STORED), false);
  assert.equal(isNamedAgent(READ_MAX), false);
  assert.equal(isNamedAgent(CANONICAL), false);
  assert.equal(isNamedAgent(NAMED_OVER), false);
  assert.equal(isNamedAgent(PLUGIN_NAMED), true);
  assert.equal(isNamedAgent('_main'), true);
  assert.equal(isNamedAgent(MINTED_EPHEMERAL), false);
  assert.equal(isAgentPath('foo..bar'), false);
  assert.equal(isAgentPath('.'), false);
  assert.equal(isAgentPath('..'), false);
  assert.equal(isAgentPath('main'), false);
  assert.equal(isAgentPath('ephemeral'), false);
  assert.equal(shownAgent('.'), null);
  assert.equal(shownAgent('..'), null);
  assert.equal(shownAgent('main'), 'main');
});

test('read schemas accept a stored name and launch schemas stay on the named pattern', () => {
  const seen = [];
  for (const tool of HOST_TOOLS) {
    const agent = tool.inputSchema?.properties?.agent;
    if (!agent) continue;
    seen.push(tool.name);
    const pattern = new RegExp(agent.pattern);
    if (agent.pattern === AGENT_PATH.source) {
      assert.equal(agent.maxLength, AGENT_READ_MAX, tool.name);
      assert.equal(pattern.test(STORED), true, tool.name);
      assert.equal(pattern.test(READ_MAX), true, tool.name);
      assert.equal(pattern.test(READ_OVER), false, tool.name);
      assert.equal(pattern.test('foo..bar'), false, tool.name);
      assert.equal(pattern.test('main'), false, tool.name);
      assert.equal(validateInput(tool.inputSchema, { agent: STORED }).ok, true, tool.name);
      assert.equal(validateInput(tool.inputSchema, { agent: READ_OVER }).ok, false, tool.name);
    } else {
      assert.equal(agent.pattern, NAMED_AGENT.source, tool.name);
      assert.equal(agent.maxLength, AGENT_NAME_MAX, tool.name);
      assert.equal(pattern.test(PLUGIN_NAMED), true, tool.name);
      assert.equal(pattern.test(STORED), false, tool.name);
      assert.equal(pattern.test(MINTED_EPHEMERAL), false, tool.name);
      assert.equal(pattern.test(NAMED_OVER), false, tool.name);
      const refused = launchSample(tool, STORED);
      const kept = launchSample(tool, PLUGIN_NAMED);
      assert.equal(validateInput(tool.inputSchema, refused).ok, false, tool.name);
      assert.equal(validateInput(tool.inputSchema, kept).ok, true, tool.name);
    }
  }
  assert.deepEqual(seen.sort(), [...READ_TOOLS, ...LAUNCH_TOOLS].sort());
});

test('a 100-character name is listed, read, filtered, and projected, and a longer one is not', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '5' } });
  const client = createDaemonClient({
    origin: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    env: { [BEARER_SECRET]: stack.bearer },
    bearerName: BEARER_SECRET,
  });
  stack.daemon.agents.set(STORED, storedAgent(STORED));
  stack.daemon.agents.set(READ_OVER, storedAgent(READ_OVER));
  stack.daemon.missions.set('longmission01', storedMission('longmission01', STORED));
  stack.daemon.missions.set('overmission01', storedMission('overmission01', READ_OVER));
  stack.daemon.tasks.set('longtask0001', storedTask('longtask0001', STORED));
  stack.daemon.tasks.set('overtask0001', storedTask('overtask0001', READ_OVER));

  const listed = await call(stack, 'list_agents', {});
  assert.equal(listed.body.result.isError, false);
  const listedNames = listed.body.result.structuredContent.agents.map((row) => row.name);
  assert.equal(listedNames.includes(STORED), true);
  assert.equal(listedNames.includes(READ_OVER), false);
  assert.equal(listed.text.includes('SECRET SYSTEM PROMPT'), false);

  const filteredAgents = await call(stack, 'list_agents', { project: 'alpha' });
  const alphaNames = filteredAgents.body.result.structuredContent.agents.map((row) => row.name);
  assert.equal(alphaNames.includes(STORED), true);
  assert.equal(alphaNames.includes(READ_OVER), false);

  const detail = await call(stack, 'get_agent', { agent: STORED });
  assert.equal(detail.body.result.isError, false);
  assert.equal(detail.body.result.structuredContent.name, STORED);
  assert.equal(detail.body.result.structuredContent.project, 'alpha');
  assert.equal(detail.body.result.structuredContent.ephemeral, false);
  assert.equal(stack.daemon.requests.at(-1).path, `/api/agents/${STORED}`);
  assert.equal(detail.text.includes('SECRET SYSTEM PROMPT'), false);

  const missions = await call(stack, 'list_all_missions', { agent: STORED });
  assert.equal(missions.body.result.isError, false);
  assert.deepEqual(
    missions.body.result.structuredContent.missions.map((row) => row.id),
    ['longmission01'],
  );
  assert.equal(missions.body.result.structuredContent.missions[0].agent_name, STORED);
  assert.equal(stack.daemon.requests.at(-1).search, `?agent=${STORED}&limit=50`);

  const state = await call(stack, 'get_mission_state', { mission_id: 'longmission01' });
  assert.equal(state.body.result.structuredContent.agent_name, STORED);
  assert.equal(state.body.result.structuredContent.parent_agent, STORED);
  assert.equal(state.body.result.structuredContent.children[0].agent_name, STORED);

  const hiddenMission = await call(stack, 'get_mission_state', { mission_id: 'overmission01' });
  assert.equal(hiddenMission.body.result.structuredContent.agent_name, null);
  assert.equal(hiddenMission.body.result.structuredContent.parent_agent, null);
  assert.equal(hiddenMission.body.result.structuredContent.children[0].agent_name, null);

  const tasks = await call(stack, 'list_all_tasks', { agent: STORED });
  assert.equal(tasks.body.result.isError, false);
  assert.deepEqual(
    tasks.body.result.structuredContent.tasks.map((row) => row.id),
    ['longtask0001'],
  );
  assert.equal(tasks.body.result.structuredContent.tasks[0].agent_name, STORED);

  const task = await call(stack, 'get_task', { task_id: 'longtask0001' });
  assert.equal(task.body.result.structuredContent.agent_name, STORED);
  const hiddenTask = await call(stack, 'get_task', { task_id: 'overtask0001' });
  assert.equal(hiddenTask.body.result.structuredContent.agent_name, null);
  assert.equal(hiddenTask.text.includes(READ_OVER), false);

  const ceiling = await call(stack, 'get_agent', { agent: READ_MAX });
  assert.equal(ceiling.body.result.isError, true);
  assert.equal(ceiling.body.result.content[0].text, 'Agent not found.');
  assert.equal(stack.daemon.requests.at(-1).path, `/api/agents/${READ_MAX}`);

  const before = stack.daemon.requests.length;
  const dropped = await call(stack, 'get_agent', { agent: READ_OVER });
  assert.equal(dropped.body.error.code, -32602);
  const droppedFilter = await call(stack, 'list_all_missions', { agent: READ_OVER });
  assert.equal(droppedFilter.body.error.code, -32602);
  for (const [name, args] of [
    ['launch_mission', { agent: STORED, message: 'no' }],
    ['send_agent', { agent: STORED, message: 'no' }],
    ['add_task', { project: 'alpha', title: 'Nope', agent: STORED, type: 'chore' }],
    ['update_task', { task_id: 'longtask0001', agent: STORED }],
  ]) {
    const refused = await call(stack, name, args);
    assert.equal(refused.body.error?.code, -32602, name);
  }
  assert.equal(stack.daemon.requests.length, before);

  const read = await client.request('GET', `/api/agents/${STORED}`);
  assert.equal(read.status, 200);
  const ceilingRead = await client.request('GET', `/api/agents/${READ_MAX}`);
  assert.equal(ceilingRead.status, 404);
  const filtered = await client.request('GET', '/api/missions', undefined, { agent: STORED, limit: '1' });
  assert.equal(filtered.status, 200);
  await assert.rejects(
    () => client.request('GET', `/api/agents/${READ_OVER}`),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/missions', undefined, { agent: READ_OVER, limit: '1' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/messages', {
      to_agent: STORED,
      payload: 'no',
      kind: 'msg',
      from_mission: DIRECT_FROM_MISSION,
      from_agent: DIRECT_FROM_AGENT,
    }),
    (err) => err.code === 'route_denied',
  );
});

/**
 * @param {{ inputSchema: { required?: string[] } }} tool
 * @param {string} agent
 */
function launchSample(tool, agent) {
  /** @type {Record<string, unknown>} */
  const sample = { agent };
  const required = tool.inputSchema.required ?? [];
  if (required.includes('message')) sample.message = 'no';
  if (required.includes('project')) sample.project = 'alpha';
  if (required.includes('title')) sample.title = 'T';
  if (required.includes('type')) sample.type = 'chore';
  if (required.includes('task_id')) sample.task_id = 'task0001';
  return sample;
}

/**
 * @param {string} name
 */
function storedAgent(name) {
  return {
    name,
    role: 'coder',
    project: 'alpha',
    orchestrator: false,
    reports_to: null,
    ephemeral: false,
  };
}

/**
 * @param {string} id
 * @param {string} agent
 */
function storedMission(id, agent) {
  return {
    id,
    agent_name: agent,
    status: 'running',
    title: 'stored',
    started_at: 1,
    ended_at: null,
    running: true,
    liveness: 'idle',
    turn_active: false,
    exit_code: null,
    task_id: null,
    parent_agent: agent,
    parent_mission_id: null,
    children: [{ id: `${id}child`, agent_name: agent, status: 'running', started_at: 1 }],
  };
}

/**
 * @param {string} id
 * @param {string} agent
 */
function storedTask(id, agent) {
  return {
    id,
    title: 'Stored',
    description: '',
    status: 'PENDING',
    agent_name: agent,
    project: 'alpha',
    type: 'chore',
    priority: 1,
    deps: '[]',
    base_branch: null,
    blocked_reason: null,
    done_comment: null,
    created_at: 30,
    updated_at: 31,
  };
}

/**
 * @param {{ host: { baseUrl: string }, bearer: string }} stack
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
