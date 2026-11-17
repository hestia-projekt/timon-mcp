/**
 * `list_pending` for the standalone host. Mounted with the other host tools
 * on `POST /mcp`. `lib/` does not list it, and the manifest does not gain
 * `questions:read` or `events:subscribe`: this host does not call
 * `ctx.questions` or `ctx.events.on`.
 *
 * The tool does not answer a card. `POST /api/permissions/:id/resolve` is
 * not a route of this host.
 */
import { MISSION_ID } from './names.js';

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

export const PENDING_TOOLS = [
  {
    name: 'list_pending',
    ...schema(
      'Lists questions, kanban plans, and tool approvals waiting on a person. A question returns its text and options. A plan returns its title and parts. An approval returns the tool name and command, a preview of the input command string cut to 160 characters, with a bearer token and a hex run of 32 or more characters redacted. command is null when the input has no command string. No other input field is returned. The daemon fields shell_command, script_previews, tool_use_id, scopes, choices, and onPaste are not returned. Optional mission_id and limit (1 to 100, 50 when omitted) are applied after the read. No query is sent. The read stops at 1 MiB. This tool does not answer a card and does not count against the host spawn window.',
      {
        mission_id: { type: 'string', minLength: 1, maxLength: 200, pattern: MISSION_ID.source },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const cards = await ctx.pending.list(args);
      return { cards };
    },
  },
];
