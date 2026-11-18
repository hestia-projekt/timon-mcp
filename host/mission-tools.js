/**
 * Mission tools for the standalone host. They are mounted on `POST /mcp`
 * ahead of the plugin's six tools. `lib/` does not list them: inside the
 * daemon the plugin still speaks only to the pilot.
 *
 * Every call is checked against the closed daemon list before the network.
 * A missing plugin bearer is left to the plugin handler, which answers 401.
 */
import { timingSafeEqual } from 'node:crypto';
import { presentedBearer } from '../lib/auth/body.js';
import { sha256Hex } from '../lib/auth/crypto.js';
import { authenticate } from '../lib/auth/index.js';
import { BEARER_SECRET, MESSAGE_MAX_CHARS } from '../lib/constants.js';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  classifyMessage,
  protocolHeaderRejected,
  rpcError,
  rpcResult,
} from '../lib/mcp/jsonrpc.js';
import { acceptsJson, foreignOrigin, header } from '../lib/mcp/origin.js';
import { TOOLS, explainToolError, toolError, validateInput } from '../lib/mcp/tools.js';
import { AUTOMATION_TOOLS } from './automation-tools.js';
import { ROSTER_TOOLS } from './agent-tools.js';
import { KANBAN_TOOLS } from './kanban-tools.js';
import { DECISION_TOOLS } from './decision-tools.js';
import { PENDING_TOOLS } from './pending-tools.js';
import { AGENT_NAME_MAX, AGENT_PATH, AGENT_READ_MAX, MISSION_ID, NAMED_AGENT, PROJECT_NAME } from './names.js';

const STATUS_ENUM = ['running', 'completed', 'failed', 'terminated'];

/**
 * @param {string} description
 * @param {Record<string, object>} properties
 * @param {string[]} [required]
 */
function schema(description, properties, required) {
  return {
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required ? { required } : {}),
    },
  };
}

const missionId = { type: 'string', minLength: 1, maxLength: 200, pattern: MISSION_ID.source };
const namedAgent = { type: 'string', maxLength: AGENT_NAME_MAX, pattern: NAMED_AGENT.source };
const readAgent = { type: 'string', maxLength: AGENT_READ_MAX, pattern: AGENT_PATH.source };
const message = { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_CHARS };

export const MISSION_TOOLS = [
  {
    name: 'list_all_missions',
    ...schema(
      'Lists every mission on this Timon, not only the ones this host started. Filters: project, agent (a display name, including an ephemeral `_eph-…`; `.`, `..`, and the route words active, spawn, ephemeral, and main are refused), and status (running, completed, failed, terminated). The prompt is not returned.',
      {
        project: { type: 'string', pattern: PROJECT_NAME.source },
        agent: readAgent,
        status: { type: 'string', enum: STATUS_ENUM },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const missions = await ctx.missions.listAll(args);
      return { missions };
    },
  },
  {
    name: 'get_mission_state',
    ...schema(
      'Reads the state of one mission: status, liveness, turn, parent, and task. The prompt, the transcript, overrides, the owner, and the working directory are not returned.',
      { mission_id: missionId },
      ['mission_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.missions.detail(args.mission_id);
    },
  },
  {
    name: 'get_mission_message',
    ...schema(
      'Reads one message of a mission by event id. The text is cut at 20,000 characters. This is not the whole transcript.',
      {
        mission_id: missionId,
        event_id: { type: 'integer', minimum: 1, maximum: 999_999_999_999_999 },
      },
      ['mission_id', 'event_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.missions.message(args.mission_id, args.event_id);
    },
  },
  {
    name: 'send_mission',
    ...schema(
      'Sends a follow-up to a mission. The call counts against the host spawn window. No override is accepted.',
      { mission_id: missionId, message },
      ['mission_id', 'message'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const sent = await ctx.missions.sendTo(args.mission_id, args.message);
      return { mission_id: args.mission_id, resumed: sent.resumed === true };
    },
  },
  {
    name: 'steer_mission',
    ...schema(
      'Redirects the turn that is running. The call counts against the host spawn window. No override is accepted.',
      { mission_id: missionId, message },
      ['mission_id', 'message'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const steered = await ctx.missions.steer(args.mission_id, args.message);
      return { mission_id: args.mission_id, ok: true, method: steered.method };
    },
  },
  {
    name: 'interrupt_mission',
    ...schema(
      'Interrupts the turn of a mission. Does not count against the host spawn window.',
      { mission_id: missionId },
      ['mission_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const outcome = await ctx.missions.interrupt(args.mission_id);
      return { mission_id: args.mission_id, ...outcome };
    },
  },
  {
    name: 'stop_mission',
    ...schema(
      'Stops one mission. The call counts against the host spawn window.',
      { mission_id: missionId },
      ['mission_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const stopped = await ctx.missions.stop(args.mission_id);
      return { mission_id: args.mission_id, ok: true, outcome: stopped.outcome };
    },
  },
  {
    name: 'stop_scope',
    ...schema(
      'Stops one agent (a display name, including an ephemeral `_eph-…`) or one project. Pass exactly one of agent or project. `.`, `..`, and the route words active, spawn, ephemeral, and main are refused. The call counts against the host spawn window.',
      {
        agent: readAgent,
        project: { type: 'string', pattern: PROJECT_NAME.source },
      },
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.missions.stopScope(args);
    },
  },
  {
    name: 'launch_mission',
    ...schema(
      'Starts a mission on an agent that already exists: `_main`, or `<project>.<role>`. The host does not create the agent. Backend, model, skills, MCP servers, and permission are not parameters. The call counts against the host spawn window.',
      { agent: namedAgent, message },
      ['agent', 'message'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const missionId = await ctx.missions.spawn({ agent: args.agent, mission: args.message });
      const mission = await ctx.missions.detail(missionId);
      return {
        mission_id: missionId,
        agent: args.agent,
        status: mission.status ?? 'running',
      };
    },
  },
];

const HOST_TOOLS = MISSION_TOOLS.concat(
  KANBAN_TOOLS,
  ROSTER_TOOLS,
  AUTOMATION_TOOLS,
  PENDING_TOOLS,
  DECISION_TOOLS,
);
const HOST_BY_NAME = new Map(HOST_TOOLS.map((tool) => [tool.name, tool]));

/**
 * @param {{ all: Function }} router
 * @param {object} ctx
 */
export function mountMissionTools(router, ctx) {
  router.all('/mcp', (req, res, next) => handle(req, res, next, ctx));
}

/**
 * @param {object} req
 * @param {object} res
 * @param {Function} next
 * @param {object} ctx
 */
async function handle(req, res, next, ctx) {
  const target = hostTarget(req);
  if (!target) {
    next();
    return;
  }
  let auth;
  try {
    auth = await authenticate(req, ctx);
  } catch {
    next();
    return;
  }
  if (!auth || auth.ok === false) {
    next();
    return;
  }
  // Body was classified by `hostTarget` above. `initialize` is not a host
  // target and falls through; the plugin applies the same header rule.
  if (foreignOrigin(req) || protocolHeaderRejected(header(req, 'mcp-protocol-version'), target.message.method) || !acceptsJson(req)) {
    next();
    return;
  }
  try {
    if (target.kind === 'list') {
      res.status(200).json(rpcResult(target.message.id, { tools: publicTools() }));
      return;
    }
    const validated = validateInput(target.tool.inputSchema, target.arguments);
    if (!validated.ok) {
      res.status(200).json(rpcError(target.message.id, INVALID_PARAMS, validated.message));
      return;
    }
    const caller = target.tool.needsCaller ? await resolveCaller(req, ctx) : undefined;
    const data = await target.tool.run(ctx, validated.value, caller);
    res.status(200).json(rpcResult(target.message.id, toolSuccess(data)));
  } catch (err) {
    if (res.headersSent) return;
    const message = explainToolError(err);
    if (message) {
      res.status(200).json(rpcResult(target.message.id, toolError(message)));
      return;
    }
    res.status(200).json(rpcError(target.message.id, INTERNAL_ERROR, 'internal error'));
  }
}

/**
 * @param {object} req
 */
function hostTarget(req) {
  if (!req || req.method !== 'POST') return null;
  const message = classifyMessage(req.body);
  if (message.kind !== 'request') return null;
  if (message.method === 'tools/list') return { kind: 'list', message };
  if (message.method !== 'tools/call') return null;
  const params = message.params && typeof message.params === 'object'
    ? /** @type {Record<string, unknown>} */ (message.params)
    : null;
  const name = params && typeof params.name === 'string' ? params.name : '';
  const tool = HOST_BY_NAME.get(name);
  if (!tool) return null;
  return { kind: 'call', message, tool, arguments: params ? params.arguments : undefined };
}

/**
 * The OAuth subject already stored for this bearer, or the static bearer.
 * The token itself is not returned. A subject that is not a digest is ignored.
 * @param {object} req
 * @param {object} ctx
 * @returns {Promise<{ kind: 'static' } | { kind: 'oauth', subject: string } | { kind: 'none' }>}
 */
async function resolveCaller(req, ctx) {
  const presented = presentedBearer(req);
  if (!presented.present || !presented.token) return { kind: 'none' };
  let staticToken;
  try {
    staticToken = await ctx.secrets.get(BEARER_SECRET);
  } catch {
    staticToken = undefined;
  }
  if (typeof staticToken === 'string' && sameSecret(staticToken, presented.token)) {
    return { kind: 'static' };
  }
  let row;
  try {
    row = ctx.sql.prepare(
      `SELECT subject FROM oauth_tokens
       WHERE token_hash = ? AND kind = 'access' AND revoked_at IS NULL`,
    ).get(sha256Hex(presented.token));
  } catch {
    return { kind: 'none' };
  }
  const subject = row && typeof row.subject === 'string' ? row.subject : '';
  if (!/^[0-9a-f]{64}$/.test(subject)) return { kind: 'none' };
  return { kind: 'oauth', subject };
}

/**
 * @param {string} left
 * @param {string} right
 */
function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function publicTools() {
  const plugin = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const host = HOST_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return plugin.concat(host);
}

/**
 * @param {unknown} data
 */
function toolSuccess(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}
