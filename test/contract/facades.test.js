import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PluginMissionError, PluginTaskError } from '../../host/errors.js';
import { LIST_BUDGET_MS, createMissionFacade, createTaskFacade } from '../../host/facades.js';

test('a list stops on its time budget instead of returning a short list', async (t) => {
  assert.equal(LIST_BUDGET_MS, 60_000);
  // One read already in flight may still spend its 20s daemon cap.
  // That sum stays under the 120s socket idle limit.
  assert.ok(LIST_BUDGET_MS + 20_000 < 120_000);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE host_missions (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE host_tasks (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const insertMission = db.prepare(
    'INSERT INTO host_missions (id, agent_name, created_at) VALUES (?, ?, ?)',
  );
  const insertTask = db.prepare(
    'INSERT INTO host_tasks (id, project, agent_name, title, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 3; i += 1) {
    insertMission.run(`m${i}`, '_main', i + 1);
    insertTask.run(`t${i}`, 'alpha', 'alpha.main', 't', i + 1);
  }

  const delayMs = 80;
  const calls = [];
  const client = {
    request(method, path) {
      calls.push({ method, path });
      return new Promise((resolve) => {
        setTimeout(() => {
          if (path.startsWith('/api/tasks/')) {
            const id = path.slice(path.lastIndexOf('/') + 1);
            resolve({
              status: 200,
              json: {
                task: {
                  id,
                  status: 'PENDING',
                  title: 't',
                  project: 'alpha',
                  agent_name: 'alpha.main',
                  type: 'chore',
                },
              },
            });
            return;
          }
          const id = path.slice(path.lastIndexOf('/') + 1);
          resolve({
            status: 200,
            json: { id, status: 'running', agent_name: '_main', title: 't' },
          });
        }, delayMs);
      });
    },
  };
  const quota = { take() {} };
  // The first read starts under the budget. It cannot return before delayMs,
  // which is past listBudgetMs, so the next id is refused and no list comes back.
  const listBudgetMs = 40;

  const missions = createMissionFacade({ client, sql: db, quota, listBudgetMs });
  const missionStart = Date.now();
  await assert.rejects(
    () => missions.list(),
    (err) => err instanceof PluginMissionError && err.code === 'timeout' && err.message === 'list timed out',
  );
  const missionCalls = calls.filter((row) => row.path.startsWith('/api/missions/'));
  assert.equal(missionCalls.length, 1);
  assert.ok(Date.now() - missionStart < delayMs * 3, String(Date.now() - missionStart));

  const beforeTasks = calls.length;
  const tasks = createTaskFacade({ client, sql: db, quota, listBudgetMs });
  const taskStart = Date.now();
  await assert.rejects(
    () => tasks.list(),
    (err) => err instanceof PluginTaskError && err.code === 'timeout' && err.message === 'list timed out',
  );
  assert.equal(calls.length - beforeTasks, 1);
  assert.ok(Date.now() - taskStart < delayMs * 3, String(Date.now() - taskStart));
  assert.equal(calls.some((row) => row.path.endsWith('/m1') || row.path.endsWith('/t1')), false);
});
