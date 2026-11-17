import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL_MESSAGE, BEARER_SECRET } from '../../lib/constants.js';
import {
  AUTOMATION_READ_MAX_BYTES,
  DAEMON_ROUTES,
  RESPONSE_MAX_BYTES,
  RUN_INPUT_MAX_BYTES,
  automationTooLarge,
  createDaemonClient,
} from '../../host/daemon.js';
import { openStack } from '../helpers/standalone.js';

/** Exact `too_large` text. Release 0.1.8 has no shrinking query on these routes. */
const AUTOMATION_TOO_LARGE = Object.freeze({
  'GET /api/pipelines': 'too_large: GET /api/pipelines exceeded 8 MiB. Release 0.1.8 returns every pipeline and has no query that shrinks this response. The host cannot reduce this response.',
  'GET /api/pipelines/:auto': 'too_large: GET /api/pipelines/:auto exceeded 8 MiB. This call already reads one pipeline. Release 0.1.8 has no query that shrinks it, so the host cannot reduce this response.',
  'GET /api/pipelines/runs/:auto': 'too_large: GET /api/pipelines/runs/:auto exceeded 8 MiB. This call already reads one pipeline run. Release 0.1.8 has no query that shrinks it, so the host cannot reduce this response.',
  'GET /api/workflows': 'too_large: GET /api/workflows exceeded 8 MiB. Release 0.1.8 returns every workflow and has no query that shrinks this response. The host cannot reduce this response.',
  'GET /api/workflows/:auto': 'too_large: GET /api/workflows/:auto exceeded 8 MiB. This call already reads one workflow. Release 0.1.8 has no query that shrinks it, so the host cannot reduce this response.',
  'GET /api/workflows/:auto/runs': 'too_large: GET /api/workflows/:auto/runs exceeded 8 MiB. Release 0.1.8 returns every run of this workflow and has no query that shrinks this response. The host cannot reduce this response.',
  'GET /api/routines': 'too_large: GET /api/routines exceeded 8 MiB. Release 0.1.8 returns every routine and has no query that shrinks this response. The host cannot reduce this response.',
  'GET /api/routines/:auto': 'too_large: GET /api/routines/:auto exceeded 8 MiB. This call already reads one routine. Release 0.1.8 has no query that shrinks it, so the host cannot reduce this response.',
});

const NEEDLES = [
  'SECRET PIPELINE PROMPT',
  'SECRET WORKFLOW DRAFT',
  'SECRET WORKFLOW CONTEXT',
  'SECRET ROUTINE PROMPT',
  'SECRET TRIGGER',
  'SECRET INPUT',
  'hidden-model',
  'hidden-owner',
  'secret-skill',
  'bypass',
  '/secret/',
];

const PIPE_1 = {
  id: 'pipe-1',
  name: 'Feature flow',
  description: 'Plan and code',
  created_at: 10,
  updated_at: 11,
  inputs: ['feature'],
  steps: [
    { id: 'plan', agent: 'alpha.researcher', type: 'research', deps_on: [], priority: 2 },
    { id: 'code', agent: 'alpha.coder', type: 'code', deps_on: ['plan'], priority: null },
  ],
};

const PIPE_2 = {
  id: 'pipe-2',
  name: 'Spare',
  description: null,
  created_at: 1,
  updated_at: 1,
  inputs: ['spare'],
  steps: [
    { id: 'only', agent: 'alpha.coder', type: 'chore', deps_on: [], priority: null },
  ],
};

const WF_1 = {
  id: 'wf-1',
  slug: 'feature.flow',
  name: 'Feature',
  description: 'A workflow',
  project: 'alpha',
  enabled: true,
  published_version: 1,
  agent_name: 'alpha.orchestrator',
  created_at: 20,
  updated_at: 21,
  run_count: 2,
  last_run: { id: 'run-wf-1', status: 'running', started_at: 30, ended_at: null },
};

const WF_2 = {
  id: 'wf-2',
  slug: 'other',
  name: 'Other',
  description: null,
  project: 'beta',
  enabled: false,
  published_version: null,
  agent_name: 'beta.coder',
  created_at: 1,
  updated_at: 2,
  run_count: 0,
  last_run: null,
};

const RUN_NEW = {
  id: 'run-wf-1',
  workflow_id: 'wf-1',
  version: 1,
  status: 'running',
  started_at: 30,
  ended_at: null,
  error: null,
};

const RUN_OLD = {
  id: 'run-wf-old',
  workflow_id: 'wf-1',
  version: 1,
  status: 'ok',
  started_at: 10,
  ended_at: 12,
  error: null,
};

const ROUTINE_1 = {
  id: 'routine-1',
  name: 'Nightly',
  agent_name: 'alpha.coder',
  task_type: 'chore',
  cron_expr: '30 3 * * *',
  enabled: true,
  project: 'alpha',
  last_run_at: 40,
  next_run_at: 50,
  created_at: 5,
  updated_at: 6,
};

const ROUTINE_2 = {
  id: 'routine-2',
  name: 'Hidden',
  agent_name: 'beta.coder',
  task_type: 'code',
  cron_expr: '0 4 * * *',
  enabled: false,
  project: null,
  last_run_at: null,
  next_run_at: 60,
  created_at: 1,
  updated_at: 2,
};

test('pipeline, workflow, and routine tools project the fake daemon', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '20' } });

  const pipes = await call(stack, 'list_pipelines', {});
  assert.equal(pipes.body.result.isError, false);
  assert.deepEqual(pipes.body.result.structuredContent.pipelines, [PIPE_1, PIPE_2]);
  assert.equal(stack.daemon.requests.at(-1).method, 'GET');
  assert.equal(stack.daemon.requests.at(-1).path, '/api/pipelines');
  assert.equal(stack.daemon.requests.at(-1).search, '');
  assertNoNeedle(pipes.text);
  assert.equal(stack.daemon.pipelines.get('pipe-1').definition.steps[0].prompt.includes('SECRET PIPELINE PROMPT'), true);

  const onePipe = await call(stack, 'list_pipelines', { limit: 1 });
  assert.deepEqual(onePipe.body.result.structuredContent.pipelines, [PIPE_1]);
  assert.equal(stack.daemon.requests.at(-1).search, '');

  const pipe = await call(stack, 'get_pipeline', { pipeline_id: 'pipe-1' });
  assert.equal(pipe.body.result.isError, false);
  assert.deepEqual(pipe.body.result.structuredContent, PIPE_1);
  assert.equal(stack.daemon.requests.at(-1).path, '/api/pipelines/pipe-1');
  assert.equal(stack.daemon.requests.at(-1).search, '');
  assertNoNeedle(pipe.text);

  const spare = await call(stack, 'get_pipeline', { pipeline_id: 'pipe-2' });
  assert.deepEqual(spare.body.result.structuredContent, PIPE_2);
  assertNoNeedle(spare.text);

  const missingPipe = await call(stack, 'get_pipeline', { pipeline_id: 'missing-pipe' });
  assert.equal(missingPipe.body.result.isError, true);
  assert.match(missingPipe.body.result.content[0].text, /pipeline not found/);
  assert.equal(missingPipe.text.includes('Mission not found'), false);

  const runsAsId = await call(stack, 'get_pipeline', { pipeline_id: 'runs' });
  assert.equal(runsAsId.body.result.isError, true);
  assert.match(runsAsId.body.result.content[0].text, /pipeline not found/);
  assert.equal(stack.daemon.requests.at(-1).path, '/api/pipelines/runs');

  const beforeRun = stack.daemon.requests.length;
  const started = await call(stack, 'run_pipeline', {
    pipeline_id: 'pipe-1',
    input: { feature: 'login' },
  });
  assert.equal(started.body.result.isError, false);
  assert.deepEqual(started.body.result.structuredContent, {
    run_id: 'prun-2',
    pipeline_id: 'pipe-1',
    started_at: 1_700_000_000_100,
    steps: [
      { step_id: 'plan', task_id: 'task-plan' },
      { step_id: 'code', task_id: 'task-code' },
    ],
  });
  assertNoNeedle(started.text);
  assert.equal(started.text.includes('login'), false);
  const posted = stack.daemon.requests[beforeRun];
  assert.equal(posted.method, 'POST');
  assert.equal(posted.path, '/api/pipelines/pipe-1/run');
  assert.equal(posted.search, '');
  assert.deepEqual(JSON.parse(posted.bodyText), { input: { feature: 'login' } });

  const emptyRun = await call(stack, 'run_pipeline', { pipeline_id: 'pipe-1' });
  assert.equal(emptyRun.body.result.isError, false);
  assert.deepEqual(JSON.parse(stack.daemon.requests.at(-1).bodyText), { input: {} });

  const status = await call(stack, 'get_pipeline_run', { run_id: 'prun-1' });
  assert.equal(status.body.result.isError, false);
  assert.deepEqual(status.body.result.structuredContent, {
    run: {
      run_id: 'prun-1',
      pipeline_id: 'pipe-1',
      pipeline_name: 'Feature flow',
      started_at: 100,
    },
    steps: [
      {
        step_id: 'plan',
        task_id: 'task-plan',
        title: 'Feature flow · plan',
        agent: 'alpha.researcher',
        type: 'research',
        status: 'PENDING',
        mission_id: null,
      },
      {
        step_id: 'code',
        task_id: 'task-code',
        title: 'Feature flow · code',
        agent: 'alpha.coder',
        type: 'code',
        status: 'PENDING',
        mission_id: 'mission-code-1',
      },
    ],
  });
  assert.equal(stack.daemon.requests.at(-1).path, '/api/pipelines/runs/prun-1');
  assert.equal(stack.daemon.requests.at(-1).search, '');
  assertNoNeedle(status.text);
  assert.equal(stack.daemon.pipelineRuns.get('prun-1').run.input.feature, 'SECRET INPUT');

  const followed = await call(stack, 'get_pipeline_run', { run_id: 'prun-2' });
  assert.equal(followed.body.result.structuredContent.run.run_id, 'prun-2');
  assert.equal(Object.hasOwn(followed.body.result.structuredContent.run, 'input'), false);
  assert.equal(followed.text.includes('login'), false);

  const missingRun = await call(stack, 'get_pipeline_run', { run_id: 'missing-run' });
  assert.equal(missingRun.body.result.isError, true);
  assert.match(missingRun.body.result.content[0].text, /run not found/);

  const flows = await call(stack, 'list_workflows', {});
  assert.equal(flows.body.result.isError, false);
  assert.deepEqual(flows.body.result.structuredContent.workflows, [WF_1, WF_2]);
  assert.equal(stack.daemon.requests.at(-1).path, '/api/workflows');
  assert.equal(stack.daemon.requests.at(-1).search, '');
  assertNoNeedle(flows.text);
  assert.equal(stack.daemon.workflows.get('wf-1').draft.includes('SECRET WORKFLOW DRAFT'), true);

  const alpha = await call(stack, 'list_workflows', { project: 'alpha', limit: 10 });
  assert.deepEqual(alpha.body.result.structuredContent.workflows, [WF_1]);
  assert.equal(stack.daemon.requests.at(-1).search, '');

  const flow = await call(stack, 'get_workflow', { workflow_id: 'feature.flow' });
  assert.equal(flow.body.result.isError, false);
  const { run_count: _count, last_run: _last, ...core } = WF_1;
  assert.deepEqual(flow.body.result.structuredContent, {
    ...core,
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      { id: 'agent', type: 'agent' },
    ],
  });
  assert.equal(stack.daemon.requests.at(-1).path, '/api/workflows/feature.flow');
  assert.equal(Object.hasOwn(flow.body.result.structuredContent, 'draft'), false);
  assertNoNeedle(flow.text);

  const missingFlow = await call(stack, 'get_workflow', { workflow_id: 'missing-flow' });
  assert.equal(missingFlow.body.result.isError, true);
  assert.equal(missingFlow.body.result.content[0].text, 'not found');
  assert.equal(missingFlow.text.includes('Mission not found'), false);

  const runs = await call(stack, 'list_workflow_runs', { workflow_id: 'feature.flow' });
  assert.equal(runs.body.result.isError, false);
  assert.deepEqual(runs.body.result.structuredContent.runs, [RUN_NEW, RUN_OLD]);
  assert.equal(stack.daemon.requests.at(-1).path, '/api/workflows/feature.flow/runs');
  assert.equal(stack.daemon.requests.at(-1).search, '');
  assertNoNeedle(runs.text);
  assert.equal(stack.daemon.workflowRuns.get('run-wf-1').context.includes('SECRET WORKFLOW CONTEXT'), true);

  const newest = await call(stack, 'list_workflow_runs', { workflow_id: 'wf-1', limit: 1 });
  assert.deepEqual(newest.body.result.structuredContent.runs, [RUN_NEW]);
  assert.equal(stack.daemon.requests.at(-1).search, '');

  const launched = await call(stack, 'run_workflow', {
    workflow_id: 'feature.flow',
    input: { feature: 'login' },
  });
  assert.equal(launched.body.result.isError, false);
  assert.deepEqual(launched.body.result.structuredContent, {
    id: 'run-made-3',
    workflow_id: 'wf-1',
    version: 1,
    status: 'running',
    started_at: 1_700_000_000_200,
    ended_at: null,
    error: null,
  });
  assert.equal(stack.daemon.requests.at(-1).method, 'POST');
  assert.equal(stack.daemon.requests.at(-1).path, '/api/workflows/feature.flow/run');
  assert.deepEqual(JSON.parse(stack.daemon.requests.at(-1).bodyText), { input: { feature: 'login' } });
  assert.equal(launched.text.includes('login'), false);
  assertNoNeedle(launched.text);
  assert.equal(stack.daemon.workflowRuns.get('run-made-3').context.includes('SECRET WORKFLOW CONTEXT'), true);

  const unpublished = await call(stack, 'run_workflow', { workflow_id: 'wf-2', input: { feature: 'login' } });
  assert.equal(unpublished.body.result.isError, true);
  assert.equal(unpublished.body.result.content[0].text, 'workflow has no published version');
  assert.deepEqual(JSON.parse(stack.daemon.requests.at(-1).bodyText), { input: { feature: 'login' } });
  assert.equal(stack.daemon.requests.at(-1).bodyText.includes('draft'), false);

  const routines = await call(stack, 'list_routines', {});
  assert.equal(routines.body.result.isError, false);
  assert.deepEqual(routines.body.result.structuredContent.routines, [ROUTINE_1, ROUTINE_2]);
  assert.equal(stack.daemon.requests.at(-1).path, '/api/routines');
  assert.equal(stack.daemon.requests.at(-1).search, '');
  assertNoNeedle(routines.text);
  assert.equal(stack.daemon.routines.get('routine-1').prompt, 'SECRET ROUTINE PROMPT');

  const nightly = await call(stack, 'list_routines', { project: 'alpha' });
  assert.deepEqual(nightly.body.result.structuredContent.routines, [ROUTINE_1]);
  assert.equal(stack.daemon.requests.at(-1).search, '');

  const hiddenProject = await call(stack, 'list_routines', { project: 'beta' });
  assert.deepEqual(hiddenProject.body.result.structuredContent.routines, []);

  const routine = await call(stack, 'get_routine', { routine_id: 'routine-2' });
  assert.deepEqual(routine.body.result.structuredContent, ROUTINE_2);
  assert.equal(stack.daemon.requests.at(-1).path, '/api/routines/routine-2');
  assertNoNeedle(routine.text);

  const missingRoutine = await call(stack, 'get_routine', { routine_id: 'missing-routine' });
  assert.equal(missingRoutine.body.result.isError, true);
  assert.equal(missingRoutine.body.result.content[0].text, 'not found');
  assert.equal(missingRoutine.text.includes('Mission not found'), false);
});

test('tools/list exposes the ten read and run tools and no write', async (t) => {
  const stack = await openStack(t);
  const listed = await rpc(stack, 'tools/list', {});
  const names = listed.body.result.tools.map((tool) => tool.name);
  for (const name of [
    'list_pipelines', 'get_pipeline', 'run_pipeline', 'get_pipeline_run',
    'list_workflows', 'get_workflow', 'list_workflow_runs', 'run_workflow',
    'list_routines', 'get_routine',
  ]) {
    assert.equal(names.includes(name), true, name);
  }
  for (const name of [
    'create_pipeline', 'update_pipeline', 'delete_pipeline',
    'create_workflow', 'publish_workflow', 'delete_workflow',
    'create_routine', 'enable_routine', 'disable_routine',
  ]) {
    assert.equal(names.includes(name), false, name);
  }
  assert.equal(stack.daemon.requests.length, 0);
});

test('an automation tool without the plugin bearer never calls the daemon', async (t) => {
  const stack = await openStack(t);
  const response = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_pipelines', arguments: {} },
    }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'unauthorized');
  assert.equal(stack.daemon.requests.length, 0);
});

test('write methods, reserved paths, queries, encoded paths, and override bodies never reach the daemon', async (t) => {
  const stack = await openStack(t);
  const client = createDaemonClient({
    origin: stack.daemon.origin,
    tokenFile: stack.tokenFile,
    env: { [BEARER_SECRET]: stack.bearer },
    bearerName: BEARER_SECRET,
  });

  const refused = [
    ['POST', '/api/pipelines'],
    ['PUT', '/api/pipelines/pipe-1'],
    ['DELETE', '/api/pipelines/pipe-1'],
    ['POST', '/api/routines'],
    ['PUT', '/api/routines/routine-1'],
    ['DELETE', '/api/routines/routine-1'],
    ['POST', '/api/workflows'],
    ['PUT', '/api/workflows/wf-1'],
    ['DELETE', '/api/workflows/wf-1'],
    ['POST', '/api/workflows/wf-1/publish'],
    ['GET', '/api/workflows/runs'],
    ['GET', '/api/workflows/node-types'],
    ['GET', '/api/workflows/runs/run-wf-1'],
    ['GET', '/api/workflows/import/pipeline/pipe-1'],
    ['POST', '/api/workflows/import/pipeline/pipe-1'],
    ['POST', '/api/workflows/wf-1/chat-agent'],
    ['GET', '/api/workflows/wf-1/triggers'],
    ['GET', '/api/workflows/wf-1/proposals'],
    ['GET', '/api/pipelines?limit=1'],
    ['GET', '/api/workflows?project=alpha'],
    ['GET', '/api/routines?project=alpha'],
    ['GET', '/api/pipelines/ab%2fcd'],
    ['GET', '/api/pipelines/../workflows'],
    ['GET', '/api/workflows/%2e%2e'],
    ['GET', '/api/workflows/a..b'],
    ['POST', '/api/pipelines/pipe-1/run?x=1'],
  ];
  for (const [method, path] of refused) {
    await assert.rejects(
      () => client.request(method, path, method === 'POST' || method === 'PUT' ? { input: {} } : undefined),
      (err) => err.code === 'route_denied',
    );
  }
  await assert.rejects(
    () => client.request('GET', '/api/pipelines', undefined, { limit: '1' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('GET', '/api/workflows', undefined, { project: 'alpha' }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/pipelines/pipe-1/run', {}),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/pipelines/pipe-1/run', { input: {}, draft: true }),
    (err) => err.code === 'route_denied',
  );
  for (const extra of ['backend', 'model', 'permission_mode', 'model_override', 'extra_skills']) {
    await assert.rejects(
      () => client.request('POST', '/api/workflows/wf-1/run', { input: { feature: 'login' }, [extra]: 'x' }),
      (err) => err.code === 'route_denied',
    );
  }
  await assert.rejects(
    () => client.request('POST', '/api/pipelines/pipe-1/run', { input: { model: 'hidden-model' } }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/workflows/wf-1/run', { input: { feature: 'ok', fallback_model: 'hidden-model' } }),
    (err) => err.code === 'route_denied',
  );
  await assert.rejects(
    () => client.request('POST', '/api/pipelines/pipe-1/run', { input: [] }),
    (err) => err.code === 'route_denied',
  );
  const huge = { feature: 'x'.repeat(RUN_INPUT_MAX_BYTES) };
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) > RUN_INPUT_MAX_BYTES);
  await assert.rejects(
    () => client.request('POST', '/api/pipelines/pipe-1/run', { input: huge }),
    (err) => err.code === 'route_denied',
  );
  assert.equal(stack.daemon.requests.length, 0);

  const allowed = await client.request('POST', '/api/pipelines/pipe-1/run', { input: { feature: 'login' } });
  assert.equal(allowed.status, 201);
  assert.equal(stack.daemon.requests.length, 1);
  assert.deepEqual(JSON.parse(stack.daemon.requests[0].bodyText), { input: { feature: 'login' } });
});

test('tool arguments outside the whitelist are refused before the daemon, and a reserved workflow word is not an id', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '1' } });
  for (const extra of ['draft', 'backend', 'model', 'permission_mode', 'model_override', 'extra_skills']) {
    const bad = await call(stack, 'run_pipeline', {
      pipeline_id: 'pipe-1',
      input: { feature: 'login' },
      [extra]: extra === 'extra_skills' ? ['secret-skill'] : 'hidden-model',
    });
    assert.equal(bad.body.error.code, -32602, extra);
    assert.match(bad.body.error.message, new RegExp(`unexpected property \`${extra}\``));
  }
  const wrongKey = await call(stack, 'get_workflow', { id: 'wf-1' });
  assert.equal(wrongKey.body.error.code, -32602);
  const badLimit = await call(stack, 'list_pipelines', { limit: 0 });
  assert.equal(badLimit.body.error.code, -32602);
  assert.equal(stack.daemon.requests.length, 0);

  for (const id of ['runs', 'node-types', 'import', 'hooks']) {
    const bad = await call(stack, 'get_workflow', { workflow_id: id });
    assert.equal(bad.body.result.isError, true, id);
    assert.equal(bad.body.result.content[0].text, 'workflow id is invalid');
    const launched = await call(stack, 'run_workflow', { workflow_id: id, input: { feature: 'login' } });
    assert.equal(launched.body.result.isError, true, id);
    assert.equal(launched.body.result.content[0].text, 'workflow id is invalid');
  }
  const dotted = await call(stack, 'get_workflow', { workflow_id: 'a..b' });
  assert.equal(dotted.body.result.isError, true);
  assert.equal(dotted.body.result.content[0].text, 'workflow id is invalid');
  assert.equal(stack.daemon.requests.length, 0);

  const override = await call(stack, 'run_pipeline', {
    pipeline_id: 'pipe-1',
    input: { model: 'hidden-model' },
  });
  assert.equal(override.body.result.isError, true);
  assert.equal(override.body.result.content[0].text, 'override is not allowed');
  const fallback = await call(stack, 'run_workflow', {
    workflow_id: 'wf-1',
    input: { feature: 'login', fallback_model: 'hidden-model' },
  });
  assert.equal(fallback.body.result.isError, true);
  assert.equal(fallback.body.result.content[0].text, 'override is not allowed');
  const arrayInput = await call(stack, 'run_workflow', { workflow_id: 'wf-1', input: ['login'] });
  assert.equal(arrayInput.body.result.isError, true);
  assert.match(arrayInput.body.result.content[0].text, /input must be an object/);
  // The plugin body cap is 64 KiB, the same size as a run input. An input of
  // 70 000 characters never reaches the facade: the HTTP layer refuses it.
  // The daemon client refuses the same object with route_denied, above.
  const tooBig = await call(stack, 'run_pipeline', {
    pipeline_id: 'pipe-1',
    input: { feature: 'y'.repeat(70_000) },
  });
  assert.equal(tooBig.httpStatus, 413);
  assert.equal(tooBig.body.code, 'payload_too_large');
  assert.equal(stack.daemon.requests.length, 0);

  const ok = await call(stack, 'run_pipeline', { pipeline_id: 'pipe-1', input: { feature: 'login' } });
  assert.equal(ok.body.result.isError, false);
  assert.equal(stack.daemon.requests.length, 1);
});

test('pipeline and workflow runs share the spawn window; reads do not take a slot', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '2' } });
  const listed = await call(stack, 'list_pipelines', {});
  assert.equal(listed.body.result.isError, false);
  const first = await call(stack, 'run_pipeline', { pipeline_id: 'pipe-1', input: { feature: 'login' } });
  assert.equal(first.body.result.isError, false);
  const read = await call(stack, 'get_pipeline', { pipeline_id: 'pipe-1' });
  assert.equal(read.body.result.isError, false);
  const second = await call(stack, 'run_workflow', { workflow_id: 'wf-1', input: { feature: 'login' } });
  assert.equal(second.body.result.isError, false);
  const runs = await call(stack, 'list_workflow_runs', { workflow_id: 'wf-1' });
  assert.equal(runs.body.result.isError, false);
  const after = stack.daemon.requests.length;
  assert.equal(stack.daemon.requests.filter((row) => row.method === 'POST').length, 2);

  const third = await call(stack, 'run_pipeline', { pipeline_id: 'pipe-1', input: { feature: 'login' } });
  assert.equal(third.body.result.isError, true);
  assert.equal(third.body.result.content[0].text, APPROVAL_MESSAGE);
  const fourth = await call(stack, 'run_workflow', { workflow_id: 'wf-1' });
  assert.equal(fourth.body.result.isError, true);
  assert.equal(fourth.body.result.content[0].text, APPROVAL_MESSAGE);
  assert.equal(stack.daemon.requests.length, after);

  const still = await call(stack, 'list_routines', {});
  assert.equal(still.body.result.isError, false);
  const detail = await call(stack, 'get_routine', { routine_id: 'routine-1' });
  assert.equal(detail.body.result.isError, false);
  assert.equal(stack.daemon.requests.length, after + 2);
  assert.equal(stack.daemon.requests.filter((row) => row.method === 'POST').length, 2);
});

test('an unpublished workflow run still takes a slot', async (t) => {
  const stack = await openStack(t, { env: { TIMON_MCP_SPAWN_MAX: '1' } });
  const refused = await call(stack, 'run_workflow', { workflow_id: 'wf-2', input: {} });
  assert.equal(refused.body.result.isError, true);
  assert.equal(refused.body.result.content[0].text, 'workflow has no published version');
  assert.equal(stack.daemon.requests.length, 1);
  const blocked = await call(stack, 'run_pipeline', { pipeline_id: 'pipe-1', input: { feature: 'login' } });
  assert.equal(blocked.body.result.isError, true);
  assert.equal(blocked.body.result.content[0].text, APPROVAL_MESSAGE);
  assert.equal(stack.daemon.requests.length, 1);
});

test('automation too_large names the route and does not suggest limit', () => {
  const reads = DAEMON_ROUTES.filter((route) => route.maxBytes === AUTOMATION_READ_MAX_BYTES);
  assert.deepEqual(reads.map((route) => `${route.method} ${route.path}`), Object.keys(AUTOMATION_TOO_LARGE));
  for (const [route, text] of Object.entries(AUTOMATION_TOO_LARGE)) {
    const space = route.indexOf(' ');
    assert.equal(automationTooLarge(route.slice(0, space), route.slice(space + 1)), text, route);
    assert.equal(text.includes('Pass limit'), false, route);
    assert.equal(/\blimit\b/.test(text), false, route);
  }
});

test('a pipeline list past 1 MiB is read, and past the ceiling it is too_large', async (t) => {
  const stack = await openStack(t);
  const wide = pipelinePage(RESPONSE_MAX_BYTES + 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) > RESPONSE_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) < AUTOMATION_READ_MAX_BYTES);
  stack.daemon.setPipelinesList(wide);
  const listed = await call(stack, 'list_pipelines', { limit: 10 });
  assert.equal(listed.body.result.isError, false);
  assert.deepEqual(listed.body.result.structuredContent.pipelines, [{
    id: 'pipe-wide',
    name: 'Wide',
    description: 'ok',
    created_at: 1,
    updated_at: 2,
    inputs: [],
    steps: [{ id: 'plan', agent: 'alpha.coder', type: 'code', deps_on: [], priority: 1 }],
  }]);
  assert.equal(listed.text.includes('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), false);
  assert.equal(listed.text.includes('hidden-owner'), false);

  const over = pipelinePage(AUTOMATION_READ_MAX_BYTES + 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(over)) > AUTOMATION_READ_MAX_BYTES);
  stack.daemon.setPipelinesList(over);
  const huge = await call(stack, 'list_pipelines', {});
  assert.equal(huge.body.result.isError, true);
  assert.equal(huge.body.result.content[0].text, AUTOMATION_TOO_LARGE['GET /api/pipelines']);
  assert.equal(huge.text.includes('Pass limit'), false);
  assert.equal(huge.text.includes('daemon is unreachable'), false);
  assert.equal(huge.text.includes('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), false);

  stack.daemon.setWorkflowGet({
    workflow: { id: 'wf-1', draft: 'y'.repeat(AUTOMATION_READ_MAX_BYTES) },
  });
  const detail = await call(stack, 'get_workflow', { workflow_id: 'wf-1' });
  assert.equal(detail.body.result.isError, true);
  assert.equal(detail.body.result.content[0].text, AUTOMATION_TOO_LARGE['GET /api/workflows/:auto']);
  assert.equal(detail.text.includes('Pass limit'), false);
  assert.equal(detail.text.includes('yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'), false);
});

/**
 * A `{ pipelines }` document of `bytes` UTF-8 bytes. The pad sits in a prompt.
 * @param {number} bytes
 */
function pipelinePage(bytes) {
  const pipelines = [{
    id: 'pipe-wide',
    name: 'Wide',
    description: 'ok',
    definition: {
      steps: [{
        id: 'plan',
        agent: 'alpha.coder',
        type: 'code',
        prompt: '',
        deps_on: [],
        priority: 1,
      }],
    },
    owner_user_id: 'hidden-owner',
    created_at: 1,
    updated_at: 2,
  }];
  const bare = Buffer.byteLength(JSON.stringify({ pipelines }));
  const pad = bytes - bare;
  assert.ok(pad > 0);
  pipelines[0].definition.steps[0].prompt = 'x'.repeat(pad);
  const body = { pipelines };
  assert.equal(Buffer.byteLength(JSON.stringify(body)), bytes);
  return body;
}

/**
 * @param {string} text
 */
function assertNoNeedle(text) {
  for (const needle of NEEDLES) assert.equal(text.includes(needle), false, needle);
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
 * @param {Awaited<ReturnType<typeof openStack>>} stack
 * @param {string} method
 * @param {unknown} params
 */
async function rpc(stack, method, params) {
  const response = await fetch(`${stack.host.baseUrl}/api/plugins/timon-mcp/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stack.bearer}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  return { httpStatus: response.status, text, body: JSON.parse(text) };
}
