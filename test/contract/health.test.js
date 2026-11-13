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

  const invalid = await fetch(`${root}/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: 'invalid_json',
    message: 'Request body is not valid JSON',
  });
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

test('mission and policy errors carry their code', () => {
  const mission = new PluginMissionError('not_found', 'mission not found');
  assert.equal(mission.name, 'PluginMissionError');
  assert.equal(mission.code, 'not_found');
  assert.ok(mission instanceof Error);

  const policy = new PluginPolicyError('timon-mcp', 'spawn', 'quota exceeded');
  assert.equal(policy.name, 'PluginPolicyError');
  assert.equal(policy.pluginId, 'timon-mcp');
  assert.equal(policy.rule, 'spawn');
  assert.equal(policy.code, 'spawn');
  assert.match(policy.message, /quota exceeded/);
});
