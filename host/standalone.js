/**
 * Standalone host. It builds the plugin context and calls `apply()` from
 * `lib/` unchanged. Loopback only. The daemon is reached solely through the
 * closed client in `host/daemon.js`.
 */
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { BEARER_SECRET, PLUGIN_ID, WAIT_MAX_S } from '../lib/constants.js';
import { apply } from '../lib/index.js';
import { createDaemonClient, resolveDaemonOrigin } from './daemon.js';
import { createMissionFacade, createSpawnQuota, createTaskFacade } from './facades.js';
import { createResponse, createRouter } from './router.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const PUBLIC_BODY_MAX = 64 * 1024;
/** Bytes of an already-refused body that may be discarded before the socket is destroyed. */
const DRAIN_MAX_BYTES = 1024 * 1024;
const DRAIN_MAX_MS = 5_000;
/**
 * Defense in depth, outside `refuseEarly`. A slow header cannot outlive
 * `HEADERS_TIMEOUT_MS`. A request that stalls after the headers cannot outlive
 * `REQUEST_TIMEOUT_MS`. Those two stop once the request has been received.
 * They do not cut a response that is slow to produce.
 *
 * `SOCKET_TIMEOUT_MS` is inactivity on the socket (`server.timeout`). With no
 * `timeout` listener, Node destroys the socket when it elapses, in either
 * direction. `wait` writes nothing while it runs, for up to `WAIT_MAX_S`
 * seconds. In `waitForTurn` that countdown starts only after an initial
 * daemon read. A poll can still be in flight when the countdown ends, and a
 * final read always follows. Each of those three reads is capped at
 * `DAEMON_CALL_TIMEOUT_S` by `AbortSignal.timeout(20_000)` in
 * `host/daemon.js`. The idle limit is `WAIT_MAX_S` plus those three reads,
 * plus `SOCKET_TIMEOUT_MARGIN_MS`: 20 + 50 + 20 + 20 seconds, then 10 seconds
 * of slack, so a daemon that stays under its own cap returns JSON instead of
 * `ECONNRESET`. A slow read is still bounded. Incomplete requests are
 * checked every `CONNECTIONS_CHECK_MS`, which is what makes the header and
 * request deadlines fire on time.
 */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Seconds. Same budget as `AbortSignal.timeout(20_000)` in `host/daemon.js`. */
const DAEMON_CALL_TIMEOUT_S = 20;
/** Slack so the idle timer cannot fire on the same tick as that budget. */
const SOCKET_TIMEOUT_MARGIN_MS = 10_000;
/** Initial read, poll still in flight at the deadline, and the final read. */
const WAIT_DAEMON_READS = 3;
const SOCKET_TIMEOUT_MS = (WAIT_MAX_S + WAIT_DAEMON_READS * DAEMON_CALL_TIMEOUT_S) * 1000
  + SOCKET_TIMEOUT_MARGIN_MS;
const CONNECTIONS_CHECK_MS = 1_000;
/** Methods this host will route. Any other method is a 405 before the body is read. */
const SERVED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const kArmed = Symbol('earlyArmed');
const kBodyConsumed = Symbol('bodyConsumed');
const kOriginalEnd = Symbol('originalEnd');
/** `.all()` row counts kept when a test sets `recordReads`. Production records none. */
const READ_COUNT_KEEP = 64;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const SETTING_KEYS = [
  'public_url',
  'issuer',
  'resource',
  'identity_header',
  'expected_right',
  'email_allowlist',
];

/**
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {string} [options.daemonUrl]
 * @param {string} [options.tokenFile]
 * @param {string} [options.dbFile]
 * @param {string} [options.settingsFile]
 * @param {NodeJS.ProcessEnv} [options.env] When set, a missing daemon URL is an error.
 * @param {string} [options.migrationsDir]
 * @param {Array<{ method: string, path: string, status: number }>} [options.journal]
 * @param {Array<{ level: string, message: string }>} [options.logs]
 * @param {() => number} [options.now] Clock for the spawn quota. Tests inject it.
 * @param {boolean} [options.recordReads] When true, `ctx.sql` keeps the last 64 `.all()` row counts. Off in production.
 */
export async function startStandalone(options = {}) {
  const env = options.env ?? process.env;
  const trustProxy = env.TIMON_MCP_TRUST_PROXY === '1';
  const quota = createSpawnQuota(env, typeof options.now === 'function' ? options.now : Date.now);
  const origin = daemonOrigin(options, env);
  const port = listenPort(options, env);
  const tokenFile = options.tokenFile || env.TIMON_DAEMON_TOKEN_FILE || join(homedir(), '.timon', 'daemon-token');
  const dbFile = options.dbFile || env.TIMON_MCP_DB || join(homedir(), '.timon-mcp', 'state.db');
  const settingsFile = options.settingsFile ?? env.TIMON_MCP_SETTINGS ?? '';
  const migrationsDir = options.migrationsDir || join(ROOT, 'migrations');
  const logs = options.logs ?? [];
  const journal = options.journal ?? null;
  const publicPaths = loadPublicPaths(join(ROOT, 'package.json'));
  const prefix = `/api/plugins/${PLUGIN_ID}`;
  const db = openState(dbFile, migrationsDir);
  const client = createDaemonClient({
    origin,
    tokenFile,
    env,
    bearerName: BEARER_SECRET,
    journal,
  });
  const sql = createSql(db, options.recordReads === true);
  const disposers = [];
  /** @type {ReturnType<typeof createRouter>[]} */
  const routers = [];
  const buckets = new Map();
  /** Body bytes currently held in memory. The oversized path must leave this at 0. */
  const retained = { bytes: 0 };
  let closed = false;

  const ctx = {
    id: PLUGIN_ID,
    user() { return undefined; },
    router() {
      const router = createRouter();
      routers.push(router);
      return router;
    },
    missions: createMissionFacade({ client, sql, quota }),
    kanban: createTaskFacade({ client, sql, quota }),
    events: {
      /**
       * @param {unknown} kind
       * @param {unknown} handler
       */
      on(kind, handler) {
        if (typeof kind !== 'string' || typeof handler !== 'function') {
          throw new TypeError('events.on requires a kind and a handler');
        }
        return () => {};
      },
    },
    effect(fn) {
      const returned = typeof fn === 'function' ? fn() : undefined;
      if (typeof returned === 'function') disposers.push(returned);
    },
    secrets: {
      /**
       * @param {unknown} name
       */
      async get(name) {
        if (name !== BEARER_SECRET) return undefined;
        const value = env[BEARER_SECRET];
        return typeof value === 'string' && value ? value : undefined;
      },
    },
    settings: {
      /**
       * @param {unknown} key
       */
      get(key) {
        if (typeof key !== 'string') return undefined;
        const values = readSettings(settingsFile);
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
      },
    },
    sql,
    log: {
      info(...args) { pushLog(logs, 'info', args, client.scrub); },
      warn(...args) { pushLog(logs, 'warn', args, client.scrub); },
      error(...args) { pushLog(logs, 'error', args, client.scrub); },
    },
  };

  const server = createServer((incoming, raw) => {
    installResponseGuard(raw);
    handleHttp({
      incoming,
      raw,
      prefix,
      publicPaths,
      routers,
      buckets,
      scrub: client.scrub,
      trustProxy,
      retained,
    }).catch(() => {
      if (raw.headersSent || raw.writableEnded) return;
      try {
        refuseEarly(raw, incoming, client.scrub, 500, { error: 'internal_error' });
      } catch { /* the socket is already gone */ }
    });
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.timeout = SOCKET_TIMEOUT_MS;
  server.connectionsCheckingInterval = CONNECTIONS_CHECK_MS;
  server.on('clientError', (err, socket) => {
    // A listener replaces Node's default reply. Header and request timeouts
    // arrive here as ERR_HTTP_REQUEST_TIMEOUT before any handler runs, so the
    // 408 has to be written from this hook. Destroying at once drops those bytes.
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const timeout = err && err.code === 'ERR_HTTP_REQUEST_TIMEOUT';
    const status = timeout ? 408 : 400;
    const reason = timeout ? 'Request Timeout' : 'Bad Request';
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });

  try {
    apply(ctx);
  } catch {
    try { db.close(); } catch { /* nothing listened */ }
    throw new Error('plugin failed to mount');
  }

  /**
   * @returns {Promise<void>}
   */
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    for (const dispose of disposers.splice(0)) {
      try { dispose(); } catch { /* already stopped */ }
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }).then(() => {
      try { db.close(); } catch { /* already closed */ }
    });
  }

  try {
    await listen(server, port);
  } catch {
    await close();
    throw new Error('http server failed to listen');
  }
  server.on('error', () => {
    pushLog(logs, 'error', ['http server error'], client.scrub);
  });

  const bound = server.address();
  const actualPort = bound && typeof bound === 'object' ? bound.port : port;
  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    address: '127.0.0.1',
    close,
    logs,
    ctx,
    journal,
    bodyBytesRetained() { return retained.bytes; },
    socketTimeoutMs: server.timeout,
  };
}

/**
 * @param {object} options
 * @param {NodeJS.ProcessEnv} env
 */
function daemonOrigin(options, env) {
  const raw = options.daemonUrl || env.TIMON_DAEMON_URL;
  if (!raw) {
    if (options.env) throw new Error('daemon URL is required');
    return resolveDaemonOrigin('http://127.0.0.1:3000');
  }
  return resolveDaemonOrigin(raw);
}

/**
 * @param {object} options
 * @param {NodeJS.ProcessEnv} env
 */
function listenPort(options, env) {
  if (options.port !== undefined && options.port !== null) return checkedPort(options.port);
  const raw = env.TIMON_MCP_PORT;
  if (raw === undefined || raw === '') return 3098;
  if (!/^\d+$/.test(String(raw))) throw new Error('TIMON_MCP_PORT is invalid');
  return checkedPort(Number(raw));
}

/**
 * @param {unknown} value
 */
function checkedPort(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('TIMON_MCP_PORT is invalid');
  return value;
}

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new Error('http server failed to listen'));
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * @param {string} pkgPath
 */
function loadPublicPaths(pkgPath) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    throw new Error('public paths are missing');
  }
  const list = pkg && pkg.timon && pkg.timon.routes && pkg.timon.routes.publicPaths;
  if (!Array.isArray(list) || list.length === 0) throw new Error('public paths are missing');
  return list.map((item) => {
    if (!item || typeof item.method !== 'string' || typeof item.path !== 'string' || !item.path.startsWith('/')) {
      throw new Error('public paths are missing');
    }
    return { method: item.method.toUpperCase(), path: item.path.length > 1 ? item.path.replace(/\/+$/, '') : item.path };
  });
}

/**
 * @param {string} file
 * @param {string} migrationsDir
 */
function openState(file, migrationsDir) {
  let db;
  try {
    mkdirSync(dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 3000');
    applyMigrations(db, migrationsDir);
    db.exec(`
      CREATE TABLE IF NOT EXISTS host_missions (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_tasks (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // The plugin migrations are shared with the daemon, which has neither
    // host table. The list indexes are a host migration and run after the
    // tables exist.
    applyMigrations(db, HOST_MIGRATIONS);
  } catch (err) {
    try { db?.close(); } catch { /* the open is what failed */ }
    const code = err && typeof err === 'object' && typeof err.code === 'string' && /^[A-Z0-9_]+$/.test(err.code)
      ? err.code
      : '';
    throw new Error(code ? `state database could not be opened (${code})` : 'state database could not be opened');
  }
  return db;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} migrationsDir
 */
function applyMigrations(db, migrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const names = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  const seen = db.prepare('SELECT name FROM schema_migrations WHERE name = ?');
  const mark = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const name of names) {
    if (seen.get(name)) continue;
    const script = readFileSync(join(migrationsDir, name), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(script);
      mark.run(name, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* the original error is the one that matters */ }
      throw err;
    }
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {boolean} [recordReads] Test-only. Production leaves this false, so `.all()` stores nothing.
 */
function createSql(db, recordReads = false) {
  /** Last `.all()` row counts. Empty for the life of the process unless a test opted in. */
  const readCounts = [];
  return {
    readCounts,
    /**
     * @param {string} statement
     */
    prepare(statement) {
      const stmt = db.prepare(statement);
      return {
        get(...params) {
          const row = stmt.get(...params);
          return row === undefined ? undefined : row;
        },
        all(...params) {
          const rows = stmt.all(...params);
          if (recordReads) {
            readCounts.push(rows.length);
            if (readCounts.length > READ_COUNT_KEEP) {
              readCounts.splice(0, readCounts.length - READ_COUNT_KEEP);
            }
          }
          return rows;
        },
        run(...params) {
          const result = stmt.run(...params);
          return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
        },
      };
    },
    /**
     * @param {() => unknown} fn
     */
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* the original error is the one that matters */ }
        throw error;
      }
    },
  };
}

/**
 * @param {string} file
 * @returns {Record<string, string>}
 */
function readSettings(file) {
  if (!file) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of SETTING_KEYS) {
    if (typeof parsed[key] === 'string') out[key] = parsed[key];
  }
  return out;
}

/**
 * @param {Array<{ level: string, message: string }>} logs
 * @param {string} level
 * @param {unknown[]} args
 * @param {(value: unknown) => unknown} scrub
 */
function pushLog(logs, level, args, scrub) {
  const text = args.map((part) => (typeof part === 'string' ? part : safeJson(part))).join(' ');
  const clean = scrub(text);
  logs.push({ level, message: typeof clean === 'string' ? clean : 'log' });
  if (logs.length > 200) logs.splice(0, logs.length - 200);
}

/**
 * @param {unknown} value
 */
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return 'log';
  }
}

/**
 * @param {object} input
 * @param {import('node:http').IncomingMessage} input.incoming
 * @param {import('node:http').ServerResponse} input.raw
 * @param {string} input.prefix
 * @param {{ method: string, path: string }[]} input.publicPaths
 * @param {Array<{ handle: Function }>} input.routers
 * @param {Map<string, { start: number, count: number }>} input.buckets
 * @param {(value: unknown) => unknown} input.scrub
 * @param {boolean} input.trustProxy
 * @param {{ bytes: number }} input.retained
 */
async function handleHttp(input) {
  const { incoming, raw, prefix, publicPaths, routers, buckets, scrub, trustProxy, retained } = input;
  let url;
  try {
    url = new URL(incoming.url || '/', 'http://127.0.0.1');
  } catch {
    refuseEarly(raw, incoming, scrub, 400, { error: 'bad_request' });
    return;
  }
  const rest = splitPrefix(url.pathname, prefix);
  if (rest === null) {
    refuseEarly(raw, incoming, scrub, 404, { error: 'not_found' });
    return;
  }
  const method = (incoming.method || 'GET').toUpperCase();
  if (!SERVED_METHODS.has(method)) {
    refuseEarly(raw, incoming, scrub, 405, { error: 'method_not_allowed' }, {
      allow: 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT',
    });
    return;
  }
  if (!isPublic(method, rest, publicPaths)) {
    refuseEarly(raw, incoming, scrub, 401, { error: 'unauthorized' });
    return;
  }
  if (crossSite(incoming)) {
    refuseEarly(raw, incoming, scrub, 403, { error: 'cross-site request refused' });
    return;
  }
  const declared = declaredLength(incoming);
  if (declared !== null && declared > PUBLIC_BODY_MAX) {
    refuseOversized(raw, incoming, scrub);
    return;
  }
  const rate = takeRate(buckets, clientAddress(incoming, trustProxy), Date.now());
  if (!rate.ok) {
    refuseEarly(raw, incoming, scrub, 429, {
      error: 'too many requests, try again later',
      code: 'too_many_attempts',
    }, { 'retry-after': String(rate.retry) });
    return;
  }

  /** @type {unknown} */
  let body;
  /** @type {{ status: number, body: Record<string, unknown> } | null} */
  let bodyError = null;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    let rawBody;
    try {
      rawBody = await readLimited(incoming, PUBLIC_BODY_MAX, retained);
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'payload_too_large') {
        refuseOversized(raw, incoming, scrub);
        return;
      }
      refuseEarly(raw, incoming, scrub, 400, { error: 'bad_request' });
      return;
    }
    markBodyConsumed(incoming);
    const type = headerValue(incoming, 'content-type').toLowerCase();
    if (type.includes('application/json')) {
      if (rawBody.length === 0) body = {};
      else {
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          bodyError = { status: 400, body: { error: 'invalid_json', message: 'Request body is not valid JSON' } };
        }
      }
    } else if (type.includes('application/x-www-form-urlencoded') || type === '') {
      /** @type {Record<string, string>} */
      const fields = {};
      for (const [key, value] of new URLSearchParams(rawBody.toString('utf8'))) fields[key] = value;
      body = fields;
    }
  }
  if (bodyError) {
    sendJson(raw, bodyError.status, bodyError.body, scrub);
    return;
  }

  /** @type {Record<string, string>} */
  const query = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  const request = {
    method,
    headers: incoming.headers,
    url: `${rest}${url.search}`,
    originalUrl: incoming.url || '/',
    baseUrl: prefix,
    path: rest,
    query,
    params: {},
    body,
    socket: incoming.socket,
    protocol: 'http',
    /**
     * @param {string} name
     */
    get(name) {
      const value = incoming.headers[String(name).toLowerCase()];
      if (Array.isArray(value)) return value.join(', ');
      return value;
    },
  };
  const response = createResponse(raw, scrub);
  let pending = null;
  for (const router of routers) {
    pending = await router.handle(request, response, pending);
    if (response.headersSent) return;
  }
  if (response.headersSent) return;
  sendJson(raw, pending ? 500 : 404, { error: pending ? 'internal_error' : 'not_found' }, scrub);
}

/**
 * @param {string} pathname
 * @param {string} prefix
 * @returns {string | null}
 */
function splitPrefix(pathname, prefix) {
  if (pathname === prefix || pathname === `${prefix}/`) return '/';
  const head = `${prefix}/`;
  if (!pathname.startsWith(head)) return null;
  return pathname.slice(prefix.length) || '/';
}

/**
 * @param {string} method
 * @param {string} rest
 * @param {{ method: string, path: string }[]} publicPaths
 */
function isPublic(method, rest, publicPaths) {
  const path = rest.length > 1 ? rest.replace(/\/+$/, '') : rest;
  return publicPaths.some((item) => item.method === method && item.path === path);
}

/**
 * Same rule as the daemon: a safe method is never cross-site, `Sec-Fetch-Site`
 * wins when the browser sends it, and `Origin: null` is refused.
 * @param {import('node:http').IncomingMessage} req
 */
function crossSite(req) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const site = headerValue(req, 'sec-fetch-site');
  if (site) return site === 'cross-site';
  const origin = headerValue(req, 'origin');
  if (!origin) return false;
  if (origin === 'null') return true;
  const forwarded = headerValue(req, 'x-forwarded-host');
  const host = forwarded ? forwarded.split(',')[0].trim() : headerValue(req, 'host');
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 */
function headerValue(req, name) {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : '';
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {number | null}
 */
function declaredLength(req) {
  const text = headerValue(req, 'content-length');
  if (!text || !/^\d+$/.test(text)) return null;
  return Number(text);
}

/**
 * Socket peer by default. `X-Real-IP` counts only when the operator set
 * `TIMON_MCP_TRUST_PROXY=1` and the peer is loopback, so a client cannot
 * pick its own rate bucket. `X-Forwarded-For` is never read.
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 */
export function clientAddress(req, trustProxy) {
  const peer = req.socket && typeof req.socket.remoteAddress === 'string' && req.socket.remoteAddress
    ? req.socket.remoteAddress
    : 'unknown';
  if (!trustProxy || !isLoopback(peer)) return peer;
  const real = headerValue(req, 'x-real-ip').split(',')[0].trim();
  if (!real) return peer;
  return real;
}

/**
 * `127.0.0.0/8`, `::1`, and the IPv4-mapped forms Node reports for them.
 * @param {string} address
 */
function isLoopback(address) {
  if (address === '::1') return true;
  const mapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (mapped === '::1') return true;
  const parts = mapped.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * @param {Map<string, { start: number, count: number }>} buckets
 * @param {string} ip
 * @param {number} now
 * @returns {{ ok: true } | { ok: false, retry: number }}
 */
function takeRate(buckets, ip, now) {
  if (buckets.size > 1000) {
    for (const [key, bucket] of buckets) {
      if (now - bucket.start >= RATE_WINDOW_MS) buckets.delete(key);
    }
  }
  const key = `${PLUGIN_ID}\n${ip}`;
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    buckets.set(key, { start: now, count: 1 });
    return { ok: true };
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX) {
    return { ok: false, retry: Math.max(1, Math.ceil((bucket.start + RATE_WINDOW_MS - now) / 1000)) };
  }
  return { ok: true };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} max
 * @param {{ bytes: number }} retained
 * @returns {Promise<Buffer>}
 */
function readLimited(req, max, retained) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let failed = false;
    const onData = (chunk) => {
      if (failed) return;
      if (size + chunk.length > max) {
        failed = true;
        chunks.length = 0;
        retained.bytes -= size;
        size = 0;
        cleanup();
        req.pause();
        reject(Object.assign(new Error('request body too large'), { code: 'payload_too_large' }));
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
      retained.bytes += chunk.length;
    };
    const onEnd = () => {
      if (failed) return;
      cleanup();
      const body = Buffer.concat(chunks);
      chunks.length = 0;
      retained.bytes -= size;
      size = 0;
      resolve(body);
    };
    const onError = (error) => {
      if (failed) return;
      failed = true;
      chunks.length = 0;
      retained.bytes -= size;
      size = 0;
      cleanup();
      reject(error);
    };
    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Single exit for every response sent before the body has been read in full.
 * `Connection: close`, discard at most 1 MiB over at most 5 seconds, then
 * close the socket. A finished body uses `destroySoon()`; a body past the
 * budget or the deadline is destroyed at once. 401, 403, 404, 405, 413, 429
 * and any later status all come through here. The response guard calls the
 * same close if some other write happens while the body is still unread, so
 * a new branch cannot skip it.
 * @param {import('node:http').ServerResponse} raw
 * @param {import('node:http').IncomingMessage} incoming
 * @param {(value: unknown) => unknown} scrub
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function refuseEarly(raw, incoming, scrub, status, body, headers) {
  if (requestCarriesBody(incoming)) armEarlyClose(raw, incoming);
  writeJson(raw, status, body, scrub, {
    ...(headers || {}),
    connection: 'close',
  });
}

/**
 * Answer 413, then drop the unread body without keeping it. The socket stays
 * up long enough for the JSON to leave. Past 1 MiB or 5 seconds it is destroyed.
 * @param {import('node:http').ServerResponse} raw
 * @param {import('node:http').IncomingMessage} incoming
 * @param {(value: unknown) => unknown} scrub
 */
function refuseOversized(raw, incoming, scrub) {
  refuseEarly(raw, incoming, scrub, 413, {
    error: 'request body too large',
    code: 'payload_too_large',
  });
}

/**
 * Drop the unread body. `flushed` runs once the response has been written.
 * Bytes are counted and discarded, never stored. Past 1 MiB or 5 seconds
 * the socket is destroyed at once. When the body ends inside that budget,
 * `req.socket.destroySoon()` closes it after the response has left.
 * `IncomingMessage._destroy` only destroys the socket when the message is
 * interrupted, so a finished body must close the socket itself. The
 * deadline cannot run before `flushed`, so the status line has left.
 * Nothing is retained.
 * @param {import('node:http').IncomingMessage} req
 */
function discardIncoming(req) {
  let seen = 0;
  let over = false;
  let ended = false;
  let ready = false;
  let settled = false;
  const timer = setTimeout(() => {
    over = true;
    settle();
  }, DRAIN_MAX_MS);
  timer.unref();
  const swallow = () => {};
  const onData = (chunk) => {
    seen += chunk.length;
    if (seen > DRAIN_MAX_BYTES) {
      over = true;
      req.pause();
      settle();
    }
  };
  const onEnd = () => {
    ended = true;
    settle();
  };
  const onClose = () => {
    ended = true;
    settle();
  };
  req.on('error', () => {
    ended = true;
    settle();
  });
  if (req.readableLength > DRAIN_MAX_BYTES) {
    over = true;
  } else if (req.readableEnded) {
    ended = true;
  } else {
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('close', onClose);
    req.resume();
  }

  /**
   * @returns {void}
   */
  function settle() {
    if (settled || !ready || (!ended && !over)) return;
    settled = true;
    clearTimeout(timer);
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('close', onClose);
    if (!req.socket || req.socket.destroyed) return;
    req.socket.on('error', swallow);
    if (ended && !over) req.socket.destroySoon();
    else req.socket.destroy();
  }

  return {
    flushed() {
      ready = true;
      settle();
    },
  };
}

/**
 * Writes JSON. If the body is still unread, this is `refuseEarly`: no caller
 * can answer early by using `sendJson` directly.
 * @param {import('node:http').ServerResponse} raw
 * @param {number} status
 * @param {unknown} body
 * @param {(value: unknown) => unknown} scrub
 * @param {Record<string, string>} [headers]
 * @param {() => void} [done] Runs after the response is flushed.
 */
function sendJson(raw, status, body, scrub, headers, done) {
  if (!raw[kArmed] && requestCarriesBody(raw.req)) {
    refuseEarly(raw, raw.req, scrub, status, body, headers);
    return;
  }
  writeJson(raw, status, body, scrub, headers, done);
}

/**
 * @param {import('node:http').ServerResponse} raw
 * @param {number} status
 * @param {unknown} body
 * @param {(value: unknown) => unknown} scrub
 * @param {Record<string, string>} [headers]
 * @param {() => void} [done]
 */
function writeJson(raw, status, body, scrub, headers, done) {
  if (raw.writableEnded) {
    if (typeof done === 'function') done();
    return;
  }
  let payload = '{"error":"internal_error"}';
  try {
    payload = JSON.stringify(scrub(body));
  } catch {
    payload = '{"error":"internal_error"}';
  }
  raw.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
    'content-length': Buffer.byteLength(payload),
  });
  raw.end(payload, () => {
    if (typeof done === 'function') done();
  });
}

/**
 * The body has been read in full. Later responses may keep the connection.
 * @param {import('node:http').IncomingMessage} req
 */
function markBodyConsumed(incoming) {
  incoming[kBodyConsumed] = true;
}

/**
 * A positive length or chunked framing means bytes may still be on the wire.
 * @param {import('node:http').IncomingMessage | undefined} req
 */
function requestCarriesBody(req) {
  if (!req || req[kBodyConsumed]) return false;
  const length = declaredLength(req);
  if (length !== null && length > 0) return true;
  return headerValue(req, 'transfer-encoding').toLowerCase().includes('chunked');
}

/**
 * Any write before the body is consumed takes the `refuseEarly` close:
 * `Connection: close`, bounded discard, then the socket is closed.
 * @param {import('node:http').ServerResponse} raw
 */
function installResponseGuard(raw) {
  const originalWriteHead = raw.writeHead;
  const originalEnd = raw.end;
  raw[kOriginalEnd] = originalEnd;
  raw.writeHead = function writeHead(...args) {
    if (!raw[kArmed] && requestCarriesBody(raw.req)) armEarlyClose(raw, raw.req);
    const result = originalWriteHead.apply(this, args);
    if (raw[kArmed]) keepSocketUntilDrain(this);
    return result;
  };
  const guardEnd = function end(...args) {
    if (!raw[kArmed] && requestCarriesBody(raw.req)) armEarlyClose(raw, raw.req);
    if (raw.end !== guardEnd) return raw.end(...args);
    return originalEnd.apply(raw, args);
  };
  raw.end = guardEnd;
}

/**
 * @param {import('node:http').ServerResponse} raw
 * @param {import('node:http').IncomingMessage} incoming
 */
function armEarlyClose(raw, incoming) {
  if (raw[kArmed]) return;
  raw[kArmed] = true;
  // `writeHead` before `end` would send the status line without this header.
  if (!raw.headersSent) raw.setHeader('connection', 'close');
  const originalEnd = raw[kOriginalEnd] || raw.end;
  const drop = discardIncoming(incoming);
  raw.end = function end(chunk, encoding, cb) {
    let data = chunk;
    let enc = encoding;
    let callback = cb;
    if (typeof data === 'function') {
      callback = data;
      data = undefined;
      enc = undefined;
    } else if (typeof enc === 'function') {
      callback = enc;
      enc = undefined;
    }
    keepSocketUntilDrain(this);
    if (!this.headersSent && !this.getHeader('connection')) this.setHeader('connection', 'close');
    return originalEnd.call(this, data, enc, () => {
      drop.flushed();
      if (typeof callback === 'function') callback();
    });
  };
}

/**
 * Node treats `Connection: close` as the last message and ends the socket
 * when the response finishes (`_last` / `shouldKeepAlive`, Node 22.23.4).
 * The client can then see ECONNRESET instead of the JSON. Keep the socket
 * up until `discardIncoming` destroys it.
 * @param {import('node:http').ServerResponse} raw
 */
function keepSocketUntilDrain(raw) {
  raw.shouldKeepAlive = true;
  raw._last = false;
  if (raw.req) raw.req.shouldKeepAlive = true;
}
