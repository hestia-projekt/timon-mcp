/**
 * Loopback daemon double. Contract tests point the host here.
 * It never reads a token file and never dials another process.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DIRECT_FROM_AGENT, DIRECT_FROM_MISSION } from '../../host/names.js';
import { CARD_ID } from '../../host/permissions.js';

/** Account id the fake `GET /api/auth/me` returns unless a test replaces it. */
export const FAKE_ACCOUNT_ID = 'operator-1';
/** Address on that payload. The host must not log it, store it, or return it. */
export const FAKE_ACCOUNT_EMAIL = 'secret-address@example.test';
/** Display name on that payload. Same rule as the address. */
export const FAKE_ACCOUNT_NAME = 'Secret Name';
/** Preference on that payload. Same rule as the address. */
export const FAKE_ACCOUNT_THEME = 'secret-theme';

/**
 * @param {object} [options]
 * @param {string} options.token Expected bearer. Compared, never logged.
 * @param {boolean} [options.echoToken] Reflect the token in extra JSON fields.
 * @param {string} [options.foreignId] A mission this host did not create.
 * @param {string} [options.foreignTaskId] A task this host did not create.
 */
export async function startFakeDaemon(options) {
  const token = options.token;
  const echoToken = options.echoToken === true;
  /** @type {Array<{ method: string, path: string, search: string, authorization: string, bodyText: string }>} */
  const requests = [];
  /** @type {Map<string, Record<string, unknown>>} */
  const missions = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const tasks = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const projects = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const agents = new Map();
  /** @type {Record<string, unknown>[]} */
  const messages = [];
  /** @type {{ status: number, body?: unknown, redirect?: boolean } | null} */
  let failNext = null;
  /** @type {unknown} */
  let taskListOverride = null;
  /** @type {unknown} */
  let pipelinesListOverride = null;
  /** @type {unknown} */
  let workflowGetOverride = null;
  /** @type {Map<string, Record<string, unknown>>} */
  const pipelines = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const pipelineRuns = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const workflows = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const workflowRuns = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const routines = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const permissions = new Map();
  /** @type {string | null} */
  let permissionsRaw = null;
  /**
   * `user` of `GET /api/auth/me`. `null` is a daemon token with no account.
   * `'omit'` drops the key. The address stays on the default user.
   * @type {Record<string, unknown> | null | 'omit'}
   */
  let accountUser = fakeAccountUser();
  /** @type {{ status: number, body?: unknown } | null} */
  let nextResolve = null;

  if (options.foreignId) {
    missions.set(options.foreignId, missionRow(options.foreignId, '_main', echoToken ? token : null));
  }
  projects.set('alpha', projectRow('alpha', { name: 'Alpha', status: 'active' }));
  projects.set('beta', projectRow('beta', { name: 'Beta', status: 'paused' }));
  projects.set('/secret/skip', projectRow('/secret/skip', { name: 'Nope', status: 'active' }));
  for (const agent of seededAgents()) agents.set(String(agent.name), agent);
  for (const pipeline of seededPipelines()) pipelines.set(String(pipeline.id), pipeline);
  pipelineRuns.set('prun-1', seededPipelineRun());
  for (const workflow of seededWorkflows()) workflows.set(String(workflow.id), workflow);
  for (const run of seededWorkflowRuns()) workflowRuns.set(String(run.id), run);
  for (const routine of seededRoutines()) routines.set(String(routine.id), routine);

  if (options.foreignTaskId) {
    tasks.set(options.foreignTaskId, taskRow(options.foreignTaskId, {
      title: 'Foreign task',
      description: 'SECRET DESCRIPTION',
      status: 'BLOCKED',
      agent_name: 'beta.reviewer',
      project: 'beta',
      type: 'review',
      priority: 4,
      deps: JSON.stringify(['dep-1']),
      base_branch: 'main',
      blocked_reason: 'needs a human',
      done_comment: 'SECRET COMMENT',
      created_at: 10,
      updated_at: 11,
    }));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    requests.push({
      method: req.method || 'GET',
      path: url.pathname,
      search: url.search,
      authorization,
      bodyText,
    });
    if (authorization !== `Bearer ${token}`) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    if (failNext) {
      const next = failNext;
      failNext = null;
      if (next.redirect) {
        res.writeHead(302, { location: '/' });
        res.end();
        return;
      }
      send(res, next.status, next.body ?? { error: 'failed' });
      return;
    }
    const method = req.method || 'GET';
    if (method === 'POST' && url.pathname === '/api/missions') {
      const body = parseBody(bodyText);
      const id = randomUUID();
      missions.set(id, missionRow(id, typeof body.agent === 'string' ? body.agent : '_main', echoToken ? token : null));
      const payload = { mission_id: id };
      if (echoToken) payload.leaked = token;
      send(res, 201, payload);
      return;
    }
    if (method === 'GET' && url.pathname === '/api/missions') {
      const agent = url.searchParams.get('agent');
      const project = url.searchParams.get('project');
      const status = url.searchParams.get('status');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      let rows = [...missions.values()];
      if (agent) rows = rows.filter((row) => row.agent_name === agent);
      else if (project) {
        rows = rows.filter((row) => row.agent_name === project || row.agent_name.startsWith(`${project}.`));
      }
      if (status) rows = rows.filter((row) => row.status === status);
      send(res, 200, { missions: rows.slice(0, Number.isInteger(limit) ? limit : 100) });
      return;
    }
    const messagePath = url.pathname.match(/^\/api\/missions\/([^/]+)\/messages\/([^/]+)$/);
    if (method === 'GET' && messagePath) {
      const id = messagePath[1];
      const eventId = messagePath[2];
      if (!missions.has(id)) {
        send(res, 404, { error: 'mission not found', code: 'mission_not_found' });
        return;
      }
      const stored = storedMessage(id, eventId);
      if (!stored) {
        send(res, 404, { error: 'no message with that id', code: 'message_not_found' });
        return;
      }
      send(res, 200, { mission_id: id, ...stored, payload: 'hidden-payload', mission: 'FULL PROMPT' });
      return;
    }
    const steerPath = url.pathname.match(/^\/api\/missions\/([^/]+)\/steer$/);
    if (method === 'POST' && steerPath) {
      if (!missions.has(steerPath[1])) {
        send(res, 404, { error: 'no running agent for that mission', code: 'mission_not_running' });
        return;
      }
      const body = parseBody(bodyText);
      if (typeof body.input !== 'string' || !body.input.trim()) {
        send(res, 400, { error: 'input (non-empty string) required' });
        return;
      }
      const payload = { ok: true, method: 'stdin' };
      if (echoToken) payload.leaked = token;
      send(res, 200, payload);
      return;
    }
    const interruptPath = url.pathname.match(/^\/api\/missions\/([^/]+)\/interrupt$/);
    if (method === 'POST' && interruptPath) {
      if (!missions.has(interruptPath[1])) {
        send(res, 404, { error: 'mission not found', code: 'mission_not_found' });
        return;
      }
      send(res, 200, {
        ok: true,
        status: 'interrupted',
        resumable: false,
        turnActive: true,
        backend: 'hidden-backend',
      });
      return;
    }
    const oneMission = url.pathname.match(/^\/api\/missions\/([^/]+)$/);
    if (method === 'DELETE' && oneMission) {
      const mission = missions.get(oneMission[1]);
      if (!mission || mission.status !== 'running') {
        send(res, 404, { error: 'no running agent for that mission', code: 'mission_not_running' });
        return;
      }
      mission.status = 'terminated';
      send(res, 200, { ok: true, outcome: 'killed' });
      return;
    }
    if (method === 'GET' && oneMission) {
      const mission = missions.get(oneMission[1]);
      if (!mission) {
        send(res, 404, { error: 'mission not found', code: 'mission_not_found' });
        return;
      }
      const payload = { ...mission };
      if (url.searchParams.get('view') !== 'status') payload.events = [{ payload: 'transcript' }];
      send(res, 200, payload);
      return;
    }
    if (method === 'POST' && url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/send')) {
      const id = url.pathname.slice('/api/agents/'.length, -'/send'.length);
      if (!missions.has(id) || id.includes('/')) {
        send(res, 404, { error: 'no running agent for that mission', code: 'mission_not_running' });
        return;
      }
      const payload = { ok: true, resumed: false };
      if (echoToken) payload.leaked = token;
      send(res, 200, payload);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/stop') {
      const body = parseBody(bodyText);
      const kind = typeof body.agent === 'string' ? 'agent' : 'project';
      const name = kind === 'agent' ? body.agent : body.project;
      send(res, 200, {
        ok: true,
        scope: { kind, name },
        agents: [name],
        missions: [{ id: 'foreignmission01', agent: '_main', outcome: 'killed' }],
        tasks: [{ id: 'task-1', title: 'SECRET TITLE', agent: name, status: 'PENDING' }],
        messages: [{ text: 'SECRET MESSAGE' }],
        workflows: [{ id: 'wf-1', workflow: 'hidden' }],
        triggers: [{ name: 'SECRET TRIGGER' }],
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/tasks') {
      if (taskListOverride !== null) {
        send(res, 200, taskListOverride);
        return;
      }
      const status = url.searchParams.get('status');
      let rows = [...tasks.values()];
      if (status) rows = rows.filter((row) => row.status === status);
      send(res, 200, { tasks: rows, view: 'board' });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/tasks') {
      const body = parseBody(bodyText);
      const id = randomUUID();
      const now = Date.now();
      const task = taskRow(id, {
        title: body.title ?? '',
        description: body.description ?? '',
        status: 'PENDING',
        agent_name: body.agent_name ?? null,
        project: body.project ?? null,
        type: body.type ?? null,
        priority: body.priority ?? 3,
        deps: JSON.stringify(Array.isArray(body.deps) ? body.deps : []),
        base_branch: typeof body.base === 'string' ? body.base : null,
        blocked_reason: null,
        done_comment: null,
        created_at: now,
        updated_at: now,
      });
      tasks.set(id, task);
      send(res, 201, { task });
      return;
    }
    if (method === 'PUT' && url.pathname.startsWith('/api/tasks/')) {
      const id = url.pathname.slice('/api/tasks/'.length);
      const task = tasks.get(id);
      if (!task || id.includes('/')) {
        send(res, 404, { error: 'not found', code: 'not_found' });
        return;
      }
      const body = parseBody(bodyText);
      if (typeof body.title === 'string') task.title = body.title;
      if (typeof body.description === 'string') task.description = body.description;
      if (typeof body.agent_name === 'string') task.agent_name = body.agent_name;
      if (Number.isInteger(body.priority)) task.priority = body.priority;
      if (Array.isArray(body.deps)) task.deps = JSON.stringify(body.deps);
      // Release 0.1.8 writes `done_comment` and `blocked_reason` only inside the
      // status transition. A comment alone, or the same status again, changes
      // neither. A real transition stores both, and an omitted one becomes null.
      if (typeof body.status === 'string' && body.status !== task.status) {
        task.status = body.status;
        task.done_comment = typeof body.done_comment === 'string' ? body.done_comment : null;
        task.blocked_reason = typeof body.blocked_reason === 'string' ? body.blocked_reason : null;
      }
      task.updated_at = Date.now();
      send(res, 200, { task });
      return;
    }
    if (method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
      const id = url.pathname.slice('/api/tasks/'.length);
      const task = tasks.get(id);
      if (!task || id.includes('/')) {
        send(res, 404, { error: 'not found', code: 'not_found' });
        return;
      }
      send(res, 200, { task });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/projects') {
      send(res, 200, {
        projects: [...projects.values()],
        workspaces: ['desk', '/secret/workspace'],
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/agents') {
      send(res, 200, {
        main_seat: { holder: '_main', empty: false, candidates: ['_main'], cwd: '/secret/seat' },
        agents: [...agents.values()].map((agent) => ({ ...agent, main: agent.name === '_main' })),
      });
      return;
    }
    const oneAgent = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (method === 'GET' && oneAgent) {
      const agent = agents.get(oneAgent[1]);
      if (!agent) {
        send(res, 404, { error: 'agent not found', code: 'agent_not_found' });
        return;
      }
      // `GET /api/agents/:name` in release 0.1.8 returns the agent, including
      // the system prompt, then adds the effective orchestration.
      send(res, 200, {
        ...agent,
        system_prompt: 'SECRET SYSTEM PROMPT',
        effective_orchestrates: ['alpha.coder'],
        orchestrates_source: 'flag',
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/messages') {
      const body = parseBody(bodyText);
      if (typeof body.to_agent !== 'string' || body.payload === undefined) {
        send(res, 400, { error: 'to_agent and payload required' });
        return;
      }
      if (typeof body.from_mission !== 'string' || !body.from_mission || typeof body.from_agent !== 'string' || !body.from_agent) {
        send(res, 400, { error: 'from_mission/from_agent required (header X-TIMON-Mission or body)' });
        return;
      }
      if (!agents.has(body.to_agent)) {
        send(res, 404, { error: `unknown agent: ${body.to_agent}` });
        return;
      }
      const knownMission = body.from_mission === DIRECT_FROM_MISSION || missions.has(body.from_mission);
      if (!knownMission) {
        send(res, 400, { error: `unknown mission: ${body.from_mission}` });
        return;
      }
      if (body.from_agent !== DIRECT_FROM_AGENT && body.from_mission === DIRECT_FROM_MISSION) {
        // The system mission's stored sender is the host identity. Another
        // from_agent is accepted when the mission exists, matching the route,
        // which does not check the sender name against a directory.
      }
      const row = {
        message_id: randomUUID(),
        created_at: Date.now(),
        to_agent: body.to_agent,
        from_mission: body.from_mission,
        from_agent: body.from_agent,
        kind: typeof body.kind === 'string' ? body.kind : 'msg',
        payload: body.payload,
      };
      messages.push(row);
      send(res, 201, { message_id: row.message_id, created_at: row.created_at });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/permissions') {
      // Release 0.1.8 `GET /api/permissions`: `{ pending }` of `viewOf` cards.
      if (permissionsRaw !== null) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(permissionsRaw);
        return;
      }
      send(res, 200, { pending: [...permissions.values()] });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/auth/me') {
      // Release 0.1.8 `mePayload`: the address is on `user`. The host may
      // keep `user.id` and must drop everything else.
      send(res, 200, fakeMe(accountUser));
      return;
    }
    if (method === 'POST' && url.pathname.startsWith('/api/permissions/') && url.pathname.endsWith('/resolve')) {
      const id = url.pathname.slice('/api/permissions/'.length, -'/resolve'.length);
      if (!CARD_ID.test(id)) {
        send(res, 500, { error: 'unexpected route' });
        return;
      }
      // Release 0.1.8: an unknown card is 404 `{ error, code }`, not nested.
      if (!permissions.has(id)) {
        send(res, 404, {
          error: 'permission request not found (already resolved or expired)',
          code: 'permission_request_gone',
        });
        return;
      }
      const override = nextResolve;
      nextResolve = null;
      if (override && override.status !== 200) {
        send(res, override.status, override.body ?? { error: 'failed' });
        return;
      }
      permissions.delete(id);
      send(res, 200, override && override.body !== undefined ? override.body : { ok: true });
      return;
    }
    if (serveAutomation(method, url.pathname, bodyText, res, {
      pipelines,
      pipelineRuns,
      workflows,
      workflowRuns,
      routines,
      pipelinesListOverride,
      workflowGetOverride,
    })) return;
    send(res, 500, { error: 'unexpected route' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') {
    server.close();
    throw new Error('fake daemon failed to bind');
  }

  return {
    origin: `http://127.0.0.1:${bound.port}`,
    requests,
    missions,
    tasks,
    projects,
    agents,
    messages,
    pipelines,
    pipelineRuns,
    workflows,
    workflowRuns,
    routines,
    permissions,
    /**
     * @param {{ status: number, body?: unknown, redirect?: boolean }} next
     */
    failNext(next) { failNext = next; },
    /**
     * Body of the next `GET /api/tasks`, instead of the stored rows.
     * `null` restores the stored rows. The status query is still recorded.
     * @param {unknown} body
     */
    setTaskList(body) { taskListOverride = body; },
    /**
     * Body of the next `GET /api/pipelines`, instead of the stored rows.
     * `null` restores the stored rows.
     * @param {unknown} body
     */
    setPipelinesList(body) { pipelinesListOverride = body; },
    /**
     * Body of the next `GET /api/workflows/:id`, instead of the stored row.
     * `null` restores the stored row. The path is still matched.
     * @param {unknown} body
     */
    setWorkflowGet(body) { workflowGetOverride = body; },
    /**
     * Raw body of `GET /api/permissions`, instead of `{ pending }`.
     * `null` restores the stored cards.
     * @param {string | null} body
     */
    setPermissionsRaw(body) { permissionsRaw = body; },
    /**
     * `user` of the next `GET /api/auth/me`. `null` is a daemon token with
     * no account. `'omit'` removes the key. The default is restored by
     * passing the object `fakeAccountUser()` returns.
     * @param {Record<string, unknown> | null | 'omit'} user
     */
    setAccount(user) { accountUser = user; },
    /**
     * Next `POST /api/permissions/:id/resolve`, once. Status 200 deletes the
     * card and returns `body` (default `{ ok: true }`). Any other status
     * leaves the card in place.
     * @param {{ status: number, body?: unknown } | null} next
     */
    setNextResolve(next) { nextResolve = next; },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}

/**
 * A task row plus the fields the host must not return.
 * @param {string} id
 * @param {Record<string, unknown>} fields
 */
/**
 * A project row as `GET /api/projects` builds it from `readMeta`, plus `cwd`.
 * @param {string} slug
 * @param {{ name: string, status: string }} fields
 */
function projectRow(slug, fields) {
  return {
    slug,
    name: fields.name,
    color: '#112233',
    icon: '/api/uploads/project.png',
    workspace: 'desk',
    cwd: `/secret/${slug}`,
    speech: 'SECRET SPEECH',
    kind: 'code',
    status: fields.status,
    last_activity: 10,
    grepai_watch: true,
  };
}

/**
 * Agents the list and the detail routes return in release 0.1.8.
 * The list has no system-prompt text. The detail handler adds it.
 * Names that are not `_main` or `<project>.<role>` are here so a projection
 * that copies every row would leak them.
 */
function seededAgents() {
  return [
    agentRow('_main', { role: 'orchestrator', project: null, orchestrator: true, reports_to: null }),
    agentRow('alpha.coder', {
      role: 'coder',
      project: 'alpha',
      orchestrator: false,
      reports_to: 'alpha.orchestrator',
    }),
    agentRow('alpha.orchestrator', {
      role: 'orchestrator',
      project: 'alpha',
      orchestrator: true,
      reports_to: '_main',
    }),
    agentRow('beta.reviewer', {
      role: 'reviewer',
      project: '/secret/beta',
      orchestrator: false,
      reports_to: '/secret/lead',
    }),
    agentRow('not-named', {
      role: 'coder',
      project: 'alpha',
      orchestrator: false,
      reports_to: null,
      system_prompt: 'LEAKED NAME PROMPT',
    }),
  ];
}

/**
 * @param {string} name
 * @param {{ role: string, project: string | null, orchestrator: boolean, reports_to: string | null, system_prompt?: string }} fields
 */
function agentRow(name, fields) {
  return {
    name,
    backend: 'hidden-backend',
    cwd: `/secret/${name}`,
    browser_profile_id: 'secret-profile',
    model: 'hidden-model',
    permission_mode: 'bypass',
    allowed_tools: ['secret_tool'],
    disallowed_tools: ['secret_denied'],
    skills: ['secret-skill'],
    mcp_servers: [{ command: '/secret/mcp', env: { TOKEN: 'SECRET TOKEN' } }],
    excluded_mcp_servers: ['secret-mcp'],
    has_system_prompt: true,
    reports_to: fields.reports_to,
    team: 'secret-team',
    project: fields.project,
    memory_scope: 'NONE',
    ephemeral: false,
    orchestrator: fields.orchestrator,
    orchestrates: ['alpha.coder'],
    global_context: false,
    emoji: null,
    color: '#abcdef',
    icon_url: '/api/uploads/icon.png',
    look: { src: '/secret/look' },
    avatar: null,
    role: fields.role,
    role_emoji: null,
    directives: 'SECRET DIRECTIVE',
    reasoning_effort: 'high',
    created_by: 'plugin:other',
    api_key: 'SECRET KEY',
    ...(fields.system_prompt ? { system_prompt: fields.system_prompt } : {}),
  };
}

/**
 * A task row plus the fields the host must not return.
 * @param {string} id
 * @param {Record<string, unknown>} fields
 */
function taskRow(id, fields) {
  return {
    id,
    effective_backend: 'hidden-backend',
    effective_model: 'hidden-model',
    backend_override: 'hidden-backend',
    fallback_backend_override: 'hidden-fallback',
    permission_mode_override: 'auto',
    extra_skills: ['hidden-skill'],
    worktree_path: '/secret/worktree',
    owner: { id: 'hidden-owner' },
    attachments: [{ name: 'hidden' }],
    ...fields,
  };
}

/**
 * @param {string} id
 * @param {string} agent
 * @param {string | null} echoed
 */
function missionRow(id, agent, echoed) {
  return {
    id,
    agent_name: agent,
    status: 'running',
    title: echoed,
    summary: echoed,
    mission: 'FULL PROMPT',
    started_at: 1_700_000_000_000,
    ended_at: null,
    exit_code: null,
    running: true,
    turn_active: false,
    turn_complete: true,
    turn_preparing: false,
    liveness: 'idle',
    interrupted_reason: null,
    source_channel: 'user',
    origin: 'user',
    parent_mission_id: null,
    parent_agent: null,
    task_id: null,
    routine_id: null,
    pending_action_at: null,
    pending_action_id: null,
    backend_override: 'hidden-backend',
    model_override: 'hidden-model',
    cwd_override: '/secret/cwd',
    owner: { id: 'user-1', name: 'hidden-owner' },
    tokens_in: 9,
    children: [],
  };
}

/**
 * @param {string} missionId
 * @param {string} eventId
 */
function storedMessage(missionId, eventId) {
  if (eventId === '1') {
    return { event_id: 1, role: 'agent', timestamp: 10, text: `hello from ${missionId}` };
  }
  if (eventId === '2') {
    return { event_id: 2, role: 'user', timestamp: 11, text: `${'a'.repeat(20_000)}TAIL` };
  }
  return null;
}

/**
 * `toPublicUser` fields the host must not return, plus the id it may keep.
 */
function fakeAccountUser() {
  return {
    id: FAKE_ACCOUNT_ID,
    email: FAKE_ACCOUNT_EMAIL,
    name: FAKE_ACCOUNT_NAME,
    avatar_url: null,
    is_superadmin: true,
  };
}

/**
 * Release 0.1.8 `mePayload`, plus the two setup flags the route adds.
 * @param {Record<string, unknown> | null | 'omit'} user
 */
function fakeMe(user) {
  /** @type {Record<string, unknown>} */
  const body = {
    needsSetup: false,
    setupRequiresToken: false,
    prefs: { theme: FAKE_ACCOUNT_THEME, scheme: 'dark' },
    can: {
      'projects:manage': true,
      'agents:manage': true,
      'agents:privileged-config': true,
      'providers:manage': true,
      'providers:accounts': true,
    },
    welcome: null,
    setupRequiresLicense: false,
    setupRequiresEmailCode: false,
  };
  if (user !== 'omit') body.user = user;
  return body;
}

/**
 * @param {string} text
 */
function parseBody(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Pipelines as `GET /api/pipelines` returns them in release 0.1.8 (`asPipeline`):
 * `definition` is already parsed, and the row still carries the owner and the
 * step prompts and overrides. `pipe-2` keeps `definition` as a string so the
 * host projection is checked on both forms. Order is `updated_at DESC`.
 */
function seededPipelines() {
  return [
    {
      id: 'pipe-1',
      name: 'Feature flow',
      description: 'Plan and code',
      definition: {
        steps: [
          {
            id: 'plan',
            agent: 'alpha.researcher',
            type: 'research',
            prompt: 'Plan {{input.feature}}\nSECRET PIPELINE PROMPT',
            priority: 2,
            deps_on: [],
            model_override: 'hidden-model',
            extra_skills: ['secret-skill'],
            permission_mode_override: 'bypass',
          },
          {
            id: 'code',
            agent: 'alpha.coder',
            type: 'code',
            prompt: 'Code {{ input.feature }}',
            deps_on: ['plan'],
            extra_mcp_servers: ['secret-mcp'],
            extra_allowed_tools: ['secret_tool'],
          },
        ],
      },
      owner_user_id: 'hidden-owner',
      created_at: 10,
      updated_at: 11,
    },
    {
      id: 'pipe-2',
      name: 'Spare',
      description: null,
      definition: JSON.stringify({
        steps: [
          {
            id: 'only',
            agent: 'alpha.coder',
            type: 'chore',
            prompt: 'SECRET PIPELINE PROMPT {{input.spare}}',
            deps_on: [],
          },
        ],
      }),
      owner_user_id: 'hidden-owner',
      created_at: 1,
      updated_at: 1,
    },
  ];
}

/**
 * `GET /api/pipelines/runs/:runId` (`getRunStatus`), plus step fields the
 * release does not send. The host must drop `input`, `description`, and
 * `model_override`.
 */
function seededPipelineRun() {
  return {
    run: {
      run_id: 'prun-1',
      pipeline_id: 'pipe-1',
      pipeline_name: 'Feature flow',
      started_at: 100,
      input: { feature: 'SECRET INPUT' },
    },
    steps: [
      {
        step_id: 'plan',
        task_id: 'task-plan',
        title: 'Feature flow · plan',
        agent: 'alpha.researcher',
        type: 'research',
        status: 'PENDING',
        mission_id: null,
        description: 'SECRET PIPELINE PROMPT',
        model_override: 'hidden-model',
      },
      {
        step_id: 'code',
        task_id: 'task-code',
        title: 'Feature flow · code',
        agent: 'alpha.coder',
        type: 'code',
        status: 'PENDING',
        mission_id: 'mission-code-1',
        description: 'SECRET PIPELINE PROMPT',
        model_override: 'hidden-model',
      },
    ],
  };
}

/**
 * Workflow rows as stored (`draft` is a JSON string). The list route spreads
 * the row, so the draft leaves the daemon. The host must not return it.
 */
function seededWorkflows() {
  return [
    {
      id: 'wf-1',
      slug: 'feature.flow',
      name: 'Feature',
      description: 'A workflow',
      project: 'alpha',
      owner_user_id: 'hidden-owner',
      draft: JSON.stringify({
        nodes: [
          { id: 'start', type: 'trigger.manual', config: { prompt: 'SECRET WORKFLOW DRAFT' } },
          { id: 'agent', type: 'agent', config: { prompt: 'SECRET WORKFLOW DRAFT', script: 'SECRET WORKFLOW DRAFT' } },
        ],
      }),
      published_version: 1,
      enabled: 1,
      created_at: 20,
      updated_at: 21,
      agent_name: 'alpha.orchestrator',
    },
    {
      id: 'wf-2',
      slug: 'other',
      name: 'Other',
      description: null,
      project: 'beta',
      owner_user_id: 'hidden-owner',
      draft: JSON.stringify({
        nodes: [
          { id: 'script', type: 'script', config: { code: 'SECRET WORKFLOW DRAFT' } },
        ],
      }),
      published_version: null,
      enabled: 0,
      created_at: 1,
      updated_at: 2,
      agent_name: 'beta.coder',
    },
  ];
}

/**
 * `workflow_runs` columns. `context`, `input`, and `trigger` are JSON text
 * and stay on the row. List order is `started_at DESC`.
 */
function seededWorkflowRuns() {
  return [
    {
      id: 'run-wf-1',
      workflow_id: 'wf-1',
      version: 1,
      status: 'running',
      trigger: JSON.stringify({ kind: 'api', note: 'SECRET TRIGGER' }),
      input: JSON.stringify({ feature: 'SECRET INPUT' }),
      context: JSON.stringify({ note: 'SECRET WORKFLOW CONTEXT' }),
      error: null,
      started_at: 30,
      ended_at: null,
      owner_user_id: 'hidden-owner',
      tokens_in: 4,
      tokens_out: 5,
      cost_usd: 0.01,
    },
    {
      id: 'run-wf-old',
      workflow_id: 'wf-1',
      version: 1,
      status: 'ok',
      trigger: JSON.stringify({ kind: 'api', note: 'SECRET TRIGGER' }),
      input: JSON.stringify({ feature: 'SECRET INPUT' }),
      context: JSON.stringify({ note: 'SECRET WORKFLOW CONTEXT' }),
      error: null,
      started_at: 10,
      ended_at: 12,
      owner_user_id: 'hidden-owner',
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: 0,
    },
  ];
}

/**
 * Routine view (`ROUTINE_VIEW`): the prompt and the owner are on the row.
 * `routine-2` keeps a project the host must not return, and a `next_run_at`
 * while it is disabled.
 */
function seededRoutines() {
  return [
    {
      id: 'routine-1',
      name: 'Nightly',
      agent_name: 'alpha.coder',
      prompt: 'SECRET ROUTINE PROMPT',
      task_type: 'chore',
      cron_expr: '30 3 * * *',
      enabled: 1,
      project: 'alpha',
      owner_user_id: 'hidden-owner',
      last_run_at: 40,
      next_run_at: 50,
      created_at: 5,
      updated_at: 6,
    },
    {
      id: 'routine-2',
      name: 'Hidden',
      agent_name: 'beta.coder',
      prompt: 'SECRET ROUTINE PROMPT',
      task_type: 'code',
      cron_expr: '0 4 * * *',
      enabled: 0,
      project: '/secret/beta',
      owner_user_id: 'hidden-owner',
      last_run_at: null,
      next_run_at: 60,
      created_at: 1,
      updated_at: 2,
    },
  ];
}

/**
 * Routes of release 0.1.8 that the host is allowed to call, plus the secret
 * fields those responses carry. Returns false when the path is not one of them.
 * @param {string} method
 * @param {string} pathname
 * @param {string} bodyText
 * @param {import('node:http').ServerResponse} res
 * @param {object} store
 */
function serveAutomation(method, pathname, bodyText, res, store) {
  const {
    pipelines, pipelineRuns, workflows, workflowRuns, routines,
    pipelinesListOverride, workflowGetOverride,
  } = store;

  if (method === 'GET' && pathname === '/api/pipelines') {
    if (pipelinesListOverride !== null) {
      send(res, 200, pipelinesListOverride);
      return true;
    }
    const rows = [...pipelines.values()].sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
    send(res, 200, { pipelines: rows });
    return true;
  }

  const runStatus = pathname.match(/^\/api\/pipelines\/runs\/([^/]+)$/);
  if (method === 'GET' && runStatus) {
    const run = pipelineRuns.get(runStatus[1]);
    if (!run) {
      send(res, 404, { error: 'run not found' });
      return true;
    }
    send(res, 200, run);
    return true;
  }

  const pipeRun = pathname.match(/^\/api\/pipelines\/([^/]+)\/run$/);
  if (method === 'POST' && pipeRun) {
    const pipeline = pipelines.get(pipeRun[1]);
    if (!pipeline) {
      send(res, 404, { error: 'pipeline not found', code: 'pipeline_not_found' });
      return true;
    }
    const body = parseBody(bodyText);
    const runId = `prun-${pipelineRuns.size + 1}`;
    const startedAt = 1_700_000_000_100;
    const payload = {
      run_id: runId,
      pipeline_id: pipeline.id,
      started_at: startedAt,
      steps: [
        { step_id: 'plan', task_id: 'task-plan', prompt: 'SECRET PIPELINE PROMPT', model_override: 'hidden-model' },
        { step_id: 'code', task_id: 'task-code', prompt: 'SECRET PIPELINE PROMPT' },
      ],
    };
    pipelineRuns.set(runId, {
      run: {
        run_id: runId,
        pipeline_id: pipeline.id,
        pipeline_name: pipeline.name,
        started_at: startedAt,
        input: body.input ?? null,
      },
      steps: [
        {
          step_id: 'plan',
          task_id: 'task-plan',
          title: `${pipeline.name} · plan`,
          agent: 'alpha.researcher',
          type: 'research',
          status: 'PENDING',
          mission_id: null,
          description: 'SECRET PIPELINE PROMPT',
          model_override: 'hidden-model',
        },
        {
          step_id: 'code',
          task_id: 'task-code',
          title: `${pipeline.name} · code`,
          agent: 'alpha.coder',
          type: 'code',
          status: 'PENDING',
          mission_id: 'mission-code-1',
          description: 'SECRET PIPELINE PROMPT',
          model_override: 'hidden-model',
        },
      ],
    });
    send(res, 201, payload);
    return true;
  }

  const onePipe = pathname.match(/^\/api\/pipelines\/([^/]+)$/);
  if (method === 'GET' && onePipe) {
    const pipeline = pipelines.get(onePipe[1]);
    if (!pipeline) {
      send(res, 404, { error: 'pipeline not found', code: 'pipeline_not_found' });
      return true;
    }
    send(res, 200, { pipeline });
    return true;
  }

  if (method === 'GET' && pathname === '/api/workflows') {
    const rows = [...workflows.values()].sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
    send(res, 200, {
      workflows: rows.map((workflow) => {
        const runs = runsOf(workflowRuns, workflow.id);
        const last = runs[0];
        return {
          ...workflow,
          run_count: runs.length,
          last_run: last
            ? { id: last.id, status: last.status, started_at: last.started_at, ended_at: last.ended_at }
            : null,
        };
      }),
    });
    return true;
  }

  const wfRuns = pathname.match(/^\/api\/workflows\/([^/]+)\/runs$/);
  if (method === 'GET' && wfRuns) {
    const workflow = findWorkflow(workflows, wfRuns[1]);
    if (!workflow) {
      send(res, 404, { error: 'not found', code: 'not_found' });
      return true;
    }
    send(res, 200, { runs: runsOf(workflowRuns, workflow.id) });
    return true;
  }

  const wfRun = pathname.match(/^\/api\/workflows\/([^/]+)\/run$/);
  if (method === 'POST' && wfRun) {
    const workflow = findWorkflow(workflows, wfRun[1]);
    if (!workflow) {
      send(res, 404, { error: 'not found', code: 'not_found' });
      return true;
    }
    if (!workflow.published_version) {
      send(res, 400, { error: 'workflow has no published version' });
      return true;
    }
    const body = parseBody(bodyText);
    const id = `run-made-${workflowRuns.size + 1}`;
    const row = {
      id,
      workflow_id: workflow.id,
      version: workflow.published_version,
      status: 'running',
      trigger: JSON.stringify({ kind: 'api', note: 'SECRET TRIGGER' }),
      input: JSON.stringify(body.input ?? {}),
      context: JSON.stringify({ note: 'SECRET WORKFLOW CONTEXT', draft: body.draft ?? null }),
      error: null,
      started_at: 1_700_000_000_200,
      ended_at: null,
      owner_user_id: 'hidden-owner',
      tokens_in: 4,
      tokens_out: 5,
      cost_usd: 0.01,
    };
    workflowRuns.set(id, row);
    send(res, 201, { run: row });
    return true;
  }

  const oneWf = pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if (method === 'GET' && oneWf) {
    if (workflowGetOverride !== null) {
      send(res, 200, workflowGetOverride);
      return true;
    }
    const workflow = findWorkflow(workflows, oneWf[1]);
    if (!workflow) {
      send(res, 404, { error: 'not found', code: 'not_found' });
      return true;
    }
    send(res, 200, { workflow });
    return true;
  }

  if (method === 'GET' && pathname === '/api/routines') {
    const rows = [...routines.values()].sort((a, b) => Number(b.created_at) - Number(a.created_at));
    send(res, 200, { routines: rows });
    return true;
  }

  const oneRoutine = pathname.match(/^\/api\/routines\/([^/]+)$/);
  if (method === 'GET' && oneRoutine) {
    const routine = routines.get(oneRoutine[1]);
    if (!routine) {
      send(res, 404, { error: 'not found', code: 'not_found' });
      return true;
    }
    send(res, 200, { routine });
    return true;
  }

  return false;
}

/**
 * @param {Map<string, Record<string, unknown>>} workflows
 * @param {string} key
 */
function findWorkflow(workflows, key) {
  const direct = workflows.get(key);
  if (direct) return direct;
  for (const row of workflows.values()) {
    if (row.slug === key) return row;
  }
  return undefined;
}

/**
 * @param {Map<string, Record<string, unknown>>} workflowRuns
 * @param {string} workflowId
 */
function runsOf(workflowRuns, workflowId) {
  return [...workflowRuns.values()]
    .filter((run) => run.workflow_id === workflowId)
    .sort((a, b) => Number(b.started_at) - Number(a.started_at));
}
