/**
 * Closed HTTP client for the local daemon.
 *
 * The daemon token is a super-administrator credential. This module is the
 * only place that may open a socket to the daemon, and only for the routes
 * below. Any other method, path, query key, or body field throws before
 * `fetch`. The token is read from disk on every call and is never written
 * into the journal, an error message, or a returned document.
 */
import { readFileSync } from 'node:fs';
import { MESSAGE_MAX_CHARS } from '../lib/constants.js';
import { DaemonBodyError, DaemonCallError, DaemonRouteError } from './errors.js';
import {
  AUTOMATION_ID,
  DIRECT_FROM_AGENT,
  DIRECT_FROM_MISSION,
  EVENT_ID,
  LIST_LIMIT,
  LIST_STATUS,
  MESSAGE_KIND_NAMES,
  MISSION_ID,
  NAMED_AGENT,
  PROJECT_NAME,
  RESERVED_AGENT_WORDS,
  RESERVED_MISSION_IDS,
  RESERVED_WORKFLOW_IDS,
  TASK_STATUS,
  isWorkReturnPayload,
} from './names.js';

/** Longest daemon body this client will parse, except `GET /api/tasks`. */
export const RESPONSE_MAX_BYTES = 1024 * 1024;

/**
 * `GET /api/tasks` returns every column of every row. Release 0.1.8 has no
 * limit, project, agent, type, or pagination on that route. Its own board
 * note records a 12 MB full-text answer for 2,571 tasks; the default view
 * cuts the long texts, and this client never sends `full`. 8 MiB covers that
 * preview with a margin. The read still stops at this cap.
 */
export const TASK_LIST_MAX_BYTES = 8 * 1024 * 1024;

/** Tool-facing text when `GET /api/tasks` crosses `TASK_LIST_MAX_BYTES`. */
export const TASK_LIST_TOO_LARGE = `too_large: GET /api/tasks exceeded ${TASK_LIST_MAX_BYTES / (1024 * 1024)} MiB. Release 0.1.8 has no limit, project, agent, type, or pagination. Pass status, or read one task with get_task.`;

/**
 * Pipelines, workflows, and routines have no limit or pagination on release
 * 0.1.8. A workflow list carries every draft, and a run list carries every
 * `context`. Same ceiling as `GET /api/tasks`.
 */
export const AUTOMATION_READ_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Serialised size of a run's `input`. Same cap as `MAX_PIPELINE_INPUT_BYTES`
 * and `MAX_WORKFLOW_INPUT_BYTES` in release 0.1.8.
 */
export const RUN_INPUT_MAX_BYTES = 64 * 1024;

/**
 * @param {string} method
 * @param {string} path
 */
export function automationTooLarge(method, path) {
  const mib = AUTOMATION_READ_MAX_BYTES / (1024 * 1024);
  return `too_large: ${method} ${path} exceeded ${mib} MiB. Release 0.1.8 has no limit or pagination on this route. Pass limit, or read one item.`;
}

const ID_SEGMENT = MISSION_ID.source.slice(1, -1);
const EVENT_SEGMENT = EVENT_ID.source.slice(1, -1);
const AGENT_SEGMENT = NAMED_AGENT.source.slice(1, -1);
const AUTO_SEGMENT = AUTOMATION_ID.source.slice(1, -1);

/**
 * Couples the host is allowed to call. `:id` is one mission id.
 * `GET /api/missions/:id` always asks `view=status`: the chat view would
 * return the transcript. The list's query keys are the only ones accepted,
 * and only when passed as `query`, never as a string glued to the path.
 */
export const DAEMON_ROUTES = Object.freeze([
  Object.freeze({
    name: 'missions.spawn',
    method: 'POST',
    path: '/api/missions',
    body: Object.freeze(['agent', 'mission']),
  }),
  Object.freeze({
    name: 'missions.list',
    method: 'GET',
    path: '/api/missions',
    query: Object.freeze(['project', 'agent', 'status', 'limit']),
  }),
  Object.freeze({
    name: 'missions.get',
    method: 'GET',
    path: '/api/missions/:id',
    fixedQuery: 'view=status',
  }),
  Object.freeze({
    name: 'missions.message',
    method: 'GET',
    path: '/api/missions/:id/messages/:eventId',
  }),
  Object.freeze({
    name: 'missions.send',
    method: 'POST',
    path: '/api/agents/:id/send',
    body: Object.freeze(['input']),
  }),
  Object.freeze({
    name: 'missions.steer',
    method: 'POST',
    path: '/api/missions/:id/steer',
    body: Object.freeze(['input']),
  }),
  Object.freeze({
    name: 'missions.interrupt',
    method: 'POST',
    path: '/api/missions/:id/interrupt',
  }),
  Object.freeze({
    name: 'missions.stop',
    method: 'DELETE',
    path: '/api/missions/:id',
  }),
  Object.freeze({
    name: 'missions.stopScope',
    method: 'POST',
    path: '/api/stop',
    body: 'stop-scope',
  }),
  Object.freeze({
    name: 'tasks.add',
    method: 'POST',
    path: '/api/tasks',
    // Required keys, plus the optional ones. A missing required key is refused.
    // `backend`, `model`, `permission`, `fallback`, and the extra-* lists are not here.
    body: Object.freeze(['title', 'description', 'agent_name', 'type', 'project', 'priority', 'deps', 'base']),
    bodyRequired: Object.freeze(['title', 'description', 'agent_name', 'type', 'project']),
  }),
  Object.freeze({
    name: 'tasks.get',
    method: 'GET',
    path: '/api/tasks/:id',
  }),
  Object.freeze({
    name: 'tasks.list',
    method: 'GET',
    path: '/api/tasks',
    // Release 0.1.8 filters on `status` only. It has no limit, project, agent,
    // type, or pagination. `full` returns the uncut texts and is refused.
    // `done_limit` only windows DONE rows and still returns every other status,
    // so it is not a bound. Project, agent, and type stay in the host, after
    // this read. The read ceiling for this route is TASK_LIST_MAX_BYTES.
    query: Object.freeze(['status']),
    queryStatus: TASK_STATUS,
  }),
  Object.freeze({
    name: 'tasks.update',
    method: 'PUT',
    path: '/api/tasks/:id',
    // Move and edit. `done_comment` is stored by release 0.1.8 only when this
    // same request changes the status, so the host never sends it alone.
    // There is no DELETE: `kanban:delete` is not a gesture of this host.
    body: Object.freeze([
      'title', 'description', 'agent_name', 'priority', 'deps', 'status', 'blocked_reason', 'done_comment',
    ]),
    bodyRequired: Object.freeze([]),
  }),
  Object.freeze({
    name: 'projects.list',
    method: 'GET',
    path: '/api/projects',
  }),
  Object.freeze({
    name: 'agents.list',
    method: 'GET',
    path: '/api/agents',
  }),
  Object.freeze({
    // `:name` is `_main` or `<project>.<role>`. `active`, `spawn`, `ephemeral`,
    // and `main` are their own daemon routes and never match this pattern.
    name: 'agents.get',
    method: 'GET',
    path: '/api/agents/:name',
  }),
  Object.freeze({
    name: 'messages.send',
    method: 'POST',
    path: '/api/messages',
    // `from_mission` and `from_agent` are present, and their values are fixed
    // by `assertDirectMessage`. A caller-supplied value is refused here.
    body: Object.freeze(['to_agent', 'payload', 'kind', 'from_mission', 'from_agent']),
  }),
  Object.freeze({
    name: 'pipelines.list',
    method: 'GET',
    path: '/api/pipelines',
    maxBytes: AUTOMATION_READ_MAX_BYTES,
  }),
  Object.freeze({
    name: 'pipelines.get',
    method: 'GET',
    path: '/api/pipelines/:auto',
    maxBytes: AUTOMATION_READ_MAX_BYTES,
  }),
  Object.freeze({
    // Longer than `:auto`, so `runs` is this route and not a pipeline id.
    name: 'pipelines.runStatus',
    method: 'GET',
    path: '/api/pipelines/runs/:auto',
    maxBytes: AUTOMATION_READ_MAX_BYTES,
  }),
  Object.freeze({
    name: 'pipelines.run',
    method: 'POST',
    path: '/api/pipelines/:auto/run',
    // Exactly `{ input }`. `draft`, backend, model, and permission are not keys.
    body: Object.freeze(['input']),
  }),
  Object.freeze({
    name: 'workflows.list',
    method: 'GET',
    path: '/api/workflows',
    maxBytes: AUTOMATION_READ_MAX_BYTES,
  }),
  Object.freeze({
    name: 'workflows.get',
    method: 'GET',
    path: '/api/workflows/:auto',
    maxBytes: AUTOMATION_READ_MAX_BYTES,
  }),
  Object.freeze({
    name: 'workflows.runs',
    method: 'GET',
    path: '/api/workflows/:auto/runs',
    maxBytes: AUTOMATION_READ_MAX_BYTES,
  }),
  Object.freeze({
    name: 'workflows.run',
    method: 'POST',
    path: '/api/workflows/:auto/run',
    // Exactly `{ input }`. `draft` would run the unpublished graph and is refused.
    body: Object.freeze(['input']),
  }),
  Object.freeze({
    name: 'routines.list',
    method: 'GET',
    path: '/api/routines',
    maxBytes: AUTOMATION_READ_MAX_BYTES,
  }),
  Object.freeze({
    name: 'routines.get',
    method: 'GET',
    path: '/api/routines/:auto',
    maxBytes: AUTOMATION_READ_MAX_BYTES,
  }),
].map((route) => Object.freeze({ ...route, re: compileRoute(route.path) })));

/**
 * @param {string} path
 */
function compileRoute(path) {
  const body = path.split('/').map((segment) => {
    if (segment === ':id') return ID_SEGMENT;
    if (segment === ':eventId') return EVENT_SEGMENT;
    if (segment === ':name') return AGENT_SEGMENT;
    if (segment === ':auto') return AUTO_SEGMENT;
    if (segment.startsWith(':') && segment.length > 1) return '[^/]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return new RegExp(`^${body}$`);
}

/**
 * Loopback only. A token must not leave the machine because of a setting.
 * @param {string} raw
 */
export function resolveDaemonOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('daemon URL is invalid');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1')) {
    throw new Error('daemon URL must be http on the loopback');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('daemon URL is invalid');
  }
  return url.origin;
}

/**
 * @param {string} method
 * @param {string} path
 * @returns {{ name: string, method: string, path: string } | null}
 */
export function matchDaemonRoute(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('\\') || path.includes('..')) {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded !== path) return null;
  if (reservedMissionPath(path) || reservedAgentPath(path) || reservedWorkflowPath(path)) return null;
  const upper = method.toUpperCase();
  return DAEMON_ROUTES.find((route) => route.method === upper && route.re.test(path)) ?? null;
}

/**
 * `GET /api/missions/latest` and `GET /api/missions/search` are real daemon
 * routes. The `:id` pattern would otherwise carry those words to them.
 * @param {string} path
 */
function reservedMissionPath(path) {
  const parts = path.split('/');
  if (parts[1] !== 'api' || parts[2] !== 'missions') return false;
  return RESERVED_MISSION_IDS.has(parts[3]);
}

/**
 * `GET /api/agents/active` and the write routes under `spawn`, `ephemeral`,
 * and `main` are real daemon routes. The `:name` pattern must not carry
 * those words.
 * @param {string} path
 */
function reservedAgentPath(path) {
  const parts = path.split('/');
  if (parts[1] !== 'api' || parts[2] !== 'agents' || parts.length !== 4) return false;
  return RESERVED_AGENT_WORDS.has(parts[3]);
}

/**
 * `GET /api/workflows/runs`, `GET /api/workflows/runs/:runId`,
 * `GET /api/workflows/node-types`, and `POST /api/workflows/import/…` are
 * real daemon routes. `:auto` must not carry those words. `hooks` is the
 * retired token URL and is refused the same way.
 * @param {string} path
 */
function reservedWorkflowPath(path) {
  const parts = path.split('/');
  if (parts[1] !== 'api' || parts[2] !== 'workflows') return false;
  return RESERVED_WORKFLOW_IDS.has(parts[3]);
}

/**
 * @param {object} options
 * @param {string} options.origin Loopback origin, no path.
 * @param {string} options.tokenFile Read on every call.
 * @param {NodeJS.ProcessEnv} options.env Bearer source. Never logged.
 * @param {string} options.bearerName Environment name of the static bearer.
 * @param {Array<{ method: string, path: string, status: number }> | null} [options.journal]
 */
export function createDaemonClient(options) {
  const origin = options.origin;
  const tokenFile = options.tokenFile;
  const env = options.env;
  const bearerName = options.bearerName;
  const journal = options.journal ?? null;
  /** Last token read. Used only to redact. Never interpolated into a log line. */
  let held = '';

  function needles() {
    /** @type {string[]} */
    const list = [];
    if (held.length >= 8) list.push(held);
    const bearer = env[bearerName];
    if (typeof bearer === 'string' && bearer.length >= 8) list.push(bearer);
    return list;
  }

  /**
   * @param {unknown} value
   * @returns {unknown}
   */
  function scrub(value) {
    return scrubValue(value, needles());
  }

  function readDaemonToken() {
    let text;
    try {
      text = readFileSync(tokenFile, 'utf8');
    } catch {
      held = '';
      throw new Error('daemon token is unreadable');
    }
    const value = text.replace(/\r?\n$/, '');
    if (!value || /[\r\n]/.test(value)) {
      held = '';
      throw new Error('daemon token is unreadable');
    }
    held = value;
    return value;
  }

  return {
    scrub,
    /**
     * @param {string} method
     * @param {string} path Path only. A query string is refused.
     * @param {unknown} [body]
     * @param {Record<string, string>} [query] Allowlisted keys only. Refused on a route that has none.
     * @returns {Promise<{ status: number, json: unknown }>}
     */
    async request(method, path, body, query) {
      const route = matchDaemonRoute(method, path);
      if (!route) throw new DaemonRouteError(method, String(path));
      const search = queryString(route, method, path, query);
      assertBody(route, method, path, body);
      const token = readDaemonToken();
      const headers = {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      };
      /** @type {string | undefined} */
      let payload;
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      /** @type {Response} */
      let response;
      try {
        response = await fetch(`${origin}${path}${search}`, {
          method: route.method,
          headers,
          body: payload,
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new DaemonCallError();
      }
      // `manual` can surface a 3xx, or an opaque redirect with status 0.
      if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
        try { await response.body?.cancel(); } catch { /* the status is enough */ }
        throw new DaemonCallError();
      }
      let text = '';
      try {
        const cap = readCap(route);
        text = await readCappedText(response, cap.bytes, cap.overflow);
      } catch (err) {
        if (err instanceof DaemonCallError || err instanceof DaemonBodyError) throw err;
        throw new DaemonCallError();
      }
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      json = scrub(json);
      if (journal) journal.push({ method: route.method, path, status: response.status });
      return { status: response.status, json };
    },
  };
}

/**
 * @param {{ fixedQuery?: string, query?: readonly string[] }} route
 * @param {string} method
 * @param {string} path
 * @param {unknown} query
 * @returns {string}
 */
function queryString(route, method, path, query) {
  if (route.fixedQuery) {
    if (query !== undefined) throw new DaemonRouteError(method, path);
    return `?${route.fixedQuery}`;
  }
  if (query === undefined) return '';
  if (!isPlain(query)) throw new DaemonRouteError(method, path);
  const allowed = Array.isArray(route.query) ? route.query : [];
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(query)) {
    if (!allowedSet.has(key)) throw new DaemonRouteError(method, path);
  }
  const params = new URLSearchParams();
  for (const key of allowed) {
    if (query[key] === undefined) continue;
    if (!queryValueOk(route, key, query[key])) throw new DaemonRouteError(method, path);
    params.append(key, query[key]);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * @param {{ queryStatus?: RegExp }} route
 * @param {string} key
 * @param {unknown} value
 */
function queryValueOk(route, key, value) {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  if (key === 'project') return PROJECT_NAME.test(value);
  if (key === 'agent') return NAMED_AGENT.test(value);
  if (key === 'status') return (route.queryStatus ?? LIST_STATUS).test(value);
  if (key === 'limit') return LIST_LIMIT.test(value);
  return false;
}

/**
 * @param {{ body?: readonly string[] | string, bodyRequired?: readonly string[] }} route
 * @param {string} method
 * @param {string} path
 * @param {unknown} body
 */
function assertBody(route, method, path, body) {
  if (route.body == null) {
    if (body !== undefined) throw new DaemonRouteError(method, path);
    return;
  }
  if (route.body === 'stop-scope') {
    assertStopBody(method, path, body);
    return;
  }
  if (!isPlain(body) || !Array.isArray(route.body)) throw new DaemonRouteError(method, path);
  const allowed = new Set(route.body);
  const keys = Object.keys(body);
  if (Array.isArray(route.bodyRequired)) {
    // A subset. Every required key is present, and at least one key is sent.
    if (keys.length === 0) throw new DaemonRouteError(method, path);
    for (const key of keys) {
      if (!allowed.has(key)) throw new DaemonRouteError(method, path);
    }
    for (const key of route.bodyRequired) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) throw new DaemonRouteError(method, path);
    }
    return;
  }
  if (keys.length !== allowed.size) throw new DaemonRouteError(method, path);
  for (const key of keys) {
    if (!allowed.has(key)) throw new DaemonRouteError(method, path);
  }
  if (route.name === 'messages.send') assertDirectMessage(method, path, body);
  if (route.name === 'pipelines.run' || route.name === 'workflows.run') {
    assertRunInput(method, path, body);
  }
}

/**
 * The run body is exactly `{ input }`, and `input` is a JSON object of at
 * most `RUN_INPUT_MAX_BYTES`. An array, a string, or a larger object is refused.
 * @param {string} method
 * @param {string} path
 * @param {Record<string, unknown>} body
 */
const RUN_OVERRIDE = new Set([
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

function assertRunInput(method, path, body) {
  if (!isPlain(body.input)) throw new DaemonRouteError(method, path);
  for (const key of Object.keys(body.input)) {
    const lower = key.toLowerCase();
    if (RUN_OVERRIDE.has(key) || key.includes('override') || key.includes('Override') || lower.includes('fallback')) {
      throw new DaemonRouteError(method, path);
    }
  }
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(body.input));
  } catch {
    throw new DaemonRouteError(method, path);
  }
  if (size > RUN_INPUT_MAX_BYTES) throw new DaemonRouteError(method, path);
}

/**
 * @param {{ name?: string, method?: string, path?: string, maxBytes?: number }} route
 * @returns {{ bytes: number, overflow: Error }}
 */
function readCap(route) {
  if (route.name === 'tasks.list') {
    return { bytes: TASK_LIST_MAX_BYTES, overflow: new DaemonBodyError() };
  }
  if (typeof route.maxBytes === 'number') {
    return {
      bytes: route.maxBytes,
      overflow: new DaemonBodyError(automationTooLarge(route.method, route.path)),
    };
  }
  return { bytes: RESPONSE_MAX_BYTES, overflow: new DaemonCallError() };
}

/**
 * Exact direct-message body. `from_mission` and `from_agent` are the host's
 * constants. Any other value, including one supplied by the caller, is refused.
 * A work-return payload is refused: release 0.1.8 would wake the recipient.
 * @param {string} method
 * @param {string} path
 * @param {Record<string, unknown>} body
 */
function assertDirectMessage(method, path, body) {
  if (body.from_mission !== DIRECT_FROM_MISSION || body.from_agent !== DIRECT_FROM_AGENT) {
    throw new DaemonRouteError(method, path);
  }
  if (typeof body.to_agent !== 'string' || !NAMED_AGENT.test(body.to_agent)) {
    throw new DaemonRouteError(method, path);
  }
  if (typeof body.kind !== 'string' || !MESSAGE_KIND_NAMES.includes(body.kind)) {
    throw new DaemonRouteError(method, path);
  }
  if (typeof body.payload !== 'string' || body.payload.length < 1 || body.payload.length > MESSAGE_MAX_CHARS) {
    throw new DaemonRouteError(method, path);
  }
  if (isWorkReturnPayload(body.payload)) throw new DaemonRouteError(method, path);
}

/**
 * Exactly `{ agent }` or `{ project }`. Anything else, including both, is refused.
 * @param {string} method
 * @param {string} path
 * @param {unknown} body
 */
function assertStopBody(method, path, body) {
  if (!isPlain(body)) throw new DaemonRouteError(method, path);
  const keys = Object.keys(body);
  if (keys.length !== 1 || (keys[0] !== 'agent' && keys[0] !== 'project')) {
    throw new DaemonRouteError(method, path);
  }
  const value = body[keys[0]];
  if (keys[0] === 'agent' && !NAMED_AGENT.test(value)) throw new DaemonRouteError(method, path);
  if (keys[0] === 'project' && !PROJECT_NAME.test(value)) throw new DaemonRouteError(method, path);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Stops after one byte past the cap so a large daemon body is not buffered.
 * The overflowing chunk is not kept, and the bytes are not parsed.
 * @param {Response} response
 * @param {number} maxBytes
 * @param {Error} overflow Thrown when the body crosses `maxBytes`.
 * @returns {Promise<string>}
 */
async function readCappedText(response, maxBytes, overflow) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* the cap is the result */ }
        throw overflow;
      }
      chunks.push(step.value);
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* already closed */ }
    if (err instanceof DaemonCallError || err instanceof DaemonBodyError) throw err;
    throw new DaemonCallError();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * @param {unknown} value
 * @param {string[]} needles
 * @returns {unknown}
 */
export function scrubValue(value, needles) {
  if (typeof value === 'string') {
    let out = value;
    for (const needle of needles) {
      if (needle.length >= 8 && out.includes(needle)) out = out.split(needle).join('[redacted]');
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, needles));
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, needles);
    return out;
  }
  return value;
}
