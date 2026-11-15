import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BEARER_SECRET } from '../../lib/constants.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/**
 * Permissions this plugin must never declare. A trailing `*` forbids the
 * whole prefix (`agents:*` forbids `agents:manage` as well as the literal).
 */
const FORBIDDEN_PERMISSIONS = [
  'agents:privileged-config',
  'agents:*',
  'mcp-servers:*',
  'skills:*',
  'secrets:manage',
  'secrets:list',
  'secrets:broker',
  'admin',
];

/**
 * @param {string} permission
 */
export function isForbiddenPermission(permission) {
  return FORBIDDEN_PERMISSIONS.some((rule) => {
    if (rule.endsWith('*')) return permission.startsWith(rule.slice(0, -1));
    return permission === rule;
  });
}

test('manifest id, api version and kind', () => {
  const manifest = pkg.timon;
  assert.equal(typeof manifest, 'object');
  assert.match(manifest.id, /^[a-z0-9-]{3,40}$/);
  assert.equal(manifest.apiVersion, 15);
  // kinds.md: a host plugin with no UI slot is `behavior`. `integration` is not a kind.
  assert.equal(manifest.kind, 'behavior');
  assert.equal(typeof manifest.label, 'string');
  assert.ok(manifest.label.length > 0);
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 0);
  assert.ok(Array.isArray(manifest.permissions));
});

test('manifest permissions, secrets, settings and public routes are exactly the step 3 set', () => {
  assert.deepEqual(pkg.timon.permissions, [
    'http:public',
    'missions:spawn',
    'missions:read',
    'missions:control',
    'kanban:read',
    'kanban:write',
    'settings',
    'secrets:read',
    'storage:sql',
  ]);
  assert.deepEqual(pkg.timon.routes.publicPaths, [
    { method: 'POST', path: '/mcp' },
    { method: 'GET', path: '/oauth/protected-resource' },
    { method: 'GET', path: '/oauth/authorization-server' },
    { method: 'POST', path: '/oauth/register' },
    { method: 'GET', path: '/oauth/authorize' },
    { method: 'POST', path: '/oauth/authorize' },
    { method: 'POST', path: '/oauth/token' },
  ]);
  assert.ok(pkg.timon.routes.publicPaths.length <= 10);
  assert.equal(pkg.timon.migrations, 'migrations');
  assert.deepEqual(pkg.files, ['lib', 'migrations', 'README.md']);
  assert.equal(pkg.timon.secrets.length, 1);
  assert.equal(pkg.timon.secrets[0].name, BEARER_SECRET);
  assert.equal(pkg.timon.secrets[0].mode, 'read');
  assert.equal(pkg.timon.secrets[0].why.includes(BEARER_SECRET), false);
  assert.ok(pkg.timon.secrets[0].why.length > 0);
  assert.ok(pkg.timon.secrets[0].why.length <= 200);
  assert.deepEqual(pkg.timon.settings.map((item) => item.key), [
    'public_url',
    'issuer',
    'resource',
    'identity_header',
    'expected_right',
    'email_allowlist',
  ]);
  const right = pkg.timon.settings.find((item) => item.key === 'expected_right');
  assert.equal(right.default, 'timon');
  const header = pkg.timon.settings.find((item) => item.key === 'identity_header');
  assert.equal(header.default, undefined);
  assert.equal(JSON.stringify(pkg.timon.secrets).includes('TIMON_MCP_OAUTH_KEY'), false);
});

test('package is the private ESM entry point', () => {
  assert.equal(pkg.name, '@hestia-projekt/timon-mcp');
  assert.equal(pkg.license, 'AGPL-3.0-only');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.engines.node, '>=22.13 <23 || >=23.4');
  assert.equal(pkg.scripts.test, 'node --test');
});

test('forbidden permission blacklist rejects configuration rights', () => {
  const samples = [
    'agents:privileged-config',
    'agents:manage',
    'agents:read',
    'agents:*',
    'mcp-servers:read',
    'mcp-servers:write',
    'mcp-servers:*',
    'skills:read',
    'skills:write',
    'skills:*',
    'secrets:manage',
    'secrets:list',
    'secrets:broker',
    'admin',
  ];
  for (const permission of samples) {
    assert.equal(isForbiddenPermission(permission), true, permission);
  }
  assert.equal(isForbiddenPermission('missions:read'), false);
  assert.equal(isForbiddenPermission('kanban:read'), false);
  assert.equal(isForbiddenPermission('settings'), false);
  assert.equal(isForbiddenPermission('secrets:read'), false);
  assert.equal(isForbiddenPermission('storage:sql'), false);
});

test('manifest declares none of the forbidden permissions', () => {
  for (const permission of pkg.timon.permissions) {
    assert.equal(typeof permission, 'string', permission);
    assert.equal(isForbiddenPermission(permission), false, permission);
  }
});
