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
  STANDALONE_NODE_RANGE,
  nodeSupportsSqlite,
  parseNodeVersion,
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
  assert.equal(nodeSupportsSqlite('23.0.0'), false);
  assert.equal(nodeSupportsSqlite('23.3.9'), false);
  assert.equal(nodeSupportsSqlite('23.4.0'), true);
  assert.equal(nodeSupportsSqlite('24.0.0'), true);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, STANDALONE_NODE_RANGE);
  const message = standaloneNodeMessage('22.12.0');
  assert.match(message, /Node\.js >=22\.13 <23 \|\| >=23\.4/);
  assert.match(message, /node:sqlite/);
  assert.match(message, /v22\.12\.0/);
});

test('engines.node and nodeSupportsSqlite agree on the published range', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  assert.equal(pkg.engines.node, '>=22.13 <23 || >=23.4');
  assert.equal(pkg.engines.node, STANDALONE_NODE_RANGE);
  assert.equal(standaloneNodeMessage('23.3.9').includes(pkg.engines.node), true);
  assert.match(readme, /^Node\.js >=22\.13 <23 \|\| >=23\.4\. From this directory/m);
  assert.match(readme, /It needs Node\.js >=22\.13 <23 \|\| >=23\.4, because/);
  const samples = ['22.12.9', '22.13.0', '23.3.9', '23.4.0', '24.0.0'];
  for (const version of samples) {
    assert.equal(
      satisfiesNodeRange(pkg.engines.node, version),
      nodeSupportsSqlite(version),
      version,
    );
  }
});

test('the standalone process refuses Node.js older than 22.13', async () => {
  const result = await runPinned('22.12.0');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Node\.js >=22\.13 <23 \|\| >=23\.4/);
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
 * npm treats a partial version in `engines` as zero-padded (`22.13` is `22.13.0`).
 * @param {string} range
 * @param {string} version
 */
function satisfiesNodeRange(range, version) {
  const actual = parseNodeVersion(version);
  return range.split('||').some((alternative) => alternative.trim().split(/\s+/).filter(Boolean).every((comparator) => {
    const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(comparator);
    if (!match) return false;
    const operator = match[1] || '=';
    const order = compareVersions(actual, parseNodeVersion(match[2]));
    if (operator === '>=') return order >= 0;
    if (operator === '<=') return order <= 0;
    if (operator === '>') return order > 0;
    if (operator === '<') return order < 0;
    return order === 0;
  }));
}

/**
 * @param {[number, number, number]} left
 * @param {[number, number, number]} right
 */
function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

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
