import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResponse, createRouter } from '../helpers/mini-router.js';

test('use(path) mounts by prefix and restores the request path', async () => {
  const router = createRouter();
  /** @type {string | undefined} */
  let seenPath;
  /** @type {string | undefined} */
  let seenUrl;
  router.use('/mcp', (req, _res, next) => {
    seenPath = req.path;
    seenUrl = req.url;
    next();
  });
  router.get('/mcp/extra', (req, res) => {
    assert.equal(req.path, '/mcp/extra');
    assert.equal(req.url, '/mcp/extra?q=1');
    res.status(200).json({ ok: true });
  });

  const raw = rawResponse();
  const res = createResponse(raw);
  const req = { method: 'GET', path: '/mcp/extra', url: '/mcp/extra?q=1' };
  await router.handle(req, res);
  assert.equal(seenPath, '/extra');
  assert.equal(seenUrl, '/extra?q=1');
  assert.equal(req.path, '/mcp/extra');
  assert.equal(req.url, '/mcp/extra?q=1');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(raw.body), { ok: true });
});

test('use(path) does not match a longer segment', async () => {
  const router = createRouter();
  let hit = false;
  router.use('/mcp', (_req, res) => {
    hit = true;
    res.status(200).end('yes');
  });
  const res = createResponse(rawResponse());
  await router.handle({ method: 'GET', path: '/mcpfoo', url: '/mcpfoo' }, res);
  assert.equal(hit, false);
  assert.equal(res.headersSent, false);
});

test('an exact route does not match a longer path', async () => {
  const router = createRouter();
  let hit = false;
  router.get('/health', (_req, res) => {
    hit = true;
    res.status(200).end('ok');
  });
  const res = createResponse(rawResponse());
  await router.handle({ method: 'GET', path: '/health/extra', url: '/health/extra' }, res);
  assert.equal(hit, false);
  assert.equal(res.headersSent, false);
});

function rawResponse() {
  /** @type {Map<string, string>} */
  const headers = new Map();
  return {
    statusCode: 200,
    body: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(body) { this.body = body == null ? '' : String(body); },
  };
}
