import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStack } from '../helpers/standalone.js';

test('initialize, tools/list and ask_main stay on the closed daemon routes', async (t) => {
  const stack = await openStack(t);
  const session = await rpc(stack, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'contract', version: '0' },
  }, 1);
  assert.equal(session.httpStatus, 200);
  assert.equal(session.body.result.protocolVersion, '2025-06-18');
  assert.equal(session.body.result.serverInfo.name, 'timon-mcp');
  assert.equal(stack.daemon.requests.length, 0);

  const listed = await rpc(stack, 'tools/list', {}, 2);
  assert.equal(listed.httpStatus, 200);
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'ask_main', 'get_reply', 'wait', 'list_missions', 'list_tasks', 'create_task',
    'list_all_missions', 'get_mission_state', 'get_mission_message', 'send_mission',
    'steer_mission', 'interrupt_mission', 'stop_mission', 'stop_scope', 'launch_mission',
    'list_all_tasks', 'get_task', 'add_task', 'update_task', 'move_task',
    'list_projects', 'list_agents', 'get_agent', 'send_agent',
    'list_pipelines', 'get_pipeline', 'run_pipeline', 'get_pipeline_run',
    'list_workflows', 'get_workflow', 'list_workflow_runs', 'run_workflow',
    'list_routines', 'get_routine',
  ]);

  const asked = await rpc(stack, 'tools/call', {
    name: 'ask_main',
    arguments: { message: 'hello from mcp' },
  }, 3);
  assert.equal(asked.httpStatus, 200);
  assert.equal(asked.body.result.isError, false);
  const data = asked.body.result.structuredContent;
  assert.equal(data.agent, '_main');
  assert.equal(data.status, 'running');
  assert.match(data.mission_id, /^[0-9a-f-]{36}$/);
  assert.equal(asked.text.includes(stack.token), false);
  assert.equal(asked.text.includes('[redacted]'), false);

  assert.equal(stack.daemon.requests.length, 2);
  const spawn = stack.daemon.requests[0];
  const read = stack.daemon.requests[1];
  assert.equal(spawn.method, 'POST');
  assert.equal(spawn.path, '/api/missions');
  assert.equal(spawn.search, '');
  assert.deepEqual(JSON.parse(spawn.bodyText), { agent: '_main', mission: 'hello from mcp' });
  assert.equal(spawn.authorization, `Bearer ${stack.token}`);
  assert.equal(read.method, 'GET');
  assert.equal(read.path, `/api/missions/${data.mission_id}`);
  assert.equal(read.search, '?view=status');
  assert.deepEqual(stack.journal, [
    { method: 'POST', path: '/api/missions', status: 201 },
    { method: 'GET', path: `/api/missions/${data.mission_id}`, status: 200 },
  ]);
  assert.equal(JSON.stringify(stack.logs).includes(stack.token), false);
  assert.equal(JSON.stringify(stack.journal).includes(stack.token), false);
});

/**
 * @param {Awaited<ReturnType<typeof openStack>>} stack
 * @param {string} method
 * @param {unknown} params
 * @param {number} id
 */
async function rpc(stack, method, params, id) {
  const response = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stack.bearer}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  return { httpStatus: response.status, text, body: JSON.parse(text) };
}
