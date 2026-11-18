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
const CANONICAL_OVER = `${CANONICAL}b`;
const EPHEMERAL = `_eph-${'a'.repeat(AGENT_NAME_MAX - '_eph-'.length)}`;
const EPHEMERAL_OVER = `${EPHEMERAL}a`;
const MINTED_EPHEMERAL = `_eph-${'a'.repeat(24)}-0123abcd`;
const PLUGIN_NAMED = `${'a'.repeat(40)}.${'b'.repeat(40)}`;

const HOST_TOOLS = [...ROSTER_TOOLS, ...MISSION_TOOLS, ...KANBAN_TOOLS];

test('the shared ceiling is the daemon canonical name, which is longer than an ephemeral id', () => {
  assert.equal(CANONICAL.length, PROJECT_MAX + 1 + ROLE_MAX);
  assert.equal(AGENT_NAME_MAX, CANONICAL.length);
  assert.equal(MINTED_EPHEMERAL.length, EPHEMERAL_MINTED);
  assert.ok(EPHEMERAL_MINTED < AGENT_NAME_MAX);
  assert.equal(EPHEMERAL.length, AGENT_NAME_MAX);
  assert.equal(EPHEMERAL_OVER.length, AGENT_NAME_MAX + 1);
  assert.equal(CANONICAL_OVER.length, AGENT_NAME_MAX + 1);
  assert.equal(PLUGIN_NAMED.length, 81);
  for (const source of [NAMED_AGENT.source, DISPLAY_AGENT.source, AGENT_PATH.source]) {
    assert.equal(source.includes(`{1,${AGENT_NAME_MAX}}`), true, source);
  }
});

test('a canonical name and an ephemeral id are kept at the ceiling and dropped one past it', () => {
  for (const name of [CANONICAL, EPHEMERAL, MINTED_EPHEMERAL, PLUGIN_NAMED]) {
    assert.equal(isDisplayAgent(name), true, name);
    assert.equal(isAgentPath(name), true, name);
    assert.equal(shownAgent(name), name, name);
  }
  for (const name of [CANONICAL_OVER, EPHEMERAL_OVER]) {
    assert.equal(isDisplayAgent(name), false, name);
    assert.equal(isAgentPath(name), false, name);
    assert.equal(shownAgent(name), null, name);
    assert.equal(isNamedAgent(name), false, name);
  }
  assert.equal(isNamedAgent(PLUGIN_NAMED), true);
  assert.equal(isNamedAgent('_main'), true);
  assert.equal(isNamedAgent(EPHEMERAL), false);
  assert.equal(isNamedAgent(MINTED_EPHEMERAL), false);
  assert.equal(isAgentPath('foo..bar'), false);
  assert.equal(isAgentPath('.'), false);
  assert.equal(isAgentPath('..'), false);
  assert.equal(isAgentPath('main'), false);
  assert.equal(isAgentPath('ephemeral'), false);
  assert.equal(shownAgent('main'), 'main');
});

test('every agent field of a tool schema uses the same ceiling', () => {
  const seen = [];
  for (const tool of HOST_TOOLS) {
    const agent = tool.inputSchema?.properties?.agent;
    if (!agent) continue;
    seen.push(tool.name);
    assert.equal(agent.maxLength, AGENT_NAME_MAX, tool.name);
    const pattern = new RegExp(agent.pattern);
    assert.equal(pattern.test(CANONICAL_OVER), false, tool.name);
    assert.equal(pattern.test(EPHEMERAL_OVER), false, tool.name);
    if (agent.pattern === AGENT_PATH.source) {
      assert.equal(pattern.test(CANONICAL), true, tool.name);
      assert.equal(pattern.test(EPHEMERAL), true, tool.name);
      assert.equal(validateInput(tool.inputSchema, { agent: CANONICAL_OVER }).ok, false, tool.name);
    } else {
      assert.equal(agent.pattern, NAMED_AGENT.source, tool.name);
      assert.equal(pattern.test(PLUGIN_NAMED), true, tool.name);
      assert.equal(pattern.test(EPHEMERAL), false, tool.name);
    }
  }
  assert.deepEqual(seen.sort(), [
    'add_task',
    'get_agent',
    'launch_mission',
    'list_all_missions',
    'list_all_tasks',
    'send_agent',
    'stop_scope',
    'update_task',
  ]);
});

test('get_agent reads a max-length name and refuses one character more', async (t) => {
  const stack = await openStack(t);
  const client = createDaemonClient({
    origin: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    env: { [BEARER_SECRET]: stack.bearer },
    bearerName: BEARER_SECRET,
  });

  const kept = await call(stack, 'get_agent', { agent: CANONICAL });
  assert.equal(kept.body.result.isError, true);
  assert.equal(kept.body.result.content[0].text, 'Agent not found.');
  assert.equal(stack.daemon.requests.at(-1).path, `/api/agents/${CANONICAL}`);

  const eph = await call(stack, 'get_agent', { agent: EPHEMERAL });
  assert.equal(eph.body.result.isError, true);
  assert.equal(eph.body.result.content[0].text, 'Agent not found.');
  assert.equal(stack.daemon.requests.at(-1).path, `/api/agents/${EPHEMERAL}`);

  const before = stack.daemon.requests.length;
  const dropped = await call(stack, 'get_agent', { agent: CANONICAL_OVER });
  assert.equal(dropped.body.error.code, -32602);
  const droppedEph = await call(stack, 'get_agent', { agent: EPHEMERAL_OVER });
  assert.equal(droppedEph.body.error.code, -32602);
  assert.equal(stack.daemon.requests.length, before);

  const read = await client.request('GET', `/api/agents/${CANONICAL}`);
  assert.equal(read.status, 404);
  await assert.rejects(
    () => client.request('GET', `/api/agents/${CANONICAL_OVER}`),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', `/api/agents/${EPHEMERAL_OVER}`),
    (err) => err.code === 'route_denied',
  );
});

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
