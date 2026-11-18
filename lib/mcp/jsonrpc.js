import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../constants.js';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * @param {unknown} id
 * @param {unknown} result
 */
export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * @param {unknown} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 */
export function rpcError(id, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * Spec (lifecycle, 2025-03-26 and 2025-06-18): a supported version is echoed.
 * Anything else is answered with the latest version this server speaks. The
 * client disconnects when it cannot speak that version. A missing version is
 * not a negotiation: the caller rejects it as invalid params.
 * @param {unknown} clientVersion
 * @returns {string | null}
 */
export function negotiateVersion(clientVersion) {
  if (typeof clientVersion !== 'string' || clientVersion.length === 0) return null;
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)) return clientVersion;
  return LATEST_PROTOCOL_VERSION;
}

/**
 * `MCP-Protocol-Version` on a later HTTP request. Absent means the caller is
 * treated as 2025-03-26 (spec). An unsupported value is refused with HTTP 400
 * by the route; this only classifies the header.
 * @param {unknown} header
 * @returns {'absent' | 'supported' | 'unsupported'}
 */
export function classifyProtocolHeader(header) {
  if (header == null || header === '') return 'absent';
  const value = String(header).trim();
  if (!value) return 'absent';
  return SUPPORTED_PROTOCOL_VERSIONS.includes(value) ? 'supported' : 'unsupported';
}

/**
 * The header is not part of `initialize`. Spec 2025-06-18 (transports): the
 * client sends `MCP-Protocol-Version` on requests after the handshake, and
 * the body `params.protocolVersion` is what gets negotiated. Any other
 * method, notifications included, still refuses a present unsupported value.
 * An absent header is accepted.
 * @param {unknown} headerValue
 * @param {unknown} method JSON-RPC method when the body declares one
 * @returns {boolean}
 */
export function protocolHeaderRejected(headerValue, method) {
  if (method === 'initialize') return false;
  return classifyProtocolHeader(headerValue) === 'unsupported';
}

/**
 * @param {unknown} message
 * @returns {{ kind: 'invalid', id: unknown }
 *   | { kind: 'notification', method: string, params: unknown }
 *   | { kind: 'request', id: string | number, method: string, params: unknown }
 *   | { kind: 'client-response' }}
 */
export function classifyMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { kind: 'invalid', id: null };
  }
  const record = /** @type {Record<string, unknown>} */ (message);
  const id = Object.prototype.hasOwnProperty.call(record, 'id') ? record.id : undefined;
  if (record.jsonrpc !== '2.0') return { kind: 'invalid', id: usableId(id) };
  const hasMethod = typeof record.method === 'string' && record.method.length > 0;
  const hasId = Object.prototype.hasOwnProperty.call(record, 'id');
  if (hasMethod && !hasId) {
    return { kind: 'notification', method: record.method, params: record.params };
  }
  if (hasMethod && hasId) {
    if (typeof id !== 'string' && typeof id !== 'number') return { kind: 'invalid', id: null };
    return { kind: 'request', id, method: record.method, params: record.params };
  }
  if (!hasMethod && (Object.prototype.hasOwnProperty.call(record, 'result')
    || Object.prototype.hasOwnProperty.call(record, 'error'))) {
    return { kind: 'client-response' };
  }
  return { kind: 'invalid', id: usableId(id) };
}

/**
 * @param {unknown} id
 */
function usableId(id) {
  if (typeof id === 'string' || typeof id === 'number') return id;
  return null;
}
