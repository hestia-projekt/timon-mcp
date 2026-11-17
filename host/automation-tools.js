/**
 * Pipeline, workflow, and routine tools for the standalone host. Mounted with
 * the mission tools on `POST /mcp`. `lib/` does not list them, and the manifest
 * does not gain `pipelines:read`, `pipelines:run`, `workflows:read`,
 * `workflows:run`, or `routines:read`: this host does not call `ctx.pipelines`.
 *
 * There is no create, update, delete, publish, or enable. A run sends the
 * caller's input object and nothing else, and it counts against the host
 * spawn window.
 */
import { AUTOMATION_ID, PROJECT_NAME } from './names.js';

const id = { type: 'string', pattern: AUTOMATION_ID.source };
const projectName = { type: 'string', pattern: PROJECT_NAME.source };
const limit = { type: 'integer', minimum: 1, maximum: 100 };
const input = {
  type: 'object',
  description: 'Run inputs only. Backend, model, permission, draft, and overrides are refused.',
};

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

export const AUTOMATION_TOOLS = [
  {
    name: 'list_pipelines',
    ...schema(
      'Lists pipelines: id, name, description, the {{input.name}} keys, and the steps (id, agent, type, deps_on, priority). Prompts, overrides, and the owner are not returned. Release 0.1.8 has no pagination: the host reads at most 8 MiB and returns at most 100 rows (50 when limit is omitted). No query is sent.',
      { limit },
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const pipelines = await ctx.automation.listPipelines(args);
      return { pipelines };
    },
  },
  {
    name: 'get_pipeline',
    ...schema(
      'Reads one pipeline. Same projection as the list: no prompt, no override, no owner. The input keys are returned so a run knows what to pass.',
      { pipeline_id: id },
      ['pipeline_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.automation.readPipeline(args.pipeline_id);
    },
  },
  {
    name: 'run_pipeline',
    ...schema(
      'Runs a pipeline. input is a JSON object of at most 64 KiB and is the only field sent. Backend, model, permission, draft, and overrides are refused, including as keys of input. The call counts against the host spawn window. The result is the run id and the step task ids. Prompts are not returned.',
      { pipeline_id: id, input },
      ['pipeline_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.automation.runPipeline(args.pipeline_id, args.input);
    },
  },
  {
    name: 'get_pipeline_run',
    ...schema(
      'Reads one pipeline run: the pipeline, when it started, and each step\'s task, agent, type, and status. The run input and the step prompts are not returned.',
      { run_id: id },
      ['run_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.automation.readPipelineRun(args.run_id);
    },
  },
  {
    name: 'list_workflows',
    ...schema(
      'Lists workflows: id, slug, name, description, project, enabled, published version, agent, and the last run\'s id and status. The draft (prompts, scripts, node config) and the owner are not returned. Optional project is applied after the read. No query is sent. At most 8 MiB, then at most 100 rows (50 when limit is omitted).',
      { project: projectName, limit },
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const workflows = await ctx.automation.listWorkflows(args);
      return { workflows };
    },
  },
  {
    name: 'get_workflow',
    ...schema(
      'Reads one workflow by id or slug. Adds the node id and type. Node config, prompts, scripts, and the owner are not returned. runs, node-types, import, and hooks are route words, not ids.',
      { workflow_id: id },
      ['workflow_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.automation.readWorkflow(args.workflow_id);
    },
  },
  {
    name: 'list_workflow_runs',
    ...schema(
      'Lists the runs of one workflow: id, version, status, start, end, and error. Context, input, trigger, and owner are not returned. No query is sent. At most 8 MiB, then at most 100 rows (50 when limit is omitted).',
      { workflow_id: id, limit },
      ['workflow_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const opts = args.limit === undefined ? {} : { limit: args.limit };
      const runs = await ctx.automation.listWorkflowRuns(args.workflow_id, opts);
      return { runs };
    },
  },
  {
    name: 'run_workflow',
    ...schema(
      'Runs the published version of a workflow. input is a JSON object of at most 64 KiB and is the only field sent. draft is refused: the unpublished graph is not run. Backend, model, permission, and overrides are refused. The call counts against the host spawn window. Context and input are not returned.',
      { workflow_id: id, input },
      ['workflow_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.automation.runWorkflow(args.workflow_id, args.input);
    },
  },
  {
    name: 'list_routines',
    ...schema(
      'Lists routines: id, name, agent, task type, cron, enabled, project, and the run times. The prompt and the owner are not returned. Nothing here enables or disables a routine. Optional project is applied after the read. No query is sent. At most 8 MiB, then at most 100 rows (50 when limit is omitted).',
      { project: projectName, limit },
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    async run(ctx, args) {
      const routines = await ctx.automation.listRoutines(args);
      return { routines };
    },
  },
  {
    name: 'get_routine',
    ...schema(
      'Reads one routine. Same projection as the list: no prompt, no owner. Does not enable or disable it.',
      { routine_id: id },
      ['routine_id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return ctx.automation.readRoutine(args.routine_id);
    },
  },
];
