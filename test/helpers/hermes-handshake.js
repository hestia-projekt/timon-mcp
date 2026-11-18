import assert from 'node:assert/strict';
import { LATEST_PROTOCOL_VERSION } from '../../lib/constants.js';

/**
 * Hermes Agent (Python SDK mcp 2.0.0) posts `initialize` with
 * `params.protocolVersion` 2025-11-25 and an `MCP-Protocol-Version` header of
 * 2026-07-28 or 2025-11-25. The header is ignored on that request. Later
 * requests carry the version the server negotiated.
 * @param {(body: object, headers?: Record<string, string>) => Promise<{ status: number, json: { error?: { code?: number }, result?: { protocolVersion?: string, tools?: unknown } } }>} post
 */
export async function assertHermesHandshake(post) {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'hermes', version: '0' },
    },
  };

  const futureHeader = await post(initialize, { 'mcp-protocol-version': '2026-07-28' });
  assert.equal(futureHeader.status, 200);
  assert.equal(futureHeader.json.error, undefined);
  assert.equal(futureHeader.json.result.protocolVersion, LATEST_PROTOCOL_VERSION);

  const sameBody = await post(
    { ...initialize, id: 2 },
    { 'mcp-protocol-version': '2025-11-25' },
  );
  assert.equal(sameBody.status, 200);
  assert.equal(sameBody.json.error, undefined);
  assert.equal(sameBody.json.result.protocolVersion, LATEST_PROTOCOL_VERSION);

  const negotiated = futureHeader.json.result.protocolVersion;
  const listed = await post(
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    { 'mcp-protocol-version': negotiated },
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.json.error, undefined);
  assert.ok(Array.isArray(listed.json.result.tools));

  const rejected = await post(
    { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
    { 'mcp-protocol-version': '2026-07-28' },
  );
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error.code, -32600);

  const bare = await post({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
  assert.equal(bare.status, 200);
  assert.equal(bare.json.error, undefined);
  assert.ok(Array.isArray(bare.json.result.tools));
}
