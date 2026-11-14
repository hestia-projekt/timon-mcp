import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { apply, PLUGIN_ID } from '../../lib/index.js';
import { createFakeCtx, PluginMissionError, PluginPolicyError } from '../helpers/fake-ctx.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('GET /health is mounted under the plugin prefix', async (t) => {
  const { ctx, baseUrl, close } = await createFakeCtx({ id: pkg.timon.id });
  t.after(() => close());
  apply(ctx);

  const health = await fetch(`${baseUrl}/api/plugins/${pkg.timon.id}/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type') || '', /application\/json/);
  const body = await health.json();
  assert.deepEqual(body, { ok: true, id: 'timon-mcp' });
  assert.equal(body.id, PLUGIN_ID);
  assert.equal(body.id, pkg.timon.id);

  const head = await fetch(`${baseUrl}/api/plugins/${pkg.timon.id}/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const outside = await fetch(`${baseUrl}/health`);
  assert.equal(outside.status, 404);
  const outsideBody = await outside.json();
  assert.equal(outsideBody.error, 'not_found');
});

test('predictable failures on /health are JSON', async (t) => {
  const { ctx, baseUrl, close } = await createFakeCtx({ id: PLUGIN_ID });
  t.after(() => close());
  apply(ctx);
  const root = `${baseUrl}/api/plugins/${PLUGIN_ID}`;

  const posted = await fetch(`${root}/health`, { method: 'POST' });
  assert.equal(posted.status, 405);
  assert.match(posted.headers.get('allow') || '', /GET/);
  assert.deepEqual(await posted.json(), {
    error: 'method_not_allowed',
    message: 'Use GET /health',
  });

  const missing = await fetch(`${root}/missing`);
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.error, 'not_found');
  assert.match(missingBody.message, /No route for GET \/missing/);
});

test('the plugin 404 does not swallow the reserved /- / prefix', async (t) => {
  const { ctx, baseUrl, close } = await createFakeCtx({ id: PLUGIN_ID });
  t.after(() => close());
  apply(ctx);
  const later = ctx.router();
  later.get('/-/x', (_req, res) => {
    res.status(200).json({ reserved: true });
  });

  const response = await fetch(`${baseUrl}/api/plugins/${PLUGIN_ID}/-/x`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reserved: true });
});

test('apply rejects a context without a router', () => {
  assert.throws(() => apply(null), (error) => {
    assert.equal(error.code, 'invalid_context');
    assert.match(error.message, /router/);
    return true;
  });
  assert.throws(() => apply({}), (error) => {
    assert.equal(error.code, 'invalid_context');
    return true;
  });
});

test('mission errors carry a code and policy errors carry a rule', () => {
  const mission = new PluginMissionError('not_found', 'mission not found');
  assert.equal(mission.name, 'PluginMissionError');
  assert.equal(mission.code, 'not_found');
  assert.ok(mission instanceof Error);

  const policy = new PluginPolicyError('timon-mcp', 'spawn', 'quota exceeded');
  assert.equal(policy.name, 'PluginPolicyError');
  assert.equal(policy.pluginId, 'timon-mcp');
  assert.equal(policy.rule, 'spawn');
  assert.equal(policy.code, undefined);
  assert.match(policy.message, /quota exceeded/);
});
