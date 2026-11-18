import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate } from '../auth/index.js';
import { PLUGIN_ID, SUPPORTED_PROTOCOL_VERSIONS } from '../constants.js';
import { assertPluginMount } from '../http.js';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  classifyMessage,
  negotiateVersion,
  protocolHeaderRejected,
  rpcError,
  rpcResult,
} from './jsonrpc.js';
import { acceptsJson, foreignOrigin, header } from './origin.js';
import { TOOLS, findTool, runTool, toolError, validateInput } from './tools.js';

const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

const SERVER_VERSION = readServerVersion();

const INSTRUCTIONS = 'This server forwards a mandate to the pilot. The MCP mandates, the pilot orchestrates. It does not change agents or their rights.';

/**
 * Streamable HTTP MCP endpoint, stateless: one JSON-RPC message per POST,
 * `application/json` in response, no SSE stream and no session.
 *
 * `GET` and `DELETE` answer 405. The spec allows both when the server does
 * not open an SSE stream and does not let the client close a session.
 * `Mcp-Session-Id` is optional and ignored: this server never issues one.
 *
 * Tool work is handed to the pump created in `apply()`. This handler does not
 * call `ctx.missions` or `ctx.kanban`.
 *
 * @param {{ get: Function, use: Function, post?: Function, delete?: Function, all?: Function }} router
 * @param {object} ctx
 * @param {{ submit: (run: () => unknown) => Promise<unknown> }} jobs
 */
export function mountMcp(router, ctx, jobs) {
  assertPluginMount(router, ctx, 'mcp');
  if (!jobs || typeof jobs.submit !== 'function') {
    throw Object.assign(new Error('mcp requires the job runner created in apply()'), { code: 'invalid_context' });
  }
  const handle = (req, res) => handleMcp(req, res, ctx, jobs);
  if (typeof router.all === 'function') router.all('/mcp', handle);
  else router.use('/mcp', handle);
}

/**
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 * @param {{ submit: Function }} jobs
 */
async function handleMcp(req, res, ctx, jobs) {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST');
    res.status(405).json({
      error: 'method_not_allowed',
      message: 'Use POST /mcp',
    });
    return;
  }

  const auth = await authenticate(req, ctx);
  if (!auth || auth.ok === false) {
    if (auth && auth.wwwAuthenticate) res.set('WWW-Authenticate', auth.wwwAuthenticate);
    res.status(auth && auth.status ? auth.status : 401).json({
      error: 'unauthorized',
      message: auth && auth.message ? auth.message : 'authentication required',
    });
    return;
  }

  const origin = foreignOrigin(req);
  if (origin) {
    res.status(403).json({ error: 'forbidden_origin', message: 'Foreign Origin refused' });
    return;
  }

  if (!acceptsJson(req)) {
    res.status(406).json(rpcError(null, INVALID_REQUEST, 'Accept must allow application/json'));
    return;
  }

  // `Mcp-Session-Id` is optional. This server never issues one and does not
  // reject a request that carries one or omits it.

  const body = req.body;
  if (Array.isArray(body)) {
    res.status(400).json(rpcError(null, INVALID_REQUEST, 'JSON-RPC batches are not supported'));
    return;
  }
  if (body === undefined || body === null || typeof body !== 'object') {
    res.status(400).json(rpcError(null, INVALID_REQUEST, 'Invalid Request'));
    return;
  }

  const message = classifyMessage(body);
  // The body is classified before the header. `initialize` negotiates
  // `params.protocolVersion` and ignores `MCP-Protocol-Version`. Every other
  // method, notifications included, still refuses a present unknown value.
  const method = message.kind === 'request' || message.kind === 'notification' ? message.method : undefined;
  if (protocolHeaderRejected(header(req, 'mcp-protocol-version'), method)) {
    res.status(400).json(rpcError(null, INVALID_REQUEST, 'Unsupported protocol version', {
      supported: SUPPORTED_PROTOCOL_VERSIONS,
      requested: header(req, 'mcp-protocol-version'),
    }));
    return;
  }

  if (message.kind === 'invalid') {
    res.status(400).json(rpcError(message.id, INVALID_REQUEST, 'Invalid Request'));
    return;
  }
  if (message.kind === 'client-response' || message.kind === 'notification') {
    // Notifications, including `notifications/initialized`, get an empty 202.
    // Unknown notifications are accepted and ignored: JSON-RPC forbids a reply.
    res.status(202).end();
    return;
  }

  try {
    const result = await dispatch(message, ctx, jobs);
    if (result.error) res.status(200).json(rpcError(message.id, result.error.code, result.error.message, result.error.data));
    else res.status(200).json(rpcResult(message.id, result.result));
  } catch {
    if (!res.headersSent) {
      res.status(200).json(rpcError(message.id, INTERNAL_ERROR, 'internal error'));
    }
  }
}

/**
 * @param {{ id: string | number, method: string, params: unknown }} message
 * @param {object} ctx
 * @param {{ submit: Function }} jobs
 */
async function dispatch(message, ctx, jobs) {
  if (message.method === 'initialize') return initialize(message.params);
  if (message.method === 'ping') return { result: {} };
  if (message.method === 'tools/list') return { result: { tools: publicTools() } };
  if (message.method === 'tools/call') return callTool(message.params, ctx, jobs);
  return { error: { code: METHOD_NOT_FOUND, message: 'Method not found' } };
}

/**
 * @param {unknown} params
 */
function initialize(params) {
  const record = params && typeof params === 'object' ? /** @type {Record<string, unknown>} */ (params) : {};
  const version = negotiateVersion(record.protocolVersion);
  if (!version) {
    return {
      error: {
        code: INVALID_PARAMS,
        message: 'Invalid params',
        data: { supported: SUPPORTED_PROTOCOL_VERSIONS },
      },
    };
  }
  return {
    result: {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: PLUGIN_ID, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    },
  };
}

/**
 * @param {unknown} params
 * @param {object} ctx
 * @param {{ submit: Function }} jobs
 */
async function callTool(params, ctx, jobs) {
  const record = params && typeof params === 'object' ? /** @type {Record<string, unknown>} */ (params) : null;
  if (!record || typeof record.name !== 'string' || !record.name) {
    return { error: { code: INVALID_PARAMS, message: 'Invalid params' } };
  }
  const tool = findTool(record.name);
  if (!tool) {
    // Unknown name: a tool error, and no facade call. -32602 would also be
    // correct; the text is the contract the client displays.
    return { result: toolError('unknown tool') };
  }
  const validated = validateInput(tool.inputSchema, record.arguments);
  if (!validated.ok) {
    return { error: { code: INVALID_PARAMS, message: validated.message } };
  }
  const result = await jobs.submit(() => runTool(ctx, tool.name, validated.value));
  return { result };
}

function publicTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/**
 * @returns {string}
 */
function readServerVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
