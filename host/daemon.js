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
import { DaemonCallError, DaemonRouteError } from './errors.js';
import {
  EVENT_ID,
  LIST_LIMIT,
  LIST_STATUS,
  MISSION_ID,
  NAMED_AGENT,
  PROJECT_NAME,
  RESERVED_MISSION_IDS,
  TASK_STATUS,
} from './names.js';

/** Longest daemon body this client will parse. */
const RESPONSE_MAX_BYTES = 1024 * 1024;

const ID_SEGMENT = MISSION_ID.source.slice(1, -1);
const EVENT_SEGMENT = EVENT_ID.source.slice(1, -1);

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
    // The daemon filters on `status` only. Project, agent, and type stay in the host.
    query: Object.freeze(['status']),
    queryStatus: TASK_STATUS,
  }),
  Object.freeze({
    name: 'tasks.update',
    method: 'PUT',
    path: '/api/tasks/:id',
    // Move, edit, and comment. `done_comment` is the comment field this route stores.
    // There is no DELETE: `kanban:delete` is not a gesture of this host.
    body: Object.freeze([
      'title', 'description', 'agent_name', 'priority', 'deps', 'status', 'blocked_reason', 'done_comment',
    ]),
    bodyRequired: Object.freeze([]),
  }),
].map((route) => Object.freeze({ ...route, re: compileRoute(route.path) })));

/**
 * @param {string} path
 */
function compileRoute(path) {
  const body = path.split('/').map((segment) => {
    if (segment === ':id') return ID_SEGMENT;
    if (segment === ':eventId') return EVENT_SEGMENT;
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
  if (reservedMissionPath(path)) return null;
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
        text = await readCappedText(response);
      } catch (err) {
        if (err instanceof DaemonCallError) throw err;
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
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readCappedText(response) {
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
      if (size > RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new DaemonCallError();
      }
      chunks.push(step.value);
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* already closed */ }
    if (err instanceof DaemonCallError) throw err;
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
