import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTerminalHandlers } from '../../lib/http.js';
import { PluginMissionError, PluginPolicyError, PluginTaskError } from '../helpers/fake-ctx.js';
import { createResponse, createRouter } from '../helpers/mini-router.js';

const MISSION = [
  ['invalid', 400],
  ['not_found', 404],
  ['forbidden', 403],
  ['not_running', 409],
  ['turn_in_progress', 409],
  ['backend_exhausted', 503],
  ['override_denied', 403],
  ['failed', 502],
];

const TASK = [
  ['invalid', 400],
  ['not_found', 404],
  ['conflict', 409],
  ['forbidden', 403],
];

test('mission and task errors are answered by the plugin router', async () => {
  for (const [code, status] of MISSION) {
    const body = await dispatch(new PluginMissionError(code, `mission ${code}`));
    assert.equal(body.status, status, code);
    assert.deepEqual(body.json, { error: code, message: `mission ${code}` });
  }
  for (const [code, status] of TASK) {
    const body = await dispatch(new PluginTaskError(code, `task ${code}`));
    assert.equal(body.status, status, code);
    assert.deepEqual(body.json, { error: code, message: `task ${code}` });
  }
});

test('a policy error is described from its rule', async () => {
  const policy = new PluginPolicyError('timon-mcp', 'spawn', 'quota exceeded');
  assert.equal(policy.code, undefined);
  const body = await dispatch(policy);
  assert.equal(body.status, 403);
  assert.equal(body.json.error, 'spawn');
  assert.match(body.json.message, /quota exceeded/);
});

test('an undescribed error is left for the daemon', async () => {
  const router = createRouter();
  router.get('/boom', (_req, _res, next) => next(new Error('boom')));
  installTerminalHandlers(router);
  const raw = rawResponse();
  const res = createResponse(raw);
  const left = await router.handle({ method: 'GET', path: '/boom', url: '/boom' }, res);
  assert.equal(res.headersSent, false);
  assert.ok(left instanceof Error);
  assert.equal(left.message, 'boom');
});

/**
 * @param {Error} error
 */
async function dispatch(error) {
  const router = createRouter();
  router.get('/err', (_req, _res, next) => next(error));
  installTerminalHandlers(router);
  const raw = rawResponse();
  const res = createResponse(raw);
  await router.handle({ method: 'GET', path: '/err', url: '/err' }, res);
  assert.equal(res.headersSent, true);
  return { status: res.statusCode, json: JSON.parse(raw.body) };
}

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
