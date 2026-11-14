/**
 * In-memory PluginContext for contract tests. There is no published
 * `@timon-ai/sdk` test double. Later steps extend the facades on `state`
 * or replace a method on `ctx`.
 *
 * The HTTP server speaks `node:http`. Routes registered with `ctx.router()`
 * are mounted at `/api/plugins/<id>/`, which is where the daemon mounts them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createResponse, createRouter } from './mini-router.js';

/**
 * Store entered for the duration of an HTTP request. A façade call made from
 * the handler records this store. A call made from the plugin's job pump,
 * which was armed outside the request, records `null`.
 */
export const requestContext = new AsyncLocalStorage();

const BODY_LIMIT = 1024 * 1024;

/** @typedef {'invalid' | 'not_found' | 'forbidden' | 'not_running' | 'turn_in_progress' | 'backend_exhausted' | 'override_denied' | 'failed'} MissionCode */

export class PluginMissionError extends Error {
  /**
   * @param {MissionCode} code
   * @param {string} [message]
   */
  constructor(code, message = code) {
    super(message);
    this.name = 'PluginMissionError';
    this.code = code;
  }
}

export class PluginPolicyError extends Error {
  /**
   * @param {string} pluginId
   * @param {string} rule
   * @param {string} message
   */
  constructor(pluginId, rule, message) {
    super(`plugin \`${pluginId}\` refused (${rule}): ${message}`);
    this.name = 'PluginPolicyError';
    this.pluginId = pluginId;
    this.rule = rule;
  }
}

export class PluginTaskError extends Error {
  /**
   * @param {'invalid' | 'not_found' | 'conflict' | 'forbidden'} code
   * @param {string} message
   * @param {string} [reason]
   */
  constructor(code, message, reason) {
    super(message);
    this.name = 'PluginTaskError';
    this.code = code;
    this.reason = reason;
  }
}

export class PluginPermissionError extends Error {
  /**
   * @param {string} pluginId
   * @param {string} permission
   */
  constructor(pluginId, permission) {
    super(`plugin \`${pluginId}\`: permission \`${permission}\` is missing from its manifest`);
    this.name = 'PluginPermissionError';
    this.pluginId = pluginId;
    this.permission = permission;
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.id]
 * @param {object} [options.user]
 * @param {Record<string, string>} [options.secrets]
 * @param {Record<string, unknown>} [options.settings]
 * @returns {Promise<{ ctx: object, baseUrl: string, state: object, close: () => Promise<void> }>}
 */
export async function createFakeCtx(options = {}) {
  const id = options.id ?? 'timon-mcp';
  const prefix = `/api/plugins/${encodeURIComponent(id)}`;
  const state = createState(options);
  const routers = [];
  const disposers = [];
  const storageDir = mkdtempSync(join(tmpdir(), 'timon-mcp-'));

  const server = createServer((incoming, raw) => {
    requestContext.run({ scope: 'request' }, async () => {
    const response = createResponse(raw);
    try {
      const mounted = mountRequest(incoming, prefix);
      if (!mounted) {
        response.status(404).json({
          error: 'not_found',
          message: `No route for ${incoming.method} ${pathnameOf(incoming.url)}`,
        });
        return;
      }
      const bodyError = await readJsonBody(incoming, mounted.request);
      let pending = bodyError;
      for (const router of routers) {
        pending = await router.handle(mounted.request, response, pending);
        if (response.headersSent) return;
      }
      if (response.headersSent) return;
      if (pending) {
        // Body-parser failures are raised by this double (`invalid_json`,
        // `body_too_large`). They are not a behavior of the plugin.
        const described = httpErrorOf(pending);
        if (described) {
          response.status(described.status).json({
            error: described.error,
            message: described.message,
          });
          return;
        }
        response.status(500).json({ error: 'internal_error' });
        return;
      }
      response.status(404).json({
        error: 'not_found',
        message: `No route for ${mounted.request.method} ${mounted.request.path}`,
      });
    } catch {
      if (!response.headersSent) response.status(500).json({ error: 'internal_error' });
    }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('fake ctx failed to bind a local port');
  }

  const logs = [];
  const sql = createSql();
  const ctx = {
    id,
    user: () => options.user,
    router() {
      const router = createRouter();
      routers.push(router);
      return router;
    },
    missions: traceFacade(state, 'missions', createMissions(state)),
    kanban: traceFacade(state, 'kanban', createKanban(state)),
    events: {
      on(kind, handler) {
        if (typeof kind !== 'string' || typeof handler !== 'function') {
          throw new TypeError('events.on requires a kind and a handler');
        }
        const entry = { kind, handler };
        state.listeners.push(entry);
        return () => {
          const index = state.listeners.indexOf(entry);
          if (index >= 0) state.listeners.splice(index, 1);
        };
      },
    },
    effect(fn) {
      const returned = typeof fn === 'function' ? fn() : undefined;
      if (typeof returned === 'function') disposers.push(returned);
    },
    secrets: {
      async get(name) {
        if (typeof name !== 'string' || !name) return undefined;
        return state.secrets.get(name);
      },
    },
    settings: {
      get(key) {
        return state.settings[key];
      },
    },
    storage: {
      dir: storageDir,
      kv: {
        async get(key) { return state.kv.get(key); },
        async set(key, value) { state.kv.set(key, value); },
        async del(key) { state.kv.delete(key); },
        async list(prefixKey) {
          const keys = [...state.kv.keys()];
          return keys
            .filter((key) => prefixKey == null || String(key).startsWith(prefixKey))
            .map((key) => ({ key }));
        },
      },
    },
    sql: sql.facade,
    log: {
      info(...args) { record(logs, 'info', args); },
      warn(...args) { record(logs, 'warn', args); },
      error(...args) { record(logs, 'error', args); },
      debug(...args) { record(logs, 'debug', args); },
    },
  };
  state.logs = logs;

  return {
    ctx,
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close() {
      for (const dispose of disposers.splice(0)) {
        try { dispose(); } catch { /* the test still closes the server */ }
      }
      return new Promise((resolve, reject) => {
        server.close((error) => {
          try { sql.close(); } catch { /* the test still reports the close error */ }
          rmSync(storageDir, { recursive: true, force: true });
          if (error) reject(error);
          else resolve();
        });
        // Drop keep-alive sockets so close() does not wait on the test client.
        server.closeIdleConnections();
        server.closeAllConnections();
      });
    },
  };
}

/**
 * @param {object} options
 */
function createState(options) {
  return {
    missions: new Map(),
    tasks: new Map(),
    secrets: new Map(Object.entries(options.secrets ?? {})),
    settings: { ...(options.settings ?? {}) },
    kv: new Map(),
    calls: [],
    listeners: [],
    emit(kind, payload) {
      for (const entry of [...this.listeners]) {
        if (entry.kind === kind) entry.handler(payload);
      }
    },
  };
}

/**
 * Records the AsyncLocalStorage store active at each façade call.
 * @param {object} state
 * @param {string} facade
 * @param {object} target
 */
function traceFacade(state, facade, target) {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(obj, prop, receiver);
      const value = Reflect.get(obj, prop, receiver);
      if (value && typeof value === 'object') return traceFacade(state, facade, value);
      if (typeof value !== 'function') return value;
      return function traced(...args) {
        state.calls.push({
          facade,
          method: String(prop),
          store: requestContext.getStore() ?? null,
          args,
        });
        return value.apply(obj, args);
      };
    },
  });
}

function createMissions(state) {
  return {
    async spawn(input) {
      if (!input || typeof input.agent !== 'string' || !input.agent) {
        throw new PluginMissionError('invalid', 'agent is required');
      }
      if (typeof input.mission !== 'string' || !input.mission) {
        throw new PluginMissionError('invalid', 'mission is required');
      }
      const missionId = randomUUID();
      state.missions.set(missionId, {
        id: missionId,
        agent_name: input.agent,
        mission: input.mission,
        status: 'running',
        title: input.title ?? null,
        summary: null,
        started_at: Date.now(),
        ended_at: null,
        messages: [],
      });
      return missionId;
    },
    async send(missionId, text) {
      const mission = requireMission(state, missionId);
      if (typeof text !== 'string' || !text) {
        throw new PluginMissionError('invalid', 'text is required');
      }
      mission.messages.push({ text });
      return { resumed: false };
    },
    async get(missionId) {
      return state.missions.get(missionId);
    },
    async list(opts = {}) {
      let rows = [...state.missions.values()];
      if (opts.status) rows = rows.filter((row) => row.status === opts.status);
      if (Array.isArray(opts.agents)) {
        const agents = new Set(opts.agents);
        rows = rows.filter((row) => agents.has(row.agent_name));
      }
      const limit = opts.limit ?? 50;
      return rows.slice(0, limit);
    },
    async kill(missionId) {
      const mission = requireMission(state, missionId);
      mission.status = 'terminated';
      return { outcome: 'killed' };
    },
    async summarize(missionId) {
      requireMission(state, missionId);
      return { summary: '' };
    },
    async search() {
      return { hits: [] };
    },
    async fork(missionId, input) {
      const mission = requireMission(state, missionId);
      if (!input || typeof input.to !== 'string' || !input.to) {
        throw new PluginMissionError('invalid', '`to` (target agent) is required');
      }
      const child = randomUUID();
      state.missions.set(child, {
        id: child,
        agent_name: input.to,
        mission: typeof input.message === 'string' ? input.message : mission.mission,
        status: 'running',
        title: null,
        messages: [],
      });
      return { missionId: child, cached: false };
    },
    async stopScope() {
      return {};
    },
    async rename(missionId, title) {
      const mission = requireMission(state, missionId);
      mission.title = title;
      return { title };
    },
  };
}

function requireMission(state, missionId) {
  if (typeof missionId !== 'string' || !missionId) {
    throw new PluginMissionError('invalid', 'a mission id is required');
  }
  const mission = state.missions.get(missionId);
  if (!mission) throw new PluginMissionError('not_found', 'mission not found');
  return mission;
}

function createKanban(state) {
  return {
    async get(taskId) {
      return state.tasks.get(taskId);
    },
    async list(opts = {}) {
      let rows = [...state.tasks.values()];
      if (opts.status) rows = rows.filter((row) => row.status === opts.status);
      if (opts.project) rows = rows.filter((row) => row.project === opts.project);
      const limit = opts.limit ?? 50;
      return rows.slice(0, limit);
    },
    async add(input) {
      if (!input || typeof input.title !== 'string' || !input.title.trim()) {
        throw new PluginTaskError('invalid', 'title is required');
      }
      const now = Date.now();
      const task = {
        id: randomUUID(),
        title: input.title,
        description: input.description ?? '',
        status: 'PENDING',
        agent: input.agent ?? null,
        agent_name: input.agent ?? null,
        project: input.project ?? null,
        type: input.type ?? 'chore',
        created_at: now,
        updated_at: now,
        links: [],
      };
      state.tasks.set(task.id, task);
      return task;
    },
    async ensure(input, links = []) {
      for (const link of links) {
        const found = findTaskByRef(state, link?.provider, link?.ref);
        if (found) return { task: found, created: false };
      }
      const task = await this.add(input);
      for (const link of links) {
        if (link?.provider && link?.ref) task.links.push({ ...link });
      }
      return { task, created: true };
    },
    async update(taskId, patch) {
      const task = requireTask(state, taskId);
      if (!patch || typeof patch !== 'object') {
        throw new PluginTaskError('invalid', 'patch is required');
      }
      for (const key of ['title', 'description', 'status', 'agent']) {
        if (patch[key] !== undefined) task[key] = patch[key];
      }
      return task;
    },
    async done(taskId, input) {
      const task = requireTask(state, taskId);
      if (!input || typeof input.comment !== 'string' || !input.comment) {
        throw new PluginTaskError('invalid', 'comment is required');
      }
      task.status = 'DONE';
      task.comment = input.comment;
      return task;
    },
    async block(taskId, reason) {
      const task = requireTask(state, taskId);
      if (typeof reason !== 'string' || !reason) {
        throw new PluginTaskError('invalid', 'reason is required');
      }
      task.status = 'BLOCKED';
      task.blocked_reason = reason;
      return task;
    },
    async delete(taskId) {
      requireTask(state, taskId);
      state.tasks.delete(taskId);
      return true;
    },
    refs: {
      async list(taskId) {
        return [...(requireTask(state, taskId).links)];
      },
      async findByRef(provider, ref) {
        return findTaskByRef(state, provider, ref);
      },
      async set(taskId, link) {
        const task = requireTask(state, taskId);
        if (!link || typeof link.provider !== 'string' || typeof link.ref !== 'string') {
          throw new PluginTaskError('invalid', 'provider and ref are required');
        }
        const existing = task.links.find((item) => item.provider === link.provider && item.ref === link.ref);
        if (existing) Object.assign(existing, link);
        else task.links.push({ ...link });
        return task.links;
      },
      async remove(taskId, provider, ref) {
        const task = requireTask(state, taskId);
        const before = task.links.length;
        task.links = task.links.filter((item) => item.provider !== provider || item.ref !== ref);
        return task.links.length !== before;
      },
    },
  };
}

function requireTask(state, taskId) {
  if (typeof taskId !== 'string' || !taskId) {
    throw new PluginTaskError('invalid', 'a task id is required');
  }
  const task = state.tasks.get(taskId);
  if (!task) throw new PluginTaskError('not_found', 'task not found');
  return task;
}

function findTaskByRef(state, provider, ref) {
  if (!provider || !ref) return undefined;
  for (const task of state.tasks.values()) {
    if (task.links.some((link) => link.provider === provider && link.ref === ref)) return task;
  }
  return undefined;
}

/**
 * In-memory `ctx.sql`. The daemon applies `migrations/` before `apply`;
 * this double does the same when the context is created.
 */
function createSql() {
  const db = new DatabaseSync(':memory:');
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) db.exec(readFileSync(join(dir, name), 'utf8'));
  const facade = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get(...params) {
          const row = stmt.get(...params);
          return row === undefined ? undefined : row;
        },
        all(...params) {
          return stmt.all(...params);
        },
        run(...params) {
          const result = stmt.run(...params);
          return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
        },
      };
    },
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
  return { facade, close: () => db.close() };
}

/**
 * @param {object[]} logs
 * @param {string} level
 * @param {unknown[]} args
 */
function record(logs, level, args) {
  logs.push({
    level,
    message: args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '),
  });
}

/**
 * @param {import('node:http').IncomingMessage} incoming
 * @param {string} prefix
 */
function mountRequest(incoming, prefix) {
  let url;
  try {
    url = new URL(incoming.url || '/', 'http://127.0.0.1');
  } catch {
    return null;
  }
  const path = url.pathname;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  const rest = path.slice(prefix.length) || '/';
  /** @type {Record<string, string>} */
  const query = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  return {
    request: {
      method: incoming.method || 'GET',
      headers: incoming.headers,
      url: `${rest}${url.search}`,
      originalUrl: incoming.url || '/',
      baseUrl: prefix,
      path: rest,
      query,
      params: {},
      body: undefined,
      get(name) {
        const value = incoming.headers[String(name).toLowerCase()];
        return Array.isArray(value) ? value.join(', ') : value;
      },
    },
  };
}

/**
 * @param {import('node:http').IncomingMessage} incoming
 * @param {{ body: unknown }} request
 * @returns {Promise<Error | null>}
 */
function readJsonBody(incoming, request) {
  const method = incoming.method || 'GET';
  if (method === 'GET' || method === 'HEAD') return Promise.resolve(null);
  const type = incoming.headers['content-type'];
  if (typeof type === 'string' && type.toLowerCase().includes('application/x-www-form-urlencoded')) {
    return readRaw(incoming).then((raw) => {
      /** @type {Record<string, string>} */
      const fields = {};
      for (const [key, value] of new URLSearchParams(raw.toString('utf8'))) fields[key] = value;
      request.body = fields;
      return null;
    }, (error) => error);
  }
  if (typeof type !== 'string' || !type.toLowerCase().includes('application/json')) {
    return Promise.resolve(null);
  }
  return readRaw(incoming).then((raw) => {
    if (raw.length === 0) {
      request.body = {};
      return null;
    }
    try {
      request.body = JSON.parse(raw.toString('utf8'));
      return null;
    } catch {
      return Object.assign(new Error('Request body is not valid JSON'), {
        status: 400,
        code: 'invalid_json',
      });
    }
  }, (error) => error);
}

/**
 * @param {import('node:http').IncomingMessage} incoming
 * @returns {Promise<Buffer>}
 */
function readRaw(incoming) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    incoming.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        failed = true;
        reject(Object.assign(new Error('Request body exceeds 1mb'), {
          status: 413,
          code: 'body_too_large',
        }));
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    incoming.on('error', (error) => {
      if (!failed) reject(error);
    });
  });
}

/**
 * @param {unknown} error
 * @returns {{ status: number, error: string, message: string } | null}
 */
function httpErrorOf(error) {
  if (!error || typeof error !== 'object') return null;
  const record = /** @type {{ status?: unknown, code?: unknown, message?: unknown }} */ (error);
  const status = Number(record.status);
  if (!Number.isInteger(status) || status < 400 || status > 599) return null;
  if (typeof record.code !== 'string' || !record.code) return null;
  const message = typeof record.message === 'string' && record.message ? record.message : record.code;
  return { status, error: record.code, message };
}

/**
 * @param {string | undefined} url
 */
function pathnameOf(url) {
  try {
    return new URL(url || '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}
