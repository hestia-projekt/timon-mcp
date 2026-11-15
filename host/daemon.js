/**
 * Closed HTTP client for the local daemon.
 *
 * The daemon token is a super-administrator credential. This module is the
 * only place that may open a socket to the daemon, and only for the five
 * routes below. Any other method or path throws before `fetch`.
 *
 * The token is read from disk on every call and is never written into the
 * journal, an error message, or a returned document.
 */
import { readFileSync } from 'node:fs';
import { DaemonCallError, DaemonRouteError } from './errors.js';

/** Longest daemon body this client will parse. */
const RESPONSE_MAX_BYTES = 1024 * 1024;

/**
 * Couples the host is allowed to call. `:id` is one path segment.
 * `GET /api/missions` and `GET /api/tasks` are absent on purpose: those
 * listings would return every row on the install.
 */
export const DAEMON_ROUTES = Object.freeze([
  Object.freeze({ name: 'missions.spawn', method: 'POST', path: '/api/missions' }),
  Object.freeze({ name: 'missions.get', method: 'GET', path: '/api/missions/:id' }),
  Object.freeze({ name: 'missions.send', method: 'POST', path: '/api/agents/:id/send' }),
  Object.freeze({ name: 'tasks.add', method: 'POST', path: '/api/tasks' }),
  Object.freeze({ name: 'tasks.get', method: 'GET', path: '/api/tasks/:id' }),
].map((route) => Object.freeze({ ...route, re: compileRoute(route.path) })));

/**
 * @param {string} path
 */
function compileRoute(path) {
  const body = path.split('/').map((segment) => {
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
  if (!path.startsWith('/') || path.includes('?') || path.includes('\\') || path.includes('..')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded !== path) return null;
  const upper = method.toUpperCase();
  return DAEMON_ROUTES.find((route) => route.method === upper && route.re.test(path)) ?? null;
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
     * @returns {Promise<{ status: number, json: unknown }>}
     */
    async request(method, path, body) {
      const route = matchDaemonRoute(method, path);
      if (!route) throw new DaemonRouteError(method, String(path));
      const token = readDaemonToken();
      const query = route.name === 'missions.get' ? '?view=status' : '';
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
        response = await fetch(`${origin}${path}${query}`, {
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
