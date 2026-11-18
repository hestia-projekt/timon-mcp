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
 * Longest agent name release 0.1.8 fabricates. Not a length the daemon accepts.
 *
 * `validName` (`agent-config.js` `NAME_RE`, `/^[A-Za-z0-9._-]+$/`) states no
 * length. `POST /api/agents` and `renameAgentLocked` apply only that check.
 * The plugin facade `NameSchema` (`plugins/agents-facade.js`) caps a write at
 * 100. A name already stored can be longer than either write path.
 *
 * What those rules fabricate is shorter. A project slug is 1..64
 * (`projects.js` `SLUG_RE`) and a role id is 2..32 (`agent-roles.js` `ID_RE`,
 * one letter then `{1,31}`), so `<slug>.<role>` (`agent-seed.js`) is 97
 * characters. An ephemeral name is `_eph-` plus a hint of at most 24 plus `-`
 * plus 8 hex (`createEphemeralAgent`), which is 38. 97 is that fabricated
 * ceiling. A read uses `AGENT_READ_MAX`. A launch uses `NAMED_AGENT`.
 */
const DAEMON_CANONICAL_MAX = 64 + 1 + 32;
const DAEMON_EPHEMERAL_MAX = 5 + 24 + 1 + 8;
export const AGENT_NAME_MAX = Math.max(DAEMON_CANONICAL_MAX, DAEMON_EPHEMERAL_MAX);

/**
 * Longest name a read will copy or place on a path.
 * The daemon's hard bound is that the name is one directory (`agentDir`),
 * so `NAME_MAX` is 255. `.`, `..`, and the route words stay refused on a path.
 */
export const AGENT_READ_MAX = 255;

/**
 * An agent the operator already has: the pilot `_main`, or `<project>.<role>`.
 * One dot. The host does not create the agent.
 * `PROJECT_PATTERN` is 1..40 characters, so `<project>.<role>` is at most 81
 * and `_main` is 5. The pattern is the ceiling. A length lookahead would only
 * repeat it, and 97 is the fabricated name, not this one.
 */
export const NAMED_AGENT = new RegExp(
  `^(?:${PILOT_AGENT}|${PROJECT_BODY}\\.${PROJECT_BODY})$`,
);

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
 * An agent name the daemon will show.
 * Same characters as release 0.1.8 `validName`, which states no length.
 * The cap is `AGENT_READ_MAX`: one directory (`agentDir`). An ephemeral id
 * (`_eph-…`) matches, and so does a stored name longer than the 100-character
 * plugin facade. A launch or a direct message stays `isNamedAgent`. A name
 * this host places on a path uses `isAgentPath`.
 */
const AGENT_CHARS = `[A-Za-z0-9._-]{1,${AGENT_READ_MAX}}`;
export const DISPLAY_AGENT = new RegExp(`^${AGENT_CHARS}$`);

/**
 * @param {unknown} value
 */
export function isDisplayAgent(value) {
  return typeof value === 'string' && DISPLAY_AGENT.test(value);
}

/**
 * A display name safe to send on a read.
 * `GET /api/agents/:name` in release 0.1.8 calls `getAgent`, which accepts
 * `validName` and returns an ephemeral agent. The same check is used for a
 * list filter and for `stop_scope`, so a dangerous token is refused before
 * it can be placed on a path: `.` alone, a name that contains `..`, a
 * percent-encoding (`%` is outside the display grammar, so `%2f` fails),
 * and the route words `active`, `spawn`, `ephemeral`, and `main`.
 * The length is `AGENT_READ_MAX`, the same ceiling as `isDisplayAgent`.
 */
export const AGENT_PATH = new RegExp(
  `^(?!(?:active|spawn|ephemeral|main)$)(?!\\.$)(?!.*\\.\\.)${AGENT_CHARS}$`,
);

/**
 * @param {unknown} value
 */
export function isAgentPath(value) {
  return typeof value === 'string' && AGENT_PATH.test(value);
}

/**
 * A display name copied out of a daemon row.
 * `_eph-…` is kept. `.` and a name that contains `..` are not: they are
 * paths, not labels. A reserved route word is kept when the daemon sent it,
 * because a projection does not place the name on a path. `get_agent`
 * still refuses that word.
 * @param {unknown} value
 * @returns {string | null}
 */
export function shownAgent(value) {
  if (!isDisplayAgent(value)) return null;
  if (value === '.' || value.includes('..')) return null;
  return value;
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
