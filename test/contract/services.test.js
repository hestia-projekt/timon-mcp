import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createFakeCtx,
  PluginMissionError,
  PluginTaskError,
} from '../helpers/fake-ctx.js';

test('missions and kanban facades keep caller-supplied records', async (t) => {
  const { ctx, close } = await createFakeCtx();
  t.after(() => close());

  const missionId = await ctx.missions.spawn({ agent: 'pilot', mission: 'reply' });
  assert.equal(typeof missionId, 'string');
  assert.equal((await ctx.missions.get(missionId)).agent_name, 'pilot');
  assert.deepEqual(await ctx.missions.send(missionId, 'follow up'), { resumed: false });
  assert.equal(await ctx.missions.get('missing'), undefined);
  await assert.rejects(
    () => ctx.missions.send('missing', 'follow up'),
    (error) => error instanceof PluginMissionError && error.code === 'not_found',
  );

  const task = await ctx.kanban.add({ title: 'One task', agent: 'pilot' });
  assert.equal((await ctx.kanban.get(task.id)).status, 'PENDING');
  await ctx.kanban.done(task.id, { comment: 'done' });
  assert.equal((await ctx.kanban.get(task.id)).status, 'DONE');
  await assert.rejects(
    () => ctx.kanban.block('missing', 'reason'),
    (error) => error instanceof PluginTaskError && error.code === 'not_found',
  );
});

test('fake ctx rejects invalid JSON', async (t) => {
  const { baseUrl, close } = await createFakeCtx({ id: 'timon-mcp' });
  t.after(() => close());
  const invalid = await fetch(`${baseUrl}/api/plugins/timon-mcp/health`, {
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

test('secrets come from the values supplied at runtime', async (t) => {
  const name = `name-${randomUUID()}`;
  const value = randomUUID();
  const { ctx, close } = await createFakeCtx({ secrets: { [name]: value } });
  t.after(() => close());
  assert.equal(await ctx.secrets.get(name), value);
  assert.equal(await ctx.secrets.get(`other-${randomUUID()}`), undefined);
});
