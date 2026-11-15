/**
 * Loopback daemon double. Contract tests point the host here.
 * It never reads a token file and never dials another process.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * @param {object} [options]
 * @param {string} options.token Expected bearer. Compared, never logged.
 * @param {boolean} [options.echoToken] Reflect the token in extra JSON fields.
 * @param {string} [options.foreignId] A mission this host did not create.
 */
export async function startFakeDaemon(options) {
  const token = options.token;
  const echoToken = options.echoToken === true;
  /** @type {Array<{ method: string, path: string, search: string, authorization: string, bodyText: string }>} */
  const requests = [];
  /** @type {Map<string, Record<string, unknown>>} */
  const missions = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const tasks = new Map();
  /** @type {{ status: number, body?: unknown, redirect?: boolean } | null} */
  let failNext = null;

  if (options.foreignId) {
    missions.set(options.foreignId, missionRow(options.foreignId, '_main', echoToken ? token : null));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    requests.push({
      method: req.method || 'GET',
      path: url.pathname,
      search: url.search,
      authorization,
      bodyText,
    });
    if (authorization !== `Bearer ${token}`) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    if (failNext) {
      const next = failNext;
      failNext = null;
      if (next.redirect) {
        res.writeHead(302, { location: '/' });
        res.end();
        return;
      }
      send(res, next.status, next.body ?? { error: 'failed' });
      return;
    }
    const method = req.method || 'GET';
    if (method === 'POST' && url.pathname === '/api/missions') {
      const body = parseBody(bodyText);
      const id = randomUUID();
      missions.set(id, missionRow(id, typeof body.agent === 'string' ? body.agent : '_main', echoToken ? token : null));
      const payload = { mission_id: id };
      if (echoToken) payload.leaked = token;
      send(res, 201, payload);
      return;
    }
    if (method === 'GET' && url.pathname.startsWith('/api/missions/')) {
      const id = url.pathname.slice('/api/missions/'.length);
      const mission = missions.get(id);
      if (!mission || id.includes('/')) {
        send(res, 404, { error: 'mission not found', code: 'mission_not_found' });
        return;
      }
      const payload = { ...mission };
      if (url.searchParams.get('view') !== 'status') payload.events = [{ payload: 'transcript' }];
      send(res, 200, payload);
      return;
    }
    if (method === 'POST' && url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/send')) {
      const id = url.pathname.slice('/api/agents/'.length, -'/send'.length);
      if (!missions.has(id)) {
        send(res, 404, { error: 'no running agent for that mission', code: 'mission_not_running' });
        return;
      }
      send(res, 200, { ok: true });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/tasks') {
      const body = parseBody(bodyText);
      const id = randomUUID();
      const now = Date.now();
      const task = {
        id,
        title: body.title ?? '',
        description: body.description ?? '',
        status: 'PENDING',
        agent_name: body.agent_name ?? null,
        project: body.project ?? null,
        type: body.type ?? null,
        created_at: now,
        updated_at: now,
        effective_backend: 'hidden-backend',
        effective_model: 'hidden-model',
        attachments: [{ name: 'hidden' }],
      };
      tasks.set(id, task);
      send(res, 201, { task });
      return;
    }
    if (method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
      const id = url.pathname.slice('/api/tasks/'.length);
      const task = tasks.get(id);
      if (!task || id.includes('/')) {
        send(res, 404, { error: 'not found', code: 'not_found' });
        return;
      }
      send(res, 200, { task });
      return;
    }
    send(res, 500, { error: 'unexpected route' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') {
    server.close();
    throw new Error('fake daemon failed to bind');
  }

  return {
    origin: `http://127.0.0.1:${bound.port}`,
    requests,
    missions,
    tasks,
    /**
     * @param {{ status: number, body?: unknown, redirect?: boolean }} next
     */
    failNext(next) { failNext = next; },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}

/**
 * @param {string} id
 * @param {string} agent
 * @param {string | null} echoed
 */
function missionRow(id, agent, echoed) {
  return {
    id,
    agent_name: agent,
    status: 'running',
    title: echoed,
    summary: echoed,
    started_at: Date.now(),
    ended_at: null,
  };
}

/**
 * @param {string} text
 */
function parseBody(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
