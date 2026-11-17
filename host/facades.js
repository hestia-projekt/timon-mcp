/**
 * Mission and task facades for the standalone host.
 *
 * They speak the same methods as the plugin context, plus the mission tools
 * of the closed list (list every mission, one message, steer, interrupt,
 * stop). The plugin tools still read and write only ids this host created.
 * Nothing here is imported by `lib/`.
 */
import { APPROVAL_MESSAGE, MESSAGE_MAX_CHARS, PLUGIN_ID, PROJECT_PATTERN } from '../lib/constants.js';
import {
  DaemonCallError,
  DaemonRouteError,
  PluginMissionError,
  PluginPolicyError,
  PluginTaskError,
} from './errors.js';
import {
  isGitRef,
  isMissionId,
  isNamedAgent,
  isProject,
  isTaskStatus,
  isTaskType,
} from './names.js';

const PROJECT = new RegExp(PROJECT_PATTERN);
const LIST_STATUS = new Set(['running', 'completed', 'failed', 'terminated']);
const LIST_FILTERS = new Set(['project', 'agent', 'status', 'limit']);
const TASK_LIST_FILTERS = new Set(['project', 'agent', 'status', 'type', 'limit']);
const OPEN_TASK_KEYS = new Set(['project', 'title', 'description', 'agent', 'type', 'base', 'deps', 'priority']);
const UPDATE_TASK_KEYS = new Set(['title', 'description', 'priority', 'deps', 'agent']);
const MOVE_TASK_KEYS = new Set(['status', 'reason', 'comment']);
/** Same bound as the plugin facade's dependency list. */
const DEPS_MAX = 200;
const PRIORITY_MIN = -1000;
const PRIORITY_MAX = 1000;
/** Ids fetched per list. Both statements apply this bound in SQL. */
const LIST_GET_MAX = 50;
/**
 * Wall-clock budget for one `list`, checked before each daemon read.
 * Fifty ids read in series can spend 20 seconds on each call
 * (`AbortSignal.timeout` in `host/daemon.js`) and would outlive
 * `server.timeout`. One read already in flight may still finish inside
 * that cap, which keeps the whole list under the idle limit. Past this
 * budget the call throws a typed timeout instead of returning the rows
 * gathered so far. A test may pass a smaller `listBudgetMs`.
 */
export const LIST_BUDGET_MS = 60_000;
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
 * One sliding window for every call that launches or relaunches an agent,
 * and for the two stops (`DELETE /api/missions/:id`, `POST /api/stop`).
 * Reads, the transcript, and `interrupt` do not take a slot.
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
 * @param {number} [deps.listBudgetMs] Test override for `LIST_BUDGET_MS`.
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
      assertSendText(text);
      takeSpawn(quota);
      return deliverSend(client, id, text);
    },

    /**
     * Same send, for a mission this host did not create. The id is still a
     * closed shape: a bad id, a reserved word, or an extra field never
     * reaches the daemon. `text` is the only body field.
     * @param {unknown} missionId
     * @param {unknown} text
     */
    async sendTo(missionId, text) {
      const id = requireAnyId(missionId);
      assertSendText(text);
      takeSpawn(quota);
      return deliverSend(client, id, text);
    },

    /**
     * State of any mission. `view=status` is fixed by the client, and the
     * prompt is dropped here. A 404 is "not there".
     * @param {unknown} missionId
     */
    async detail(missionId) {
      const id = requireAnyId(missionId);
      const result = await callMission(() => client.request('GET', `/api/missions/${id}`));
      if (result.status === 404) throw new PluginMissionError('not_found', 'Mission not found.');
      if (result.status !== 200 || !isPlain(result.json)) throw missionHttpError(result.status, result.json);
      return projectDetail(/** @type {Record<string, unknown>} */ (result.json));
    },

    /**
     * Every mission on the install. Filters are a closed set. The prompt is
     * not copied out of the daemon row.
     * @param {Record<string, unknown>} [opts]
     */
    async listAll(opts = {}) {
      const query = listQuery(opts);
      const result = await callMission(() => client.request('GET', '/api/missions', undefined, query));
      if (result.status !== 200 || !isPlain(result.json)) throw missionHttpError(result.status, result.json);
      const rows = /** @type {{ missions?: unknown }} */ (result.json).missions;
      if (!Array.isArray(rows)) throw new PluginMissionError('failed', 'daemon response was refused');
      const limit = Number(query.limit);
      /** @type {Record<string, unknown>[]} */
      const out = [];
      for (const row of rows) {
        if (!isPlain(row)) continue;
        out.push(projectListRow(row));
        if (out.length >= limit) break;
      }
      return out;
    },

    /**
     * One message. The text is cut at `MESSAGE_MAX_CHARS`. The daemon's extra
     * fields (the raw payload, the prompt) are not returned.
     * @param {unknown} missionId
     * @param {unknown} eventId
     */
    async message(missionId, eventId) {
      const id = requireAnyId(missionId);
      const event = requireEventId(eventId);
      const result = await callMission(() => client.request('GET', `/api/missions/${id}/messages/${event}`));
      if (result.status === 404) throw new PluginMissionError('message_not_found', 'Message not found.');
      if (result.status !== 200 || !isPlain(result.json)) throw missionHttpError(result.status, result.json);
      return projectMessage(id, event, /** @type {Record<string, unknown>} */ (result.json));
    },

    /**
     * Redirects the turn in progress. `input` is the only field sent.
     * Counts against the spawn window: a steer can resume the agent.
     * @param {unknown} missionId
     * @param {unknown} text
     */
    async steer(missionId, text) {
      const id = requireAnyId(missionId);
      if (typeof text !== 'string' || !text.trim() || text.length > MESSAGE_MAX_CHARS) {
        throw new PluginMissionError('invalid', 'text is required');
      }
      takeSpawn(quota);
      const result = await callMission(() => client.request('POST', `/api/missions/${id}/steer`, { input: text }));
      if (result.status === 200 && isPlain(result.json) && result.json.ok === true) {
        const method = result.json.method;
        return {
          ok: true,
          method: typeof method === 'string' && method.length > 0 && method.length <= 40 ? method : null,
        };
      }
      throw missionHttpError(result.status, result.json, { steer: true });
    },

    /**
     * Interrupts the turn. Does not take a quota slot: it does not launch.
     * @param {unknown} missionId
     */
    async interrupt(missionId) {
      const id = requireAnyId(missionId);
      const result = await callMission(() => client.request('POST', `/api/missions/${id}/interrupt`));
      if (result.status === 404) throw new PluginMissionError('not_found', 'Mission not found.');
      if (result.status !== 200 || !isPlain(result.json)) throw missionHttpError(result.status, result.json);
      return {
        ok: true,
        status: typeof result.json.status === 'string' ? result.json.status.slice(0, 40) : null,
        resumable: result.json.resumable === true,
        turn_active: result.json.turnActive === true || result.json.turn_active === true,
      };
    },

    /**
     * Stops one mission (`DELETE`). Counts against the window.
     * @param {unknown} missionId
     */
    async stop(missionId) {
      const id = requireAnyId(missionId);
      takeSpawn(quota);
      const result = await callMission(() => client.request('DELETE', `/api/missions/${id}`));
      if (result.status === 404) throw new PluginMissionError('stop_missed', 'The mission is not running.');
      if (result.status !== 200 || !isPlain(result.json) || result.json.ok !== true) {
        throw missionHttpError(result.status, result.json);
      }
      const outcome = result.json.outcome;
      return {
        ok: true,
        outcome: outcome === 'killed' || outcome === 'closed' ? outcome : null,
      };
    },

    /**
     * Stops one agent or one project (`POST /api/stop`). Exactly one of the
     * two fields. Counts against the window. The daemon report is projected:
     * message bodies and task titles stay out.
     * @param {unknown} input
     */
    async stopScope(input) {
      const body = stopBody(input);
      takeSpawn(quota);
      const result = await callMission(() => client.request('POST', '/api/stop', body));
      if (result.status === 404) throw new PluginMissionError('not_found', 'Scope not found.');
      if (result.status !== 200 || !isPlain(result.json) || result.json.ok !== true) {
        throw missionHttpError(result.status, result.json);
      }
      return projectStop(result.json);
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
      const beforeRead = listBudget(deps.listBudgetMs, () => new PluginMissionError('timeout', 'list timed out'));
      /** @type {Record<string, unknown>[]} */
      const rows = [];
      for (const row of listed.all(LIST_GET_MAX)) {
        const id = safeId(row && row.id);
        if (!id) continue;
        beforeRead();
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
 * @param {number} [deps.listBudgetMs] Test override for `LIST_BUDGET_MS`.
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
      const beforeRead = listBudget(deps.listBudgetMs, () => new PluginTaskError('timeout', 'list timed out'));
      /** @type {Record<string, unknown>[]} */
      const rows = [];
      for (const row of listed.all(LIST_GET_MAX)) {
        const id = safeId(row && row.id);
        if (!id) continue;
        beforeRead();
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

    /**
     * Every task on the install. The daemon is asked for `status` only.
     * Project, agent, and type are applied here. Overrides and paths are dropped.
     * @param {Record<string, unknown>} [opts]
     */
    async listAll(opts = {}) {
      const filter = taskListFilter(opts);
      const query = filter.status ? { status: filter.status } : undefined;
      const result = await callTask(() => client.request('GET', '/api/tasks', undefined, query));
      if (result.status !== 200 || !isPlain(result.json)) throw taskHttpError(result.status, result.json);
      const rows = /** @type {{ tasks?: unknown }} */ (result.json).tasks;
      if (!Array.isArray(rows)) throw new PluginTaskError('invalid', 'daemon response was refused');
      /** @type {Record<string, unknown>[]} */
      const out = [];
      for (const row of rows) {
        if (!isPlain(row)) continue;
        if (filter.project && row.project !== filter.project) continue;
        if (filter.agent && row.agent_name !== filter.agent) continue;
        if (filter.status && row.status !== filter.status) continue;
        if (filter.type && row.type !== filter.type) continue;
        out.push(projectTaskList(row));
        if (out.length >= filter.limit) break;
      }
      return out;
    },

    /**
     * One task, whether or not this host created it. A 404 is "not there".
     * @param {unknown} taskId
     */
    async read(taskId) {
      const id = requireTaskId(taskId);
      const result = await callTask(() => client.request('GET', `/api/tasks/${id}`));
      return taskFromResult(id, result, 200);
    },

    /**
     * A task of any of the six types, on an agent that already exists.
     * The body is a whitelist. Counts against the spawn window: the dispatcher
     * will run it. The chore tool keeps using `add`.
     * @param {unknown} input
     */
    async create(input) {
      const body = openTaskBody(input);
      takeSpawn(quota);
      const result = await callTask(() => client.request('POST', '/api/tasks', body));
      const task = result.status === 201 ? taskRecord(result) : null;
      if (!task) throw taskHttpError(result.status, result.json);
      const picked = projectTaskDetail(task);
      const id = safeId(picked.id);
      if (!id) throw new PluginTaskError('invalid', 'daemon response was refused');
      insert.run(id, body.project, body.agent_name, body.title, Date.now());
      return { ...picked, id };
    },

    /**
     * Title, description, priority, dependencies, or agent. Not the status.
     * Does not take a quota slot.
     * @param {unknown} taskId
     * @param {unknown} input
     */
    async update(taskId, input) {
      const id = requireTaskId(taskId);
      const body = updateTaskBody(input);
      const result = await callTask(() => client.request('PUT', `/api/tasks/${id}`, body));
      return taskFromResult(id, result, 200);
    },

    /**
     * Status change. `BLOCKED` requires a reason (`blocked_reason`).
     * `comment` is sent as `done_comment` in the same body: release 0.1.8
     * stores that field when the status changes. Does not take a quota slot.
     * @param {unknown} taskId
     * @param {unknown} input
     */
    async move(taskId, input) {
      const id = requireTaskId(taskId);
      const body = moveTaskBody(input);
      const result = await callTask(() => client.request('PUT', `/api/tasks/${id}`, body));
      return taskFromResult(id, result, 200);
    },

    /**
     * `done_comment`, the comment field `PUT /api/tasks/:id` accepts.
     * Release 0.1.8 applies it when the same request also changes the status.
     * A comment alone still sends nothing else. Does not take a quota slot.
     * @param {unknown} taskId
     * @param {unknown} text
     */
    async comment(taskId, text) {
      const id = requireTaskId(taskId);
      const comment = commentText(text);
      const result = await callTask(() => client.request('PUT', `/api/tasks/${id}`, { done_comment: comment }));
      return taskFromResult(id, result, 200);
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
  if (!isNamedAgent(agent)) {
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
 * The six types. Optional `priority`, `deps`, and `base` are sent only when set.
 * @param {unknown} input
 */
function openTaskBody(input) {
  const record = plainRecord(input, () => new PluginTaskError('invalid', 'task is required'));
  refuseTaskKeys(record, OPEN_TASK_KEYS);
  const project = record.project;
  const title = record.title;
  const agent = record.agent;
  const type = record.type;
  const description = record.description;
  if (!isProject(project)) throw new PluginTaskError('invalid', 'project is invalid');
  if (!isTaskType(type)) throw new PluginTaskError('invalid', 'type is invalid');
  if (!isNamedAgent(agent)) throw new PluginTaskError('invalid', 'agent is invalid');
  if (typeof title !== 'string' || !title.trim() || title.length > 500) {
    throw new PluginTaskError('invalid', 'title is required');
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > MESSAGE_MAX_CHARS)) {
    throw new PluginTaskError('invalid', 'description is invalid');
  }
  /** @type {Record<string, unknown>} */
  const body = {
    title,
    description: typeof description === 'string' ? description : '',
    agent_name: agent,
    type,
    project,
  };
  if (record.priority !== undefined) body.priority = requirePriority(record.priority);
  if (record.deps !== undefined) body.deps = requireDeps(record.deps);
  if (record.base !== undefined) {
    if (!isGitRef(record.base)) throw new PluginTaskError('invalid', 'base is invalid');
    body.base = record.base;
  }
  return body;
}

/**
 * @param {unknown} input
 */
function updateTaskBody(input) {
  const record = plainRecord(input, () => new PluginTaskError('invalid', 'task is required'));
  refuseTaskKeys(record, UPDATE_TASK_KEYS);
  /** @type {Record<string, unknown>} */
  const body = {};
  if (record.title !== undefined) {
    if (typeof record.title !== 'string' || !record.title.trim() || record.title.length > 500) {
      throw new PluginTaskError('invalid', 'title is required');
    }
    body.title = record.title;
  }
  if (record.description !== undefined) {
    if (typeof record.description !== 'string' || record.description.length > MESSAGE_MAX_CHARS) {
      throw new PluginTaskError('invalid', 'description is invalid');
    }
    body.description = record.description;
  }
  if (record.priority !== undefined) body.priority = requirePriority(record.priority);
  if (record.deps !== undefined) body.deps = requireDeps(record.deps);
  if (record.agent !== undefined) {
    if (!isNamedAgent(record.agent)) throw new PluginTaskError('invalid', 'agent is invalid');
    body.agent_name = record.agent;
  }
  if (Object.keys(body).length === 0) throw new PluginTaskError('invalid', 'task update is empty');
  return body;
}

/**
 * @param {unknown} input
 */
function moveTaskBody(input) {
  const record = plainRecord(input, () => new PluginTaskError('invalid', 'task is required'));
  refuseTaskKeys(record, MOVE_TASK_KEYS);
  if (!isTaskStatus(record.status)) throw new PluginTaskError('invalid', 'status is invalid');
  /** @type {Record<string, unknown>} */
  const body = { status: record.status };
  if (record.status === 'BLOCKED') {
    if (!commentTextOk(record.reason)) {
      throw new PluginTaskError('invalid', 'reason is required to mark a task as blocked');
    }
    body.blocked_reason = record.reason;
  } else if (record.reason !== undefined) {
    throw new PluginTaskError('invalid', 'reason is only accepted when status is BLOCKED');
  }
  if (record.comment !== undefined) {
    body.done_comment = commentText(record.comment);
  }
  return body;
}

/**
 * @param {unknown} text
 */
function commentText(text) {
  if (!commentTextOk(text)) throw new PluginTaskError('invalid', 'comment is required');
  return text;
}

/**
 * @param {unknown} text
 */
function commentTextOk(text) {
  return typeof text === 'string' && Boolean(text.trim()) && text.length <= MESSAGE_MAX_CHARS;
}

/**
 * @param {unknown} value
 */
function requirePriority(value) {
  if (!Number.isInteger(value) || value < PRIORITY_MIN || value > PRIORITY_MAX) {
    throw new PluginTaskError('invalid', 'priority is invalid');
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function requireDeps(value) {
  if (!Array.isArray(value) || value.length > DEPS_MAX) {
    throw new PluginTaskError('invalid', 'deps is invalid');
  }
  for (const item of value) {
    if (!isMissionId(item)) throw new PluginTaskError('invalid', 'deps is invalid');
  }
  return value.slice();
}

/**
 * @param {Record<string, unknown>} record
 * @param {Set<string>} allowed
 */
function refuseTaskKeys(record, allowed) {
  refuseKeys(record, allowed, (key) => {
    if (overrideKey(key)) throw new PluginTaskError('forbidden', 'override is not allowed');
    throw new PluginTaskError('invalid', 'unexpected field');
  });
}

/**
 * @param {unknown} id
 * @returns {string}
 */
function requireTaskId(id) {
  if (!isMissionId(id)) throw new PluginTaskError('invalid', 'task id is invalid');
  return id;
}

/**
 * @param {Record<string, unknown>} opts
 */
function taskListFilter(opts) {
  const record = isPlain(opts) ? opts : {};
  refuseTaskKeys(record, TASK_LIST_FILTERS);
  /** @type {{ limit: number, project?: string, agent?: string, status?: string, type?: string }} */
  const filter = {
    limit: boundedLimit(record.limit, 50, () => new PluginTaskError('invalid', 'limit is invalid')),
  };
  if (record.project !== undefined) {
    if (!isProject(record.project)) throw new PluginTaskError('invalid', 'project is invalid');
    filter.project = record.project;
  }
  if (record.agent !== undefined) {
    if (!isNamedAgent(record.agent)) throw new PluginTaskError('invalid', 'agent is invalid');
    filter.agent = record.agent;
  }
  if (record.status !== undefined) {
    if (!isTaskStatus(record.status)) throw new PluginTaskError('invalid', 'status is invalid');
    filter.status = record.status;
  }
  if (record.type !== undefined) {
    if (!isTaskType(record.type)) throw new PluginTaskError('invalid', 'type is invalid');
    filter.type = record.type;
  }
  return filter;
}

/**
 * @param {string} id
 * @param {{ status: number, json: unknown }} result
 * @param {number} okStatus
 */
function taskFromResult(id, result, okStatus) {
  if (result.status === 404) throw new PluginTaskError('not_found', 'Task not found.');
  const task = result.status === okStatus ? taskRecord(result) : null;
  if (!task) throw taskHttpError(result.status, result.json);
  const picked = projectTaskDetail(task);
  if (picked.id !== id) throw new PluginTaskError('invalid', 'daemon response was refused');
  return picked;
}

/**
 * List row. Description, comment, overrides, and paths stay out.
 * @param {Record<string, unknown>} task
 */
function projectTaskList(task) {
  return {
    id: asString(task.id),
    title: asString(task.title),
    status: asString(task.status),
    agent_name: asString(task.agent_name),
    project: asString(task.project),
    type: asString(task.type),
    priority: Number.isInteger(task.priority) ? task.priority : null,
    deps: asDeps(task.deps),
    created_at: asStamp(task.created_at),
    updated_at: asStamp(task.updated_at),
  };
}

/**
 * Detail. `done_comment` is the comment column. `base` is `base_branch`.
 * @param {Record<string, unknown>} task
 */
function projectTaskDetail(task) {
  /** @type {{ hit: boolean }} */
  const flag = { hit: false };
  return {
    ...projectTaskList(task),
    description: takeText(task.description, '', flag),
    base: asString(typeof task.base_branch === 'string' ? task.base_branch : task.base),
    blocked_reason: takeText(task.blocked_reason, null, flag),
    done_comment: takeText(task.done_comment, null, flag),
    truncated: flag.hit,
  };
}

/**
 * The column is a JSON array, sometimes already parsed.
 * @param {unknown} value
 * @returns {string[]}
 */
function asDeps(value) {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((item) => typeof item === 'string').slice(0, DEPS_MAX);
}

/**
 * @param {unknown} value
 * @param {string | null} empty
 * @param {{ hit: boolean }} flag
 * @returns {string | null}
 */
function takeText(value, empty, flag) {
  if (typeof value !== 'string') return empty;
  const bounded = boundText(value);
  if (bounded.truncated) flag.hit = true;
  return bounded.text;
}

/**
 * @param {unknown} text
 */
function assertSendText(text) {
  if (typeof text !== 'string' || !text || text.length > MESSAGE_MAX_CHARS) {
    throw new PluginMissionError('invalid', 'text is required');
  }
}

/**
 * @param {string} id
 * @param {string} text
 */
async function deliverSend(client, id, text) {
  const result = await callMission(() => client.request('POST', `/api/agents/${id}/send`, { input: text }));
  if (result.status === 200 && isPlain(result.json) && result.json.ok === true) {
    return { resumed: result.json.resumed === true };
  }
  throw missionHttpError(result.status, result.json, { send: true });
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
 * @param {unknown} value
 * @param {() => Error} invalid
 * @returns {Record<string, unknown>}
 */
function plainRecord(value, invalid) {
  if (!isPlain(value)) throw invalid();
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
  if (!isMissionId(id)) return false;
  return Boolean(owned.get(id));
}

/**
 * A mission id the daemon may be asked about. Reserved route words are
 * refused here, before the client, so the tool error names the id.
 * @param {unknown} id
 * @returns {string}
 */
function requireAnyId(id) {
  if (!isMissionId(id)) throw new PluginMissionError('invalid', 'mission id is invalid');
  return id;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function requireEventId(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,14}$/.test(text)) {
    throw new PluginMissionError('invalid', 'event id is invalid');
  }
  return text;
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
  if (!isMissionId(value)) return null;
  return value;
}

/**
 * @param {Record<string, unknown>} opts
 * @returns {Record<string, string>}
 */
function listQuery(opts) {
  const record = isPlain(opts) ? opts : {};
  refuseKeys(record, LIST_FILTERS, () => {
    throw new PluginMissionError('invalid', 'unexpected field');
  });
  /** @type {Record<string, string>} */
  const query = {};
  if (record.project !== undefined) {
    if (!isProject(record.project)) throw new PluginMissionError('invalid', 'project is invalid');
    query.project = record.project;
  }
  if (record.agent !== undefined) {
    if (!isNamedAgent(record.agent)) throw new PluginMissionError('invalid', 'agent is invalid');
    query.agent = record.agent;
  }
  if (record.status !== undefined) {
    if (typeof record.status !== 'string' || !LIST_STATUS.has(record.status)) {
      throw new PluginMissionError('invalid', 'status is invalid');
    }
    query.status = record.status;
  }
  const limit = boundedLimit(record.limit, 50, () => new PluginMissionError('invalid', 'limit is invalid'));
  query.limit = String(limit);
  return query;
}

/**
 * @param {unknown} input
 * @returns {{ agent: string } | { project: string }}
 */
function stopBody(input) {
  const record = plainRecord(input, () => new PluginMissionError('invalid', 'scope is required'));
  const keys = Object.keys(record);
  if (keys.length !== 1 || (keys[0] !== 'agent' && keys[0] !== 'project')) {
    if (keys.some((key) => overrideKey(key))) {
      throw new PluginMissionError('override_denied', 'override is not allowed');
    }
    throw new PluginMissionError('invalid', 'expected agent or project');
  }
  const value = record[keys[0]];
  if (keys[0] === 'agent') {
    if (!isNamedAgent(value)) throw new PluginMissionError('invalid', 'agent is invalid');
    return { agent: value };
  }
  if (!isProject(value)) throw new PluginMissionError('invalid', 'project is invalid');
  return { project: value };
}

/**
 * Deadline for one list. `listBudgetMs` is a test override; production uses
 * `LIST_BUDGET_MS`. The check runs before each daemon read.
 * @param {number | undefined} raw
 * @param {() => Error} timeout
 */
function listBudget(raw, timeout) {
  const budget = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : LIST_BUDGET_MS;
  const deadline = Date.now() + budget;
  return function beforeRead() {
    if (Date.now() >= deadline) throw timeout();
  };
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
 * List row. The prompt (`mission`) and every field outside this set are dropped.
 * @param {Record<string, unknown>} json
 */
function projectListRow(json) {
  return {
    id: asString(json.id),
    agent_name: asString(json.agent_name),
    status: asString(json.status),
    title: asString(json.title),
    started_at: asStamp(json.started_at),
    ended_at: asStamp(json.ended_at),
    running: asBool(json.running),
    liveness: asShort(json.liveness),
    turn_active: asBool(json.turn_active),
    exit_code: asInt(json.exit_code),
    task_id: asString(json.task_id),
  };
}

/**
 * Detail. Still no prompt, no transcript, no override, no owner, no cwd.
 * @param {Record<string, unknown>} json
 */
function projectDetail(json) {
  return {
    ...projectListRow(json),
    title_source: asShort(json.title_source),
    turn_complete: asBool(json.turn_complete),
    turn_preparing: asBool(json.turn_preparing),
    interrupted_reason: asShort(json.interrupted_reason),
    source_channel: asShort(json.source_channel),
    origin: asShort(json.origin),
    parent_mission_id: asString(json.parent_mission_id),
    parent_agent: asString(json.parent_agent),
    routine_id: asString(json.routine_id),
    pending_action_at: asStamp(json.pending_action_at),
    pending_action_id: asString(json.pending_action_id),
    children: projectChildren(json.children),
  };
}

/**
 * @param {unknown} value
 */
function projectChildren(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).filter(isPlain).map((row) => ({
    id: asString(row.id),
    agent_name: asString(row.agent_name),
    status: asString(row.status),
    started_at: asStamp(row.started_at),
  }));
}

/**
 * @param {string} missionId
 * @param {string} eventId
 * @param {Record<string, unknown>} json
 */
function projectMessage(missionId, eventId, json) {
  if (json.mission_id !== undefined && json.mission_id !== missionId) {
    throw new PluginMissionError('failed', 'daemon response was refused');
  }
  const reported = json.event_id ?? json.id;
  if (reported !== undefined && String(reported) !== eventId) {
    throw new PluginMissionError('failed', 'daemon response was refused');
  }
  if (typeof json.text !== 'string') throw new PluginMissionError('failed', 'daemon response was refused');
  const bounded = boundText(json.text);
  const role = json.role === 'agent' || json.role === 'user' ? json.role : null;
  return {
    mission_id: missionId,
    event_id: Number(eventId),
    role,
    timestamp: asStamp(json.timestamp),
    text: bounded.text,
    truncated: bounded.truncated,
  };
}

/**
 * @param {string} text
 */
function boundText(text) {
  if (text.length <= MESSAGE_MAX_CHARS) return { text, truncated: false };
  let end = MESSAGE_MAX_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/**
 * @param {Record<string, unknown>} json
 */
function projectStop(json) {
  const scope = isPlain(json.scope) ? json.scope : {};
  const kind = scope.kind === 'agent' || scope.kind === 'project' ? scope.kind : null;
  const name = typeof scope.name === 'string' && scope.name.length <= 200 ? scope.name : null;
  const agents = Array.isArray(json.agents)
    ? json.agents.filter((item) => typeof item === 'string' && item.length <= 200).slice(0, 100)
    : [];
  const missions = Array.isArray(json.missions)
    ? json.missions.filter(isPlain).slice(0, 100).map((row) => {
      const outcome = row.outcome;
      return {
        id: asString(row.id),
        agent: asString(row.agent ?? row.agent_name),
        outcome: outcome === 'killed' || outcome === 'closed' || outcome === 'not_found' ? outcome : null,
      };
    })
    : [];
  return {
    ok: true,
    scope: { kind, name },
    agents,
    missions,
    task_count: Array.isArray(json.tasks) ? json.tasks.length : 0,
    workflow_count: Array.isArray(json.workflows) ? json.workflows.length : 0,
  };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asString(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asShort(value) {
  return typeof value === 'string' && value.length <= 80 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {boolean | null}
 */
function asBool(value) {
  return typeof value === 'boolean' ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asStamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asInt(value) {
  return Number.isInteger(value) ? value : null;
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
 * @param {{ send?: boolean, steer?: boolean }} [mode]
 */
function missionHttpError(status, json, mode = {}) {
  const code = errorCode(json);
  const message = errorText(json);
  if (status === 409 && mode.steer) {
    return new PluginMissionError('no_turn', 'No turn is running. Send a message instead.');
  }
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
