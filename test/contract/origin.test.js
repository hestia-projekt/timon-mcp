import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foreignOrigin } from '../../lib/mcp/origin.js';

test('a port-less Host accepts a port-less https Origin', () => {
  assert.equal(foreignOrigin(req({ host: 'example.com', origin: 'https://example.com' })), null);
  assert.equal(foreignOrigin(req({ host: 'example.com', origin: 'http://example.com' })), null);
});

test('an explicit Host port must match the Origin port', () => {
  const refused = foreignOrigin(req({ host: 'example.com:8443', origin: 'https://example.com' }));
  assert.equal(refused, 'foreign Origin');
  assert.equal(foreignOrigin(req({ host: 'example.com:8443', origin: 'https://example.com:8443' })), null);
  assert.equal(foreignOrigin(req({ host: 'example.com:443', origin: 'https://example.com' })), null);
});

test('a port-less Host refuses an Origin on another port', () => {
  assert.equal(
    foreignOrigin(req({ host: 'example.com', origin: 'https://example.com:8443' })),
    'foreign Origin',
  );
});

test('a different host is foreign and a missing Origin is allowed', () => {
  assert.equal(foreignOrigin(req({ host: 'example.com', origin: 'https://evil.example' })), 'foreign Origin');
  assert.equal(foreignOrigin(req({ host: 'example.com' })), null);
});

/**
 * @param {Record<string, string>} headers
 */
function req(headers) {
  return { headers };
}
