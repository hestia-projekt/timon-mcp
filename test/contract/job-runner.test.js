import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import { createJobRunner } from '../../lib/mcp/job-runner.js';

const requestContext = new AsyncLocalStorage();

test('the pump runs a job outside the caller AsyncLocalStorage store', async (t) => {
  const jobs = createJobRunner();
  jobs.start();
  // The pump timer is unref'd so an idle plugin does not hold the process.
  // This test has no server, so a ref'd timer keeps the loop alive until the
  // interval (armed outside the request) actually runs the job.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => {
    clearInterval(keepAlive);
    jobs.stop();
  });

  const seen = await requestContext.run({ scope: 'request' }, () => jobs.submit(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return requestContext.getStore() ?? null;
  }));
  assert.equal(seen, null);
  assert.equal(await jobs.submit(() => 7), 7);
});

test('stop drops the timer and refuses new jobs', async () => {
  const jobs = createJobRunner();
  jobs.start();
  jobs.stop();
  await assert.rejects(() => jobs.submit(() => 1), (error) => error.code === 'unloaded');
});
