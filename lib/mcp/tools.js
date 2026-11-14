import {
  APPROVAL_MESSAGE,
  MESSAGE_MAX_CHARS,
  PILOT_AGENT,
  PROJECT_PATTERN,
  WAIT_DEFAULT_S,
  WAIT_MAX_S,
} from '../constants.js';

const PROJECT = new RegExp(PROJECT_PATTERN);

/**
 * Closed tool list. A name that is not here is refused before any façade call.
 * `inputSchema` is strict: `additionalProperties` is false on every tool.
 */
export const TOOLS = [
  {
    name: 'ask_main',
    description: 'Envoie un mandat au pilote _main, ou à <projet>.main si project est fourni. Sans mission_id, démarre une mission. Avec mission_id, envoie un suivi sur cette mission. Aucun autre nom d\'agent n\'est accepté. Le message est limité à 20 000 caractères.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_CHARS },
        project: { type: 'string', pattern: PROJECT_PATTERN },
        mission_id: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['message'],
    },
    run: askMain,
  },
  {
    name: 'get_reply',
    description: 'Lit l\'état d\'une mission lancée par ce plugin (missions:read). Le dernier message de l\'agent n\'est renvoyé que s\'il figure déjà sur la mission. missions:transcript est exclu : sans cette permission le corps du message n\'est en général pas lisible, et la réponse contient alors le résumé (summary) et l\'état.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mission_id: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['mission_id'],
    },
    run: getReply,
  },
  {
    name: 'wait',
    description: 'Attend la fin du tour, 25 secondes par défaut et 50 au plus, puis renvoie la même forme que get_reply plus done. S\'appuie sur turn_complete quand le contexte l\'expose, sinon sur un sondage espacé.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mission_id: { type: 'string', minLength: 1, maxLength: 200 },
        timeout_s: { type: 'number', minimum: 0, maximum: WAIT_MAX_S },
      },
      required: ['mission_id'],
    },
    run: waitForTurn,
  },
  {
    name: 'list_missions',
    description: 'Liste les missions de ce plugin. Champs renvoyés : id, agent_name, status, title, started_at, ended_at. Le prompt n\'est pas renvoyé.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', pattern: '^[a-z0-9_-]{1,40}$' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    run: listMissions,
  },
  {
    name: 'list_tasks',
    description: 'Liste les tâches visibles par ce plugin. Lecture seule. La description n\'est pas renvoyée.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', pattern: PROJECT_PATTERN },
        status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    run: listTasks,
  },
  {
    name: 'create_task',
    description: 'Crée une tâche de type chore sur le projet, assignée à son orchestrateur <projet>.main. Le backend, le modèle, le pipeline et la permission ne sont pas des paramètres : c\'est l\'orchestrateur qui découpe ensuite. L\'appel passe par la politique de spawn.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', pattern: PROJECT_PATTERN },
        title: { type: 'string', minLength: 1, maxLength: 500 },
        description: { type: 'string', maxLength: MESSAGE_MAX_CHARS },
      },
      required: ['project', 'title', 'description'],
    },
    run: createTask,
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * @param {string} name
 */
export function findTool(name) {
  return TOOL_BY_NAME.get(name);
}

/**
 * @param {object} schema
 * @param {unknown} value
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, message: string }}
 */
export function validateInput(schema, value) {
  const input = value === undefined ? {} : value;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'arguments must be an object' };
  }
  const record = /** @type {Record<string, unknown>} */ (input);
  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        return { ok: false, message: `unexpected property \`${key}\`` };
      }
    }
  }
  for (const key of schema.required ?? []) {
    if (record[key] === undefined) return { ok: false, message: `\`${key}\` is required` };
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (record[key] === undefined) continue;
    const problem = checkProperty(key, spec, record[key]);
    if (problem) return { ok: false, message: problem };
  }
  return { ok: true, value: record };
}

/**
 * @param {object} ctx
 * @param {string} name
 * @param {Record<string, unknown>} args Validated arguments.
 */
export async function runTool(ctx, name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return toolError('outil inconnu');
  try {
    const data = await tool.run(ctx, args);
    return toolSuccess(data);
  } catch (err) {
    const message = explainToolError(err);
    if (message) return toolError(message);
    throw err;
  }
}

/**
 * One refusal is final. Callers must not loop on this result.
 * @param {unknown} err
 * @returns {string | null}
 */
export function explainToolError(err) {
  if (!err || typeof err !== 'object') return null;
  const error = /** @type {{ name?: string, code?: string, reason?: string, message?: string }} */ (err);
  if (error.name === 'PluginPolicyError' || error.reason === 'spawn_policy') {
    return APPROVAL_MESSAGE;
  }
  if (error.code === 'turn_in_progress') {
    return 'Un tour est en cours. Attendez qu\'il se termine avant d\'envoyer un autre message.';
  }
  if (error.code === 'not_running') {
    return 'La mission n\'a pas de processus en cours et ne peut pas être reprise.';
  }
  if (error.name === 'PluginMissionError' && error.code === 'not_found') return 'Mission introuvable.';
  if (error.name === 'PluginTaskError' && error.code === 'not_found') return 'Tâche introuvable.';
  if (error.name === 'PluginPermissionError') return 'Permission manquante pour cet appel.';
  if (error.name === 'PluginMissionError' || error.name === 'PluginTaskError') {
    return error.message || 'appel refusé';
  }
  return null;
}

/**
 * @param {unknown} data
 */
function toolSuccess(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}

/**
 * @param {string} message
 */
export function toolError(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/**
 * @param {unknown} project
 * @returns {string}
 */
function pilotOf(project) {
  if (project === undefined) return PILOT_AGENT;
  if (typeof project !== 'string' || !PROJECT.test(project)) {
    throw Object.assign(new Error('project is invalid'), { name: 'PluginMissionError', code: 'invalid' });
  }
  return `${project}.main`;
}

/**
 * Spawn carries only the agent and the mission text. Overrides (`model`,
 * `backend`, `extraSkills`, `extraMcp`, `allow`) would raise `override_denied`
 * and are never sent.
 * @param {object} ctx
 * @param {Record<string, unknown>} args
 */
async function askMain(ctx, args) {
  const message = /** @type {string} */ (args.message);
  if (typeof args.mission_id === 'string') {
    await ctx.missions.send(args.mission_id, message);
    const mission = await ctx.missions.get(args.mission_id);
    return {
      mission_id: args.mission_id,
      agent: mission?.agent_name ?? null,
      status: mission?.status ?? null,
    };
  }
  const agent = pilotOf(args.project);
  const missionId = await ctx.missions.spawn({ agent, mission: message });
  const mission = await ctx.missions.get(missionId);
  return {
    mission_id: missionId,
    agent,
    status: mission?.status ?? 'running',
  };
}

/**
 * `ctx.missions.get` under `missions:read` returns the stored mission,
 * including `summary`, but not transcript bodies. `missions:transcript` is
 * not declared. When no message body is on the object, `message` stays null
 * and the caller still receives `summary` and the state.
 * @param {object} ctx
 * @param {Record<string, unknown>} args
 */
async function getReply(ctx, args) {
  const mission = await readMission(ctx, /** @type {string} */ (args.mission_id));
  return shapeReply(mission);
}

/**
 * @param {object} ctx
 * @param {Record<string, unknown>} args
 */
async function waitForTurn(ctx, args) {
  const missionId = /** @type {string} */ (args.mission_id);
  const timeoutS = args.timeout_s === undefined ? WAIT_DEFAULT_S : /** @type {number} */ (args.timeout_s);
  const timeoutMs = Math.min(WAIT_MAX_S, Math.max(0, timeoutS)) * 1000;
  let signaled = false;
  let unsubscribe = () => {};
  if (typeof ctx.events?.on === 'function') {
    try {
      const off = ctx.events.on('turn_complete', (event) => {
        if (!event || typeof event !== 'object') return;
        const id = event.missionId ?? event.mission_id;
        if (id === missionId) signaled = true;
      });
      if (typeof off === 'function') unsubscribe = off;
    } catch {
      // `events:subscribe` is not declared. Polling is the fallback.
      unsubscribe = () => {};
    }
  }
  try {
    const first = await readMission(ctx, missionId);
    if (signaled || isTerminal(first)) return { ...shapeReply(first), done: true };
    const deadline = Date.now() + timeoutMs;
    const pollMs = Math.min(500, Math.max(20, Math.floor(timeoutMs / 8) || 20));
    while (!signaled && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(pollMs, remaining));
      if (signaled) break;
      const next = await readMission(ctx, missionId);
      if (isTerminal(next)) return { ...shapeReply(next), done: true };
    }
    const last = await readMission(ctx, missionId);
    return { ...shapeReply(last), done: signaled || isTerminal(last) };
  } finally {
    try { unsubscribe(); } catch { /* the listener is already gone */ }
  }
}

/**
 * @param {object} ctx
 * @param {Record<string, unknown>} args
 */
async function listMissions(ctx, args) {
  /** @type {Record<string, unknown>} */
  const opts = {};
  if (args.status !== undefined) opts.status = args.status;
  if (args.limit !== undefined) opts.limit = args.limit;
  const rows = await ctx.missions.list(opts);
  const list = Array.isArray(rows) ? rows : [];
  return {
    missions: list.map((row) => ({
      id: row?.id ?? null,
      agent_name: row?.agent_name ?? null,
      status: row?.status ?? null,
      title: row?.title ?? null,
      started_at: row?.started_at ?? null,
      ended_at: row?.ended_at ?? null,
    })),
  };
}

/**
 * @param {object} ctx
 * @param {Record<string, unknown>} args
 */
async function listTasks(ctx, args) {
  /** @type {Record<string, unknown>} */
  const opts = {};
  if (args.project !== undefined) opts.project = args.project;
  if (args.status !== undefined) opts.status = args.status;
  if (args.limit !== undefined) opts.limit = args.limit;
  const rows = await ctx.kanban.list(opts);
  const list = Array.isArray(rows) ? rows : [];
  return {
    tasks: list.map((row) => ({
      id: row?.id ?? null,
      title: row?.title ?? null,
      status: row?.status ?? null,
      agent: row?.agent_name ?? row?.agent ?? null,
      project: row?.project ?? null,
      type: row?.type ?? null,
      created_at: row?.created_at ?? null,
      updated_at: row?.updated_at ?? null,
    })),
  };
}

/**
 * The task is a chore for `<project>.main`. Backend, model, pipeline and
 * permission are not forwarded. Creating a task that will run counts as a
 * spawn: a policy refusal becomes a tool error, with no retry here.
 * @param {object} ctx
 * @param {Record<string, unknown>} args
 */
async function createTask(ctx, args) {
  const project = /** @type {string} */ (args.project);
  const agent = pilotOf(project);
  const task = await ctx.kanban.add({
    project,
    title: args.title,
    description: args.description,
    agent,
    type: 'chore',
  });
  return {
    id: task?.id ?? null,
    title: task?.title ?? args.title,
    project,
    agent,
    status: task?.status ?? 'PENDING',
    type: 'chore',
  };
}

/**
 * @param {object} ctx
 * @param {string} missionId
 */
async function readMission(ctx, missionId) {
  const mission = await ctx.missions.get(missionId);
  if (!mission) {
    throw Object.assign(new Error('Mission introuvable.'), { name: 'PluginMissionError', code: 'not_found' });
  }
  return mission;
}

/**
 * @param {object} mission
 */
function shapeReply(mission) {
  return {
    mission_id: mission.id,
    agent: mission.agent_name ?? null,
    status: mission.status ?? null,
    title: mission.title ?? null,
    summary: typeof mission.summary === 'string' ? mission.summary : null,
    message: lastAgentMessage(mission),
    started_at: mission.started_at ?? null,
    ended_at: mission.ended_at ?? null,
  };
}

/**
 * Message bodies live in the transcript. `missions:get` under `missions:read`
 * does not include them unless the stored object already carries a message
 * field. The prompt (`mission`) is never treated as that message.
 * @param {object} mission
 * @returns {string | null}
 */
function lastAgentMessage(mission) {
  if (!mission || typeof mission !== 'object') return null;
  if (typeof mission.last_message === 'string' && mission.last_message.trim()) {
    return mission.last_message;
  }
  const list = mission.messages;
  if (!Array.isArray(list) || list.length === 0) return null;
  const last = list[list.length - 1];
  if (typeof last === 'string' && last.trim()) return last;
  if (!last || typeof last !== 'object') return null;
  for (const key of ['text', 'content', 'body']) {
    if (typeof last[key] === 'string' && last[key].trim()) return last[key];
  }
  return null;
}

const TERMINAL = new Set(['completed', 'failed', 'terminated', 'cancelled']);

/**
 * @param {object} mission
 */
function isTerminal(mission) {
  return TERMINAL.has(mission?.status);
}

/**
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {string} key
 * @param {object} spec
 * @param {unknown} value
 * @returns {string | null}
 */
function checkProperty(key, spec, value) {
  if (spec.enum && !spec.enum.includes(value)) {
    return `\`${key}\` is not an accepted value`;
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') return `\`${key}\` must be a string`;
    if (spec.minLength != null && value.length < spec.minLength) {
      return `\`${key}\` is too short`;
    }
    if (spec.maxLength != null && value.length > spec.maxLength) {
      return `\`${key}\` is too long`;
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
      return `\`${key}\` does not match ${spec.pattern}`;
    }
    return null;
  }
  if (spec.type === 'integer') {
    if (!Number.isInteger(value)) return `\`${key}\` must be an integer`;
    return checkRange(key, spec, value);
  }
  if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `\`${key}\` must be a finite number`;
    return checkRange(key, spec, value);
  }
  return null;
}

/**
 * @param {string} key
 * @param {{ minimum?: number, maximum?: number }} spec
 * @param {number} value
 */
function checkRange(key, spec, value) {
  if (spec.minimum != null && value < spec.minimum) return `\`${key}\` is below ${spec.minimum}`;
  if (spec.maximum != null && value > spec.maximum) return `\`${key}\` is above ${spec.maximum}`;
  return null;
}
