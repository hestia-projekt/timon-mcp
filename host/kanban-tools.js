/**
 * Kanban tools for the standalone host. Mounted with the mission tools on
 * `POST /mcp`. `lib/` does not list them: inside the daemon the plugin still
 * creates only a chore for `<project>.main`.
 *
 * `done_comment` is the comment field `PUT /api/tasks/:id` accepts in release
 * 0.1.8. That release stores it only when the same request changes the status,
 * so a comment is a field of `move_task` and not its own tool.
 * `blocked_reason` is the reason stored for `BLOCKED`. There is no delete.
 */
import { MESSAGE_MAX_CHARS } from '../lib/constants.js';
import { AGENT_NAME_MAX, AGENT_PATH, MISSION_ID, NAMED_AGENT, PROJECT_NAME, TASK_STATUS_NAMES, TASK_TYPE_NAMES } from './names.js';

const taskId = { type: 'string', minLength: 1, maxLength: 200, pattern: MISSION_ID.source };
const namedAgent = { type: 'string', maxLength: AGENT_NAME_MAX, pattern: NAMED_AGENT.source };
const readAgent = { type: 'string', maxLength: AGENT_NAME_MAX, pattern: AGENT_PATH.source };
const projectName = { type: 'string', pattern: PROJECT_NAME.source };
const priority = { type: 'integer', minimum: -1000, maximum: 1000 };
const deps = {
  type: 'array',
  maxItems: 200,
  items: { type: 'string', minLength: 1, maxLength: 200, pattern: MISSION_ID.source },
};
const note = { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_CHARS };

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

export const KANBAN_TOOLS = [
  {
    name: 'list_all_tasks',
    ...schema(
      'Lists tasks on this Timon. Filters: project, agent (a display name, including an ephemeral `_eph-…`; `.`, `..`, and the route words active, spawn, ephemeral, and main are refused), status (PENDING, IN_PROGRESS, DONE, BLOCKED), and type (code, review, merge, research, doc, chore). Release 0.1.8 has no limit, project, agent, type, or pagination on GET /api/tasks: only status is sent, and project, agent, and type are applied after the body is read. A body past 8 MiB fails with too_large; pass status, or read one task with get_task. The description, the comment, overrides, and paths are not returned.',
      {
        project: projectName,
        agent: readAgent,
        status: { type: 'string', enum: [...TASK_STATUS_NAMES] },
        type: { type: 'string', enum: [...TASK_TYPE_NAMES] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const tasks = await ctx.kanban.listAll(args);
      return { tasks };
    },
  },
  {
    name: 'get_task',
    ...schema(
      'Reads one task: title, description, status, agent, project, type, priority, dependencies, base, blocked reason, and done comment. Overrides, attachments, and paths are not returned.',
      { task_id: taskId },
      ['task_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.kanban.read(args.task_id);
    },
  },
  {
    name: 'add_task',
    ...schema(
      'Creates a task of type code, review, merge, research, doc, or chore, on a project that already exists, assigned to an agent that already exists (`_main` or `<project>.<role>`). The host does not create the project or the agent. Optional base is a git ref. Optional deps is a list of task ids. Priority is an integer from -1000 to 1000. Backend, model, permission, skills, MCP servers, tools, and fallback are not parameters. The call counts against the host spawn window.',
      {
        project: projectName,
        title: { type: 'string', minLength: 1, maxLength: 500 },
        description: { type: 'string', maxLength: MESSAGE_MAX_CHARS },
        agent: namedAgent,
        type: { type: 'string', enum: [...TASK_TYPE_NAMES] },
        base: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9._/-]+$' },
        deps,
        priority,
      },
      ['project', 'title', 'agent', 'type'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.kanban.create(args);
    },
  },
  {
    name: 'update_task',
    ...schema(
      'Changes the title, description, priority, dependencies, or agent of one task. At least one of those fields. Does not change the status and does not count against the host spawn window. No override is accepted.',
      {
        task_id: taskId,
        title: { type: 'string', minLength: 1, maxLength: 500 },
        description: { type: 'string', maxLength: MESSAGE_MAX_CHARS },
        priority,
        deps,
        agent: namedAgent,
      },
      ['task_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      const taskId = args.task_id;
      const patch = { ...args };
      delete patch.task_id;
      return ctx.kanban.update(taskId, patch);
    },
  },
  {
    name: 'move_task',
    ...schema(
      'Sets the status of one task. BLOCKED requires reason (stored as blocked_reason). Optional comment is sent as done_comment in the same request. Release 0.1.8 stores that field only when the status value changes. Does not count against the host spawn window.',
      {
        task_id: taskId,
        status: { type: 'string', enum: [...TASK_STATUS_NAMES] },
        reason: note,
        comment: note,
      },
      ['task_id', 'status'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      const taskId = args.task_id;
      const patch = { ...args };
      delete patch.task_id;
      return ctx.kanban.move(taskId, patch);
    },
  },
];
