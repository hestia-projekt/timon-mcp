import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('files allow-list ships neither tests nor agent instructions', () => {
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.length > 0);
  for (const entry of pkg.files) {
    assert.equal(typeof entry, 'string');
    const normalized = entry.replaceAll('\\', '/');
    assert.doesNotMatch(normalized, /(^|\/)tests?($|\/)/i);
    assert.doesNotMatch(normalized, /(^|\/)AGENTS\.md$/);
    assert.doesNotMatch(normalized, /(^|\/)CLAUDE\.md$/);
    assert.notEqual(normalized, 'AGENTS.md');
    assert.notEqual(normalized, 'CLAUDE.md');
  }
});

test('lib has no machine absolute path and no sdk import', () => {
  const lib = fileURLToPath(new URL('../../lib/', import.meta.url));
  const sources = walk(lib).filter((file) => file.endsWith('.js'));
  assert.ok(sources.length > 0);
  const needles = ['/home/', '/Users/', 'C:\\Users'];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const needle of needles) {
      assert.equal(text.includes(needle), false, `${file} contains ${needle}`);
    }
    assert.equal(text.includes('@timon-ai/sdk'), false, file);
    assert.doesNotMatch(text, /secrets\.get\(\s*['"`]/);
  }
});

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}
