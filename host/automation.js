/**
 * Pipelines, workflows, and routines for the standalone host.
 *
 * Reads are projections. A run sends exactly `{ input }` and takes one slot
 * of the host spawn window. Nothing here writes a pipeline, a workflow, or a
 * routine, and nothing enables one. `lib/` does not import this file.
 */
import { MESSAGE_MAX_CHARS } from '../lib/constants.js';
import { RUN_INPUT_MAX_BYTES } from './daemon.js';
import {
  DaemonBodyError,
  DaemonCallError,
  DaemonRouteError,
  PluginMissionError,
  PluginPolicyError,
} from './errors.js';
import {
  TASK_TYPE_NAMES,
  isAutomationId,
  isProject,
  isWorkflowId,
} from './names.js';

const LIST_DEFAULT = 50;
const LIST_MAX = 100;
const STEP_MAX = 256;
const NODE_MAX = 100;
const LABEL_MAX = 255;
const SHORT_MAX = 80;
const INPUT_KEY = /\{\{\s*input\.([a-zA-Z0-9_]+)\s*\}\}/g;
const TASK_TYPES = new Set(TASK_TYPE_NAMES);
const OVERRIDE_EXACT = new Set([
  'model',
  'backend',
  'extraSkills',
  'extraMcp',
  'allow',
  'model_override',
  'backend_override',
  'extra_skills',
  'extra_mcp_servers',
  'extra_allowed_tools',
  'permission_mode',
  'permissionMode',
  'draft',
]);

/**
 * @param {object} deps
 * @param {{ request: Function }} deps.client
 * @param {{ take: Function }} deps.quota
 */
export function createAutomationFacade(deps) {
  const { client, quota } = deps;

  return {
    /**
     * @param {Record<string, unknown>} [opts]
     */
    async listPipelines(opts = {}) {
      const filter = listOpts(opts, new Set(['limit']));
      const result = await callAuto(() => client.request('GET', '/api/pipelines'));
      const rows = arrayOf(result, 'pipelines');
      return take(rows, filter.limit, projectPipeline);
    },

    /**
     * @param {unknown} id
     */
    async readPipeline(id) {
      const pipeId = requireId(id, 'pipeline id is invalid');
      const result = await callAuto(() => client.request('GET', `/api/pipelines/${pipeId}`));
      if (result.status === 404) throw missing('pipeline', result.json);
      const row = wrapped(result, 'pipeline');
      if (!row || row.id !== pipeId) throw new PluginMissionError('invalid', 'daemon response was refused');
      return projectPipeline(row);
    },

    /**
     * Opens one task per step. Counts against the window. The body is `{ input }`.
     * @param {unknown} id
     * @param {unknown} input
     */
    async runPipeline(id, input) {
      const pipeId = requireId(id, 'pipeline id is invalid');
      const body = { input: runInput(input) };
      takeSpawn(quota);
      const result = await callAuto(() => client.request('POST', `/api/pipelines/${pipeId}/run`, body));
      if (result.status === 404) throw missing('pipeline', result.json);
      if (result.status !== 201 || !isPlain(result.json)) throw httpError(result.status, result.json);
      const projected = projectPipelineRun(result.json);
      if (!projected || projected.pipeline_id !== pipeId) {
        throw new PluginMissionError('invalid', 'daemon response was refused');
      }
      return projected;
    },

    /**
     * @param {unknown} id
     */
    async readPipelineRun(id) {
      const runId = requireId(id, 'run id is invalid');
      const result = await callAuto(() => client.request('GET', `/api/pipelines/runs/${runId}`));
      if (result.status === 404) throw missing('run', result.json);
      if (result.status !== 200 || !isPlain(result.json)) throw httpError(result.status, result.json);
      const projected = projectPipelineStatus(result.json);
      if (!projected || projected.run.run_id !== runId) {
        throw new PluginMissionError('invalid', 'daemon response was refused');
      }
      return projected;
    },

    /**
     * @param {Record<string, unknown>} [opts]
     */
    async listWorkflows(opts = {}) {
      const filter = listOpts(opts, new Set(['limit', 'project']));
      const result = await callAuto(() => client.request('GET', '/api/workflows'));
      const rows = arrayOf(result, 'workflows');
      return take(rows, filter.limit, (row) => {
        const projected = projectWorkflowList(row);
        if (!projected) return null;
        if (filter.project !== undefined && projected.project !== filter.project) return null;
        return projected;
      });
    },

    /**
     * @param {unknown} id
     */
    async readWorkflow(id) {
      const workflowId = requireWorkflow(id);
      const result = await callAuto(() => client.request('GET', `/api/workflows/${workflowId}`));
      if (result.status === 404) throw missing('workflow', result.json);
      const row = wrapped(result, 'workflow');
      if (!row) throw new PluginMissionError('invalid', 'daemon response was refused');
      const projected = projectWorkflowDetail(row);
      if (!projected) throw new PluginMissionError('invalid', 'daemon response was refused');
      return projected;
    },

    /**
     * @param {unknown} id
     * @param {Record<string, unknown>} [opts]
     */
    async listWorkflowRuns(id, opts = {}) {
      const workflowId = requireWorkflow(id);
      const filter = listOpts(opts, new Set(['limit']));
      const result = await callAuto(() => client.request('GET', `/api/workflows/${workflowId}/runs`));
      if (result.status === 404) throw missing('workflow', result.json);
      const rows = arrayOf(result, 'runs');
      return take(rows, filter.limit, projectWorkflowRun);
    },

    /**
     * Runs the published version. Counts against the window. `draft` is not sent.
     * @param {unknown} id
     * @param {unknown} input
     */
    async runWorkflow(id, input) {
      const workflowId = requireWorkflow(id);
      const body = { input: runInput(input) };
      takeSpawn(quota);
      const result = await callAuto(() => client.request('POST', `/api/workflows/${workflowId}/run`, body));
      if (result.status === 404) throw missing('workflow', result.json);
      if (result.status !== 201) throw httpError(result.status, result.json);
      const row = wrapped(result, 'run');
      const projected = row ? projectWorkflowRun(row) : null;
      if (!projected || !isAutomationId(projected.workflow_id)) {
        throw new PluginMissionError('invalid', 'daemon response was refused');
      }
      return projected;
    },

    /**
     * @param {Record<string, unknown>} [opts]
     */
    async listRoutines(opts = {}) {
      const filter = listOpts(opts, new Set(['limit', 'project']));
      const result = await callAuto(() => client.request('GET', '/api/routines'));
      const rows = arrayOf(result, 'routines');
      return take(rows, filter.limit, (row) => {
        const projected = projectRoutine(row);
        if (!projected) return null;
        if (filter.project !== undefined && projected.project !== filter.project) return null;
        return projected;
      });
    },

    /**
     * @param {unknown} id
     */
    async readRoutine(id) {
      const routineId = requireId(id, 'routine id is invalid');
      const result = await callAuto(() => client.request('GET', `/api/routines/${routineId}`));
      if (result.status === 404) throw missing('routine', result.json);
      const row = wrapped(result, 'routine');
      if (!row || row.id !== routineId) throw new PluginMissionError('invalid', 'daemon response was refused');
      const projected = projectRoutine(row);
      if (!projected) throw new PluginMissionError('invalid', 'daemon response was refused');
      return projected;
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} message
 */
function requireId(value, message) {
  if (!isAutomationId(value)) throw new PluginMissionError('invalid', message);
  return value;
}

/**
 * @param {unknown} value
 */
function requireWorkflow(value) {
  if (!isWorkflowId(value)) throw new PluginMissionError('invalid', 'workflow id is invalid');
  return value;
}

/**
 * @param {unknown} value
 */
function runInput(value) {
  if (value === undefined) return {};
  if (!isPlain(value)) throw new PluginMissionError('invalid', 'input must be an object');
  for (const key of Object.keys(value)) {
    if (overrideKey(key)) throw new PluginMissionError('forbidden', 'override is not allowed');
  }
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw new PluginMissionError('invalid', 'input must be JSON');
  }
  if (size > RUN_INPUT_MAX_BYTES) throw new PluginMissionError('invalid', 'input is too large');
  return value;
}

/**
 * Validation has already passed. The slot stays taken if the daemon call fails.
 * @param {{ take?: Function }} quota
 */
function takeSpawn(quota) {
  if (!quota || typeof quota.take !== 'function') throw new Error('spawn quota is required');
  quota.take();
}

/**
 * @param {Record<string, unknown>} opts
 * @param {Set<string>} allowed
 */
function listOpts(opts, allowed) {
  const record = isPlain(opts) ? opts : {};
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue;
    if (overrideKey(key)) throw new PluginMissionError('forbidden', 'override is not allowed');
    throw new PluginMissionError('invalid', 'unexpected field');
  }
  /** @type {{ limit: number, project?: string }} */
  const filter = { limit: boundedLimit(record.limit) };
  if (record.project !== undefined) {
    if (!isProject(record.project)) throw new PluginMissionError('invalid', 'project is invalid');
    filter.project = record.project;
  }
  return filter;
}

/**
 * @param {unknown} value
 */
function boundedLimit(value) {
  if (value === undefined) return LIST_DEFAULT;
  if (!Number.isInteger(value) || value < 1 || value > LIST_MAX) {
    throw new PluginMissionError('invalid', 'limit is invalid');
  }
  return value;
}

/**
 * @param {{ status: number, json: unknown }} result
 * @param {string} key
 */
function arrayOf(result, key) {
  if (result.status !== 200 || !isPlain(result.json) || !Array.isArray(result.json[key])) {
    throw new PluginMissionError('invalid', 'daemon response was refused');
  }
  return result.json[key];
}

/**
 * @param {{ status: number, json: unknown }} result
 * @param {string} key
 * @returns {Record<string, unknown> | null}
 */
function wrapped(result, key) {
  if (result.status !== 200 && result.status !== 201) return null;
  if (!isPlain(result.json)) return null;
  const row = result.json[key];
  return isPlain(row) ? row : null;
}

/**
 * @param {unknown[]} rows
 * @param {number} limit
 * @param {(row: unknown) => Record<string, unknown> | null} project
 */
function take(rows, limit, project) {
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const row of rows) {
    const projected = project(row);
    if (!projected) continue;
    out.push(projected);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * No prompt, no override, no owner. `inputs` is the `{{input.name}}` keys.
 * @param {unknown} row
 * @returns {Record<string, unknown> | null}
 */
function projectPipeline(row) {
  if (!isPlain(row) || !isAutomationId(row.id)) return null;
  const definition = definitionOf(row.definition);
  const steps = definition ? definition.steps : [];
  return {
    id: row.id,
    name: asLabel(row.name),
    description: asText(row.description),
    created_at: asStamp(row.created_at),
    updated_at: asStamp(row.updated_at),
    inputs: inputsOf(steps),
    steps: steps.slice(0, STEP_MAX).map(projectStep).filter(Boolean),
  };
}

/**
 * @param {unknown} value
 * @returns {{ steps: unknown[] } | null}
 */
function definitionOf(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isPlain(parsed) || !Array.isArray(parsed.steps)) return null;
  return { steps: parsed.steps };
}

/**
 * @param {unknown} step
 * @returns {Record<string, unknown> | null}
 */
function projectStep(step) {
  if (!isPlain(step) || typeof step.id !== 'string' || step.id.length === 0 || step.id.length > 64) return null;
  if (step.id.includes('..')) return null;
  return {
    id: step.id,
    agent: asLabel(step.agent),
    type: typeof step.type === 'string' && step.type.length <= 64 ? step.type : null,
    deps_on: stringList(step.deps_on, 64),
    priority: Number.isInteger(step.priority) ? step.priority : null,
  };
}

/**
 * @param {unknown[]} steps
 */
function inputsOf(steps) {
  const keys = new Set();
  for (const step of steps) {
    if (!isPlain(step) || typeof step.prompt !== 'string') continue;
    for (const match of step.prompt.matchAll(INPUT_KEY)) keys.add(match[1]);
  }
  return [...keys].sort();
}

/**
 * @param {Record<string, unknown>} json
 * @returns {Record<string, unknown> | null}
 */
function projectPipelineRun(json) {
  if (!isAutomationId(json.run_id) || !isAutomationId(json.pipeline_id)) return null;
  if (!Number.isFinite(json.started_at)) return null;
  return {
    run_id: json.run_id,
    pipeline_id: json.pipeline_id,
    started_at: json.started_at,
    steps: Array.isArray(json.steps)
      ? json.steps.slice(0, STEP_MAX).map(projectRunStep).filter(Boolean)
      : [],
  };
}

/**
 * @param {unknown} step
 * @returns {Record<string, unknown> | null}
 */
function projectRunStep(step) {
  if (!isPlain(step) || typeof step.step_id !== 'string' || !isAutomationId(step.task_id)) return null;
  return { step_id: step.step_id.slice(0, 64), task_id: step.task_id };
}

/**
 * The run input is not returned: it is the caller's, and the step prompts stay out.
 * @param {Record<string, unknown>} json
 * @returns {{ run: Record<string, unknown>, steps: Record<string, unknown>[] } | null}
 */
function projectPipelineStatus(json) {
  const run = isPlain(json.run) ? json.run : null;
  if (!run || !isAutomationId(run.run_id) || !isAutomationId(run.pipeline_id)) return null;
  return {
    run: {
      run_id: run.run_id,
      pipeline_id: run.pipeline_id,
      pipeline_name: asLabel(run.pipeline_name),
      started_at: asStamp(run.started_at),
    },
    steps: Array.isArray(json.steps)
      ? json.steps.slice(0, STEP_MAX).map(projectStatusStep).filter(Boolean)
      : [],
  };
}

/**
 * @param {unknown} step
 * @returns {Record<string, unknown> | null}
 */
function projectStatusStep(step) {
  if (!isPlain(step) || typeof step.step_id !== 'string' || typeof step.task_id !== 'string') return null;
  return {
    step_id: step.step_id.slice(0, 64),
    task_id: step.task_id.slice(0, 200),
    title: asLabel(step.title),
    agent: asLabel(step.agent),
    type: typeof step.type === 'string' && step.type.length <= 64 ? step.type : null,
    status: asShort(step.status),
    mission_id: isAutomationId(step.mission_id) ? step.mission_id : null,
  };
}

/**
 * @param {unknown} row
 * @returns {Record<string, unknown> | null}
 */
function projectWorkflowList(row) {
  if (!isPlain(row) || !isAutomationId(row.id)) return null;
  return {
    ...workflowCore(row),
    run_count: Number.isInteger(row.run_count) && row.run_count >= 0 ? row.run_count : 0,
    last_run: projectLastRun(row.last_run),
  };
}

/**
 * Node id and type only. The draft's config (prompts, scripts, secrets) stays out.
 * @param {unknown} row
 * @returns {Record<string, unknown> | null}
 */
function projectWorkflowDetail(row) {
  if (!isPlain(row) || !isAutomationId(row.id)) return null;
  return {
    ...workflowCore(row),
    nodes: nodeOutline(row.draft),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
function workflowCore(row) {
  return {
    id: row.id,
    slug: isAutomationId(row.slug) ? row.slug : null,
    name: asLabel(row.name),
    description: asText(row.description),
    project: isProject(row.project) ? row.project : null,
    enabled: row.enabled === 1 || row.enabled === true,
    published_version: Number.isInteger(row.published_version) ? row.published_version : null,
    agent_name: asAgent(row.agent_name),
    created_at: asStamp(row.created_at),
    updated_at: asStamp(row.updated_at),
  };
}

/**
 * @param {unknown} draft
 */
function nodeOutline(draft) {
  let parsed = draft;
  if (typeof draft === 'string') {
    try {
      parsed = JSON.parse(draft);
    } catch {
      return [];
    }
  }
  if (!isPlain(parsed) || !Array.isArray(parsed.nodes)) return [];
  /** @type {{ id: string, type: string }[]} */
  const nodes = [];
  for (const node of parsed.nodes) {
    if (!isPlain(node) || typeof node.id !== 'string' || typeof node.type !== 'string') continue;
    if (node.id.length === 0 || node.id.length > SHORT_MAX || node.type.length === 0 || node.type.length > SHORT_MAX) {
      continue;
    }
    if (node.id.includes('/') || node.id.includes('..') || node.type.includes('/')) continue;
    nodes.push({ id: node.id, type: node.type });
    if (nodes.length >= NODE_MAX) break;
  }
  return nodes;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function projectLastRun(value) {
  if (!isPlain(value) || !isAutomationId(value.id)) return null;
  return {
    id: value.id,
    status: asShort(value.status),
    started_at: asStamp(value.started_at),
    ended_at: asStamp(value.ended_at),
  };
}

/**
 * No context, no input, no trigger, no owner. Those carry the graph and its secrets.
 * @param {unknown} row
 * @returns {Record<string, unknown> | null}
 */
function projectWorkflowRun(row) {
  if (!isPlain(row) || !isAutomationId(row.id) || !isAutomationId(row.workflow_id)) return null;
  const error = asText(row.error);
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    version: Number.isInteger(row.version) ? row.version : null,
    status: asShort(row.status),
    started_at: asStamp(row.started_at),
    ended_at: asStamp(row.ended_at),
    error,
  };
}

/**
 * No prompt, no owner. `enabled` is the route's 0/1, as a boolean.
 * @param {unknown} row
 * @returns {Record<string, unknown> | null}
 */
function projectRoutine(row) {
  if (!isPlain(row) || !isAutomationId(row.id)) return null;
  const taskType = typeof row.task_type === 'string' && TASK_TYPES.has(row.task_type) ? row.task_type : null;
  return {
    id: row.id,
    name: asLabel(row.name),
    agent_name: asAgent(row.agent_name),
    task_type: taskType,
    cron_expr: asCron(row.cron_expr),
    enabled: row.enabled === 1 || row.enabled === true,
    project: isProject(row.project) ? row.project : null,
    last_run_at: asStamp(row.last_run_at),
    next_run_at: asStamp(row.next_run_at),
    created_at: asStamp(row.created_at),
    updated_at: asStamp(row.updated_at),
  };
}

/**
 * @param {unknown} value
 * @param {number} itemMax
 */
function stringList(value, itemMax) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.length > 0 && item.length <= itemMax && !item.includes('..'))
    .slice(0, STEP_MAX);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asLabel(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > LABEL_MAX) return null;
  if (value.includes('..') || value.startsWith('/')) return null;
  return value;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asAgent(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  if (value.includes('/') || value.includes('..')) return null;
  return value;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asCron(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  if (value.includes('\n') || value.includes('..') || value.startsWith('/')) return null;
  return value;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asText(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= MESSAGE_MAX_CHARS) return value;
  let end = MESSAGE_MAX_CHARS;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asShort(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= SHORT_MAX ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asStamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {string} noun
 * @param {unknown} json
 */
function missing(noun, json) {
  const text = errorText(json);
  // `not_found` would be rewritten to "Mission not found." by explainToolError.
  return new PluginMissionError('missing', text === 'call refused' ? `${noun} not found` : text);
}

/**
 * @param {number} status
 * @param {unknown} json
 */
function httpError(status, json) {
  const message = errorText(json);
  if (status === 404) return new PluginMissionError('missing', message);
  if (status === 400) return new PluginMissionError('invalid', message);
  if (status === 403) return new PluginMissionError('forbidden', message);
  return new PluginMissionError('failed', message);
}

/**
 * @param {unknown} json
 */
function errorText(json) {
  if (!isPlain(json)) return 'call refused';
  const message = json.error;
  return typeof message === 'string' && message ? message.slice(0, 300) : 'call refused';
}

/**
 * @param {string} key
 */
function overrideKey(key) {
  const lower = key.toLowerCase();
  return OVERRIDE_EXACT.has(key)
    || key.includes('override')
    || key.includes('Override')
    || lower.includes('fallback');
}

/**
 * @param {() => Promise<{ status: number, json: unknown }>} run
 */
async function callAuto(run) {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PluginMissionError || err instanceof PluginPolicyError) throw err;
    if (err instanceof DaemonBodyError) throw new PluginMissionError('too_large', err.message);
    if (err instanceof DaemonCallError) throw new PluginMissionError('failed', 'daemon is unreachable');
    if (err instanceof DaemonRouteError) throw new PluginMissionError('failed', 'daemon route is not allowed');
    const message = err instanceof Error ? err.message : 'call refused';
    throw new PluginMissionError('failed', message.slice(0, 300) || 'call refused');
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
