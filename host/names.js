/**
 * Names the host is willing to put on a daemon path or in a daemon body.
 * The project body is `PROJECT_PATTERN` without its anchors, so a change of
 * that pattern moves this check with it.
 */
import { PILOT_AGENT, PROJECT_PATTERN } from '../lib/constants.js';

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
