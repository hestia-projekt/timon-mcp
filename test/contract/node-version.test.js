import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MIN_STANDALONE_NODE,
  nodeSupportsSqlite,
  standaloneNodeMessage,
} from '../../host/node-version.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('node:sqlite is required from Node.js 22.13', () => {
  assert.deepEqual([...MIN_STANDALONE_NODE], [22, 13, 0]);
  assert.equal(nodeSupportsSqlite('22.12.0'), false);
  assert.equal(nodeSupportsSqlite('22.12.99'), false);
  assert.equal(nodeSupportsSqlite('v22.12.0'), false);
  assert.equal(nodeSupportsSqlite('22.5.1'), false);
  assert.equal(nodeSupportsSqlite('22.0.0'), false);
  assert.equal(nodeSupportsSqlite('20.18.1'), false);
  assert.equal(nodeSupportsSqlite('22.13.0'), true);
  assert.equal(nodeSupportsSqlite('v22.13.0'), true);
  assert.equal(nodeSupportsSqlite('22.13.1'), true);
  assert.equal(nodeSupportsSqlite('22.23.4'), true);
  assert.equal(nodeSupportsSqlite('23.0.0'), true);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const [major, minor] = MIN_STANDALONE_NODE;
  assert.equal(pkg.engines.node, `>=${major}.${minor}`);
  const message = standaloneNodeMessage('22.12.0');
  assert.match(message, /Node\.js 22\.13 or newer/);
  assert.match(message, /node:sqlite/);
  assert.match(message, /v22\.12\.0/);
});

test('the standalone process refuses Node.js older than 22.13', async () => {
  const result = await runPinned('22.12.0');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Node\.js 22\.13 or newer/);
  assert.match(result.stderr, /node:sqlite/);
  assert.match(result.stderr, /v22\.12\.0/);
  assert.equal(result.stderr.includes('TIMON_MCP_PORT'), false);
  assert.equal(result.stdout.includes('listening'), false);
  assert.equal(result.stdout.includes(result.secret), false);
  assert.equal(result.stderr.includes(result.secret), false);
});

test('Node.js 22.13 passes the version gate and still reports a bad port', async () => {
  const result = await runPinned('22.13.0');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /TIMON_MCP_PORT is invalid/);
  assert.equal(result.stderr.includes('node:sqlite'), false);
  assert.equal(result.stdout.includes('listening'), false);
  assert.equal(result.stdout.includes(result.secret), false);
  assert.equal(result.stderr.includes(result.secret), false);
});

/**
 * Pins `process.versions.node` before the entry module runs.
 * @param {string} version
 */
function runPinned(version) {
  const dir = mkdtempSync(join(tmpdir(), 'timon-mcp-node-'));
  const preload = join(dir, 'pin.cjs');
  const secret = randomBytes(32).toString('hex');
  writeFileSync(
    preload,
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)}, configurable: true });\n`,
  );
  const env = { ...process.env };
  delete env.TIMON_DAEMON_TOKEN;
  env.TIMON_MCP_BEARER_TOKEN = secret;
  env.TIMON_MCP_PORT = 'nope';
  env.TIMON_DAEMON_URL = 'http://127.0.0.1:9';
  env.TIMON_DAEMON_TOKEN_FILE = join(dir, 'token');
  env.TIMON_MCP_DB = join(dir, 'state.db');
  const child = spawn(process.execPath, ['--require', preload, join(ROOT, 'bin/timon-mcp-standalone.js')], {
    cwd: ROOT,
    env,
    timeout: 4000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, secret });
    });
  });
}
