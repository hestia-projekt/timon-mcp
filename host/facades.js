/**
 * Mission and task facades for the standalone host.
 *
 * They speak the same methods as the plugin context. The difference is the
 * transport: five daemon routes, and only ids this host has created. Nothing
 * here is imported by `lib/`.
 */
import { APPROVAL_MESSAGE, MESSAGE_MAX_CHARS, PILOT_AGENT, PLUGIN_ID, PROJECT_PATTERN } from '../lib/constants.js';
import {
  DaemonCallError,
  DaemonRouteError,
  PluginMissionError,
  PluginPolicyError,
  PluginTaskError,
} from './errors.js';

const PROJECT = new RegExp(PROJECT_PATTERN);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
/** Ids fetched per list. Both statements apply this bound in SQL. */
const LIST_GET_MAX = 50;
const SPAWN_MAX_DEFAULT = 5;
const SPAWN_WINDOW_DEFAULT = 3_600_000;
const MISSION_KEYS = new Set(['agent', 'mission']);
const TASK_KEYS = new Set(['project', 'title', 'description', 'agent', 'type']);
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
]);

/**
 * One sliding window for `spawn`, `send` and `kanban.add`.
 * The daemon token is a super-administrator, so the plugin spawn policy
 * does not apply here. Past the ceiling the facade throws `PluginPolicyError`
 * with rule `spawn`, before any network call.
 * @param {NodeJS.ProcessEnv} env
 * @param {() => number} [now]
 */
export function createSpawnQuota(env, now = Date.now) {
  const max = readQuota(env.TIMON_MCP_SPAWN_MAX, SPAWN_MAX_DEFAULT, 'TIMON_MCP_SPAWN_MAX');
  const windowMs = readQuota(env.TIMON_MCP_SPAWN_WINDOW_MS, SPAWN_WINDOW_DEFAULT, 'TIMON_MCP_SPAWN_WINDOW_MS');
  /** @type {number[]} */
  const stamps = [];
  return {
    take() {
      const time = now();
      let live = 0;
      for (let i = 0; i < stamps.length; i += 1) {
        if (time - stamps[i] < windowMs) {
          stamps[live] = stamps[i];
          live += 1;
        }
      }
      stamps.length = live;
      if (live >= max) {
        throw new PluginPolicyError(PLUGIN_ID, 'spawn', APPROVAL_MESSAGE);
      }
      stamps.push(time);
    },
  };
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @param {string} name
 */
function readQuota(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) throw new Error(`${name} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is invalid`);
  return value;
}

/**
 * @param {object} deps
 * @param {{ request: Function }} deps.client
 * @param {{ prepare: Function }} deps.sql
 * @param {{ take: Function }} deps.quota
 */
export function createMissionFacade(deps) {
  const { client, sql, quota } = deps;
  const owned = sql.prepare('SELECT id FROM host_missions WHERE id = ?');
  const insert = sql.prepare(
    'INSERT INTO host_missions (id, agent_name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING',
  );
  const listed = sql.prepare(
    'SELECT id FROM host_missions ORDER BY created_at DESC, id DESC LIMIT ?',
  );
  const forget = sql.prepare('DELETE FROM host_missions WHERE id = ?');

  return {
    /**
     * @param {unknown} input
     * @returns {Promise<string>}
     */
    async spawn(input) {
      const body = missionBody(input);
      takeSpawn(quota);
      const result = await callMission(() => client.request('POST', '/api/missions', body));
      if ((result.status !== 201 && result.status !== 200) || !result.json || typeof result.json !== 'object') {
        throw missionHttpError(result.status, result.json);
      }
      const id = safeId(/** @type {{ mission_id?: unknown }} */ (result.json).mission_id);
      if (!id) throw new PluginMissionError('failed', 'daemon response was refused');
      insert.run(id, body.agent, Date.now());
      return id;
    },

    /**
     * @param {unknown} missionId
     * @param {unknown} text
     */
    async send(missionId, text) {
      const id = requireOwned(owned, missionId);
      if (typeof text !== 'string' || !text || text.length > MESSAGE_MAX_CHARS) {
        throw new PluginMissionError('invalid', 'text is required');
      }
      takeSpawn(quota);
      const result = await callMission(() => client.request('POST', `/api/agents/${id}/send`, { input: text }));
      if (result.status === 200 && result.json && typeof result.json === 'object' && result.json.ok === true) {
        return { resumed: result.json.resumed === true };
      }
      throw missionHttpError(result.status, result.json, { send: true });
    },

    /**
     * Unknown ids are refused before any request. A 404 on a known id is
     * "not there", which the tools already turn into "Mission not found."
     * @param {unknown} missionId
     */
    async get(missionId) {
      if (!isOwned(owned, missionId)) return undefined;
      const id = /** @type {string} */ (missionId);
      const result = await callMission(() => client.request('GET', `/api/missions/${id}`));
      if (result.status === 404) return undefined;
      if (result.status !== 200 || !result.json || typeof result.json !== 'object') {
        throw missionHttpError(result.status, result.json);
      }
      return pickMission(/** @type {Record<string, unknown>} */ (result.json));
    },

    /**
     * @param {{ status?: unknown, limit?: unknown }} [opts]
     */
    async list(opts = {}) {
      const limit = boundedLimit(opts.limit, 50, () => new PluginMissionError('invalid', 'limit is invalid'));
      const status = typeof opts.status === 'string' ? opts.status : undefined;
      /** @type {Record<string, unknown>[]} */
      const rows = [];
      for (const row of listed.all(LIST_GET_MAX)) {
        const id = safeId(row && row.id);
        if (!id) continue;
        const result = await callMission(() => client.request('GET', `/api/missions/${id}`));
        if (result.status === 404) {
          forget.run(id);
          continue;
        }
        if (result.status !== 200 || !result.json || typeof result.json !== 'object') {
          throw missionHttpError(result.status, result.json);
        }
        const mission = pickMission(/** @type {Record<string, unknown>} */ (result.json));
        if (status && mission.status !== status) continue;
        rows.push(mission);
        if (rows.length >= limit) break;
      }
      return rows;
    },
  };
}

/**
 * @param {object} deps
 * @param {{ request: Function }} deps.client
 * @param {{ prepare: Function }} deps.sql
 * @param {{ take: Function }} deps.quota
 */
export function createTaskFacade(deps) {
  const { client, sql, quota } = deps;
  const owned = sql.prepare('SELECT id FROM host_tasks WHERE id = ?');
  const insert = sql.prepare(
    'INSERT INTO host_tasks (id, project, agent_name, title, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
  );
  const listed = sql.prepare(
    'SELECT id FROM host_tasks ORDER BY created_at DESC, id DESC LIMIT ?',
  );
  const forget = sql.prepare('DELETE FROM host_tasks WHERE id = ?');

  return {
    /**
     * @param {unknown} taskId
     */
    async get(taskId) {
      if (!isOwned(owned, taskId)) return undefined;
      const id = /** @type {string} */ (taskId);
      const result = await callTask(() => client.request('GET', `/api/tasks/${id}`));
      if (result.status === 404) return undefined;
      const task = taskRecord(result);
      if (!task) throw taskHttpError(result.status, result.json);
      return pickTask(task);
    },

    /**
     * @param {{ project?: unknown, status?: unknown, limit?: unknown }} [opts]
     */
    async list(opts = {}) {
      const limit = boundedLimit(opts.limit, 100, () => new PluginTaskError('invalid', 'limit is invalid'));
      const status = typeof opts.status === 'string' ? opts.status : undefined;
      const project = typeof opts.project === 'string' ? opts.project : undefined;
      /** @type {Record<string, unknown>[]} */
      const rows = [];
      for (const row of listed.all(LIST_GET_MAX)) {
        const id = safeId(row && row.id);
        if (!id) continue;
        const result = await callTask(() => client.request('GET', `/api/tasks/${id}`));
        if (result.status === 404) {
          forget.run(id);
          continue;
        }
        const task = taskRecord(result);
        if (!task) throw taskHttpError(result.status, result.json);
        const picked = pickTask(task);
        if (status && picked.status !== status) continue;
        if (project && picked.project !== project) continue;
        rows.push(picked);
        if (rows.length >= limit) break;
      }
      return rows;
    },

    /**
     * @param {unknown} input
     */
    async add(input) {
      const body = taskBody(input);
      takeSpawn(quota);
      const result = await callTask(() => client.request('POST', '/api/tasks', body));
      const task = result.status === 201 ? taskRecord(result) : null;
      if (!task) throw taskHttpError(result.status, result.json);
      const picked = pickTask(task);
      const id = safeId(picked.id);
      if (!id) throw new PluginTaskError('invalid', 'daemon response was refused');
      insert.run(id, body.project, body.agent_name, body.title, Date.now());
      return { ...picked, id };
    },
  };
}

/**
 * @param {unknown} input
 * @returns {{ agent: string, mission: string }}
 */
function missionBody(input) {
  const record = plainRecord(input, () => new PluginMissionError('invalid', 'mission is required'));
  refuseKeys(record, MISSION_KEYS, (key) => {
    if (overrideKey(key)) throw new PluginMissionError('override_denied', 'override is not allowed');
    throw new PluginMissionError('invalid', 'unexpected field');
  });
  const agent = record.agent;
  const mission = record.mission;
  if (typeof agent !== 'string' || !pilotAgent(agent)) {
    throw new PluginMissionError('invalid', 'agent is invalid');
  }
  if (typeof mission !== 'string' || !mission.trim() || mission.length > MESSAGE_MAX_CHARS) {
    throw new PluginMissionError('invalid', 'mission is required');
  }
  return { agent, mission };
}

/**
 * Validation has already passed. The slot stays taken if the daemon call fails.
 */
function takeSpawn(quota) {
  if (!quota || typeof quota.take !== 'function') throw new Error('spawn quota is required');
  quota.take();
}

/**
 * @param {unknown} input
 * @returns {{ title: string, description: string, agent_name: string, type: 'chore', project: string }}
 */
function taskBody(input) {
  const record = plainRecord(input, () => new PluginTaskError('invalid', 'task is required'));
  refuseKeys(record, TASK_KEYS, (key) => {
    if (overrideKey(key)) throw new PluginTaskError('forbidden', 'override is not allowed');
    throw new PluginTaskError('invalid', 'unexpected field');
  });
  const project = record.project;
  const title = record.title;
  const agent = record.agent;
  const type = record.type;
  const description = record.description;
  if (typeof project !== 'string' || !PROJECT.test(project)) {
    throw new PluginTaskError('invalid', 'project is invalid');
  }
  if (type !== 'chore') throw new PluginTaskError('invalid', 'type must be chore');
  if (agent !== `${project}.main`) throw new PluginTaskError('invalid', 'agent is invalid');
  if (typeof title !== 'string' || !title.trim() || title.length > 500) {
    throw new PluginTaskError('invalid', 'title is required');
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > MESSAGE_MAX_CHARS)) {
    throw new PluginTaskError('invalid', 'description is invalid');
  }
  return {
    title,
    description: typeof description === 'string' ? description : '',
    agent_name: agent,
    type: 'chore',
    project,
  };
}

/**
 * @param {string} agent
 */
function pilotAgent(agent) {
  if (agent === PILOT_AGENT) return true;
  if (!agent.endsWith('.main')) return false;
  return PROJECT.test(agent.slice(0, -'.main'.length));
}

/**
 * @param {string} key
 */
function overrideKey(key) {
  return OVERRIDE_EXACT.has(key) || key.includes('override') || key.includes('Override');
}

/**
 * @param {unknown} value
 * @param {() => Error} invalid
 * @returns {Record<string, unknown>}
 */
function plainRecord(value, invalid) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {Record<string, unknown>} record
 * @param {Set<string>} allowed
 * @param {(key: string) => void} reject
 */
function refuseKeys(record, allowed, reject) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) reject(key);
  }
}

/**
 * @param {{ get: Function }} owned
 * @param {unknown} id
 */
function isOwned(owned, id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return false;
  return Boolean(owned.get(id));
}

/**
 * @param {{ get: Function }} owned
 * @param {unknown} id
 * @returns {string}
 */
function requireOwned(owned, id) {
  if (!isOwned(owned, id)) throw new PluginMissionError('not_found', 'mission not found');
  return /** @type {string} */ (id);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function safeId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) return null;
  return value;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {() => Error} invalid
 */
function boundedLimit(value, fallback, invalid) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw invalid();
  return value;
}

/**
 * Light fields only. The prompt, the transcript and the overrides stay out.
 * @param {Record<string, unknown>} json
 */
function pickMission(json) {
  /** @type {Record<string, unknown>} */
  const mission = {
    id: typeof json.id === 'string' ? json.id : null,
    agent_name: typeof json.agent_name === 'string' ? json.agent_name : null,
    status: typeof json.status === 'string' ? json.status : null,
    title: typeof json.title === 'string' ? json.title : null,
    summary: typeof json.summary === 'string' ? json.summary : null,
    started_at: json.started_at ?? null,
    ended_at: json.ended_at ?? null,
  };
  if (typeof json.last_message === 'string') mission.last_message = json.last_message;
  if (Array.isArray(json.messages)) mission.messages = json.messages;
  return mission;
}

/**
 * @param {Record<string, unknown>} task
 */
function pickTask(task) {
  const agent = typeof task.agent_name === 'string'
    ? task.agent_name
    : (typeof task.agent === 'string' ? task.agent : null);
  return {
    id: typeof task.id === 'string' ? task.id : null,
    title: typeof task.title === 'string' ? task.title : null,
    status: typeof task.status === 'string' ? task.status : null,
    agent_name: agent,
    agent,
    project: typeof task.project === 'string' ? task.project : null,
    type: typeof task.type === 'string' ? task.type : null,
    created_at: task.created_at ?? null,
    updated_at: task.updated_at ?? null,
    description: typeof task.description === 'string' ? task.description : '',
  };
}

/**
 * @param {{ status: number, json: unknown }} result
 * @returns {Record<string, unknown> | null}
 */
function taskRecord(result) {
  if (!result.json || typeof result.json !== 'object' || Array.isArray(result.json)) return null;
  const task = /** @type {{ task?: unknown }} */ (result.json).task;
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
  return /** @type {Record<string, unknown>} */ (task);
}

/**
 * @param {() => Promise<{ status: number, json: unknown }>} run
 */
async function callMission(run) {
  try {
    return await run();
  } catch (err) {
    throw asMissionTransport(err);
  }
}

/**
 * @param {() => Promise<{ status: number, json: unknown }>} run
 */
async function callTask(run) {
  try {
    return await run();
  } catch (err) {
    throw asTaskTransport(err);
  }
}

/**
 * @param {unknown} err
 */
function asMissionTransport(err) {
  if (err instanceof PluginMissionError || err instanceof PluginPolicyError) return err;
  if (err instanceof DaemonCallError) return new PluginMissionError('failed', 'daemon is unreachable');
  if (err instanceof DaemonRouteError) return new PluginMissionError('failed', 'daemon route is not allowed');
  return new PluginMissionError('failed', clipped(err));
}

/**
 * @param {unknown} err
 */
function asTaskTransport(err) {
  if (err instanceof PluginTaskError || err instanceof PluginPolicyError) return err;
  if (err instanceof DaemonCallError) return new PluginTaskError('invalid', 'daemon is unreachable');
  if (err instanceof DaemonRouteError) return new PluginTaskError('invalid', 'daemon route is not allowed');
  return new PluginTaskError('invalid', clipped(err));
}

/**
 * @param {number} status
 * @param {unknown} json
 * @param {{ send?: boolean }} [mode]
 */
function missionHttpError(status, json, mode = {}) {
  const code = errorCode(json);
  const message = errorText(json);
  if (status === 409 || code === 'turn_in_progress') return new PluginMissionError('turn_in_progress', message);
  if (status === 404 && (code === 'mission_not_running' || mode.send)) {
    return new PluginMissionError('not_running', message);
  }
  if (status === 404) return new PluginMissionError('not_found', message);
  if (status === 400) return new PluginMissionError('invalid', message);
  if (status === 403) {
    if (code === 'override_denied' || code.includes('override')) {
      return new PluginMissionError('override_denied', message);
    }
    return new PluginPolicyError(PLUGIN_ID, 'spawn_policy', message);
  }
  if (status === 503) return new PluginMissionError('backend_exhausted', message);
  return new PluginMissionError('failed', message);
}

/**
 * @param {number} status
 * @param {unknown} json
 */
function taskHttpError(status, json) {
  const code = errorCode(json);
  const message = errorText(json);
  if (status === 404) return new PluginTaskError('not_found', message);
  if (status === 409) return new PluginTaskError('conflict', message);
  if (status === 400) return new PluginTaskError('invalid', message);
  if (status === 403) {
    if (code === 'override_denied' || code.includes('override')) {
      return new PluginTaskError('forbidden', message);
    }
    return new PluginPolicyError(PLUGIN_ID, 'spawn_policy', message);
  }
  return new PluginTaskError('invalid', message);
}

/**
 * @param {unknown} json
 */
function errorCode(json) {
  if (!json || typeof json !== 'object') return '';
  const code = /** @type {{ code?: unknown }} */ (json).code;
  return typeof code === 'string' ? code : '';
}

/**
 * @param {unknown} json
 */
function errorText(json) {
  if (!json || typeof json !== 'object') return 'call refused';
  const message = /** @type {{ error?: unknown }} */ (json).error;
  return typeof message === 'string' && message ? message.slice(0, 300) : 'call refused';
}

/**
 * @param {unknown} err
 */
function clipped(err) {
  const message = err instanceof Error ? err.message : 'call refused';
  return message.slice(0, 300) || 'call refused';
}
