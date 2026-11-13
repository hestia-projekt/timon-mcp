import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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

test('manifest permissions and the public MCP route are exactly the step 2 set', () => {
  assert.deepEqual(pkg.timon.permissions, [
    'http:public',
    'missions:spawn',
    'missions:read',
    'missions:control',
    'kanban:read',
    'kanban:write',
  ]);
  assert.deepEqual(pkg.timon.routes, {
    publicPaths: [{ method: 'POST', path: '/mcp' }],
  });
});

test('package is the private ESM entry point', () => {
  assert.equal(pkg.name, '@hestia-projekt/timon-mcp');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.engines.node, '>=22');
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
});

test('manifest declares none of the forbidden permissions', () => {
  for (const permission of pkg.timon.permissions) {
    assert.equal(typeof permission, 'string', permission);
    assert.equal(isForbiddenPermission(permission), false, permission);
  }
});
