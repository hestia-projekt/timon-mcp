/**
 * Project and agent tools for the standalone host. Mounted with the mission
 * tools on `POST /mcp`. `lib/` does not list them, and the manifest does not
 * gain `projects:read`, `agents:read`, or `messages:send`: this host does not
 * call `ctx.agents`.
 *
 * Reads are projections. `POST /api/messages` is the only write. `from_mission`
 * and `from_agent` are fixed by the host. Kind `request` wakes the recipient
 * and counts against the spawn window. Kind `msg` does not.
 */
import { MESSAGE_MAX_CHARS } from '../lib/constants.js';
import { AGENT_NAME_MAX, AGENT_PATH, MESSAGE_KIND_NAMES, NAMED_AGENT, PROJECT_NAME } from './names.js';

const namedAgent = { type: 'string', maxLength: AGENT_NAME_MAX, pattern: NAMED_AGENT.source };
const readAgent = { type: 'string', maxLength: AGENT_NAME_MAX, pattern: AGENT_PATH.source };
const projectName = { type: 'string', pattern: PROJECT_NAME.source };
const limit = { type: 'integer', minimum: 1, maximum: 100 };

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

export const ROSTER_TOOLS = [
  {
    name: 'list_projects',
    ...schema(
      'Lists projects on this Timon: slug, name, and status. Absolute paths are not returned. At most 100. No query is sent to the daemon.',
      { limit },
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const projects = await ctx.roster.listProjects(args);
      return { projects };
    },
  },
  {
    name: 'list_agents',
    ...schema(
      'Lists agents on this Timon, including an ephemeral `_eph-…`: name, role, project, and whether the agent is an orchestrator. Optional project filters after the read. The system prompt, privileged config, MCP servers, secrets, and skills are not returned. At most 100. No query is sent.',
      { project: projectName, limit },
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const agents = await ctx.roster.listAgents(args);
      return { agents };
    },
  },
  {
    name: 'get_agent',
    ...schema(
      'Reads one agent by a path-safe display name, including an ephemeral `_eph-…`: name, role, project, orchestrator, reports_to, and ephemeral. `.`, `..`, a percent-encoding, and the route words active, spawn, ephemeral, and main are refused. The system prompt, privileged config, MCP servers, secrets, and skills are not returned.',
      { agent: readAgent },
      ['agent'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.roster.read(args.agent);
    },
  },
  {
    name: 'send_agent',
    ...schema(
      'Sends a direct message to an agent that already exists (`_main` or `<project>.<role>`). The host sets from_mission and from_agent; those fields are not parameters. kind is msg (default, does not wake, does not count against the host spawn window) or request (wakes the recipient and counts against the window). The message is at most 20,000 characters and must not be a work return. No agent, file, skill, MCP server, or project is written.',
      {
        agent: namedAgent,
        message: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_CHARS },
        kind: { type: 'string', enum: [...MESSAGE_KIND_NAMES] },
      },
      ['agent', 'message'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.roster.send(args);
    },
  },
];
