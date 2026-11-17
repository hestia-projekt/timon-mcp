/**
 * Names the host is willing to put on a daemon path or in a daemon body.
 * The project body is `PROJECT_PATTERN` without its anchors, so a change of
 * that pattern moves this check with it.
 */
import { BACKGROUND_IDENTITY, PILOT_AGENT, PROJECT_PATTERN } from '../lib/constants.js';

const PROJECT_BODY = PROJECT_PATTERN.slice(1, -1);

/** `<project>` as the plugin already spells it. */
export const PROJECT_NAME = new RegExp(`^${PROJECT_BODY}$`);

/**
 * An agent the operator already has: the pilot `_main`, or `<project>.<role>`.
 * One dot. The host does not create the agent.
 */
export const NAMED_AGENT = new RegExp(`^(?:${PILOT_AGENT}|${PROJECT_BODY}\\.${PROJECT_BODY})$`);

/** Mission ids this host will place in a path. Dots are out: they are route words. */
export const MISSION_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Positive integer, at most 15 digits, so it stays inside `MAX_SAFE_INTEGER`. */
export const EVENT_ID = /^[1-9][0-9]{0,14}$/;

export const LIST_STATUS = /^(?:running|completed|failed|terminated)$/;

/** 1..100, no leading zero. */
export const LIST_LIMIT = /^(?:[1-9][0-9]?|100)$/;

/** Statuses `PUT /api/tasks/:id` accepts. `TODO` is the deprecated alias and is not sent. */
export const TASK_STATUS_NAMES = Object.freeze(['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED']);

/** Types `POST /api/tasks` accepts on this release. */
export const TASK_TYPE_NAMES = Object.freeze(['code', 'review', 'merge', 'research', 'doc', 'chore']);

export const TASK_STATUS = new RegExp(`^(?:${TASK_STATUS_NAMES.join('|')})$`);

export const TASK_TYPE = new RegExp(`^(?:${TASK_TYPE_NAMES.join('|')})$`);

/**
 * Path words the daemon serves under `/api/missions/<word>` as their own
 * routes. They must not be sent as a mission id: `latest` and `search` are
 * not the mission whose id is that word.
 */
export const RESERVED_MISSION_IDS = new Set(['latest', 'search', 'delegate']);

/**
 * Path words the daemon serves under `/api/agents/<word>` as their own routes
 * (`active`, `spawn`, `ephemeral`, `main`). They are not an agent name.
 */
export const RESERVED_AGENT_WORDS = new Set(['active', 'spawn', 'ephemeral', 'main']);

/**
 * An id this host will place under `/api/pipelines`, `/api/workflows`, or
 * `/api/routines`. A workflow slug may contain dots (`feature.flow`). `..` is
 * still a path, and a leading dot is not an id.
 */
export const AUTOMATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * First segments the daemon serves under `/api/workflows/<word>` as their own
 * routes. `runs` is `GET /api/workflows/runs` and `GET /api/workflows/runs/:runId`
 * (the run detail, which carries the definition). `node-types` and `import`
 * are their own routes. `hooks` is the retired token URL. None of them is a
 * workflow id.
 */
export const RESERVED_WORKFLOW_IDS = new Set(['runs', 'node-types', 'import', 'hooks']);

/**
 * `from_mission` the host sends on `POST /api/messages`.
 * Release 0.1.8 `dist/notify.js` `SYSTEM_MISSION_ID`. The caller does not choose it.
 */
export const DIRECT_FROM_MISSION = '00000000-0000-4000-8000-0000000000aa';

/**
 * `from_agent` the host sends on `POST /api/messages`.
 * The plugin background identity. The caller does not choose it.
 */
export const DIRECT_FROM_AGENT = BACKGROUND_IDENTITY;

/** Kinds `POST /api/messages` may carry. `request` is the one that wakes the recipient. */
export const MESSAGE_KIND_NAMES = Object.freeze(['msg', 'request']);

/** Payload kinds `returnPayloadOf` treats as a work return, which wakes the recipient. */
const WORK_RETURN_KINDS = new Set(['task_closed', 'mission_complete']);

/**
 * True when a message body would wake an agent even with kind `msg`.
 * Same rule as `returnPayloadOf` in release 0.1.8: JSON object, `kind` one of
 * `task_closed` or `mission_complete`.
 * @param {unknown} text
 */
export function isWorkReturnPayload(text) {
  if (typeof text !== 'string') return false;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return WORK_RETURN_KINDS.has(/** @type {{ kind?: unknown }} */ (parsed).kind);
}

/**
 * @param {unknown} value
 */
export function isProject(value) {
  return typeof value === 'string' && PROJECT_NAME.test(value);
}

/**
 * @param {unknown} value
 */
export function isNamedAgent(value) {
  return typeof value === 'string' && NAMED_AGENT.test(value);
}

/**
 * An agent name the daemon will show on a card.
 * Release 0.1.8 `validName` in `agent-config.js` is `/^[A-Za-z0-9._-]+$/`.
 * This host keeps that shape and caps it at 80 characters. An ephemeral id
 * (`_eph-…`) matches. This is not a name the host will place on a path:
 * that stays `isNamedAgent`.
 */
export const DISPLAY_AGENT = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * @param {unknown} value
 */
export function isDisplayAgent(value) {
  return typeof value === 'string' && DISPLAY_AGENT.test(value);
}

/**
 * @param {unknown} value
 */
export function isMissionId(value) {
  return typeof value === 'string' && MISSION_ID.test(value) && !RESERVED_MISSION_IDS.has(value);
}

/**
 * @param {unknown} value
 */
export function isEventId(value) {
  return typeof value === 'string' && EVENT_ID.test(value);
}

/**
 * @param {unknown} value
 */
export function isTaskStatus(value) {
  return typeof value === 'string' && TASK_STATUS.test(value);
}

/**
 * @param {unknown} value
 */
export function isTaskType(value) {
  return typeof value === 'string' && TASK_TYPE.test(value);
}

/**
 * @param {unknown} value
 */
export function isAutomationId(value) {
  return typeof value === 'string' && AUTOMATION_ID.test(value) && !value.includes('..');
}

/**
 * A workflow id or slug. Reserved route words are refused: `runs` would hit
 * `GET /api/workflows/runs`, which is not in the closed list.
 * @param {unknown} value
 */
export function isWorkflowId(value) {
  return isAutomationId(value) && !RESERVED_WORKFLOW_IDS.has(value);
}

/**
 * A worktree base the daemon will accept (`isPlausibleGitRef` in release 0.1.8).
 * Not an existence check. A leading `-` would be a git flag. `..` would be a path.
 * @param {unknown} value
 */
export function isGitRef(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false;
  if (value !== value.trim()) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value.includes('..') || value.endsWith('.lock')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}
