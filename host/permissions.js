/**
 * Projection of `GET /api/permissions` (release 0.1.8).
 *
 * The route returns `{ pending }` and each card is `viewOf` (`permissions.js`):
 * the waiter callback and the script internals are already gone. What remains
 * still carries the raw tool input. This module does not forward that object.
 *
 * A renderable `ask_user` card is a question or a kanban plan. The fields are
 * the whitelist of `projectQuestion` (`questions-facade.js`). Anything else is
 * a tool approval. `projectCard` is the webhook projection: type, id, tool,
 * mission, agent, and dates, plus that whitelist for a question. It carries
 * no tool input. `projectListedCard` is the authenticated `list_pending`
 * view of the same card. An approval there adds a bounded redacted preview
 * of `input.command` and nothing else from the input.
 * `questionKindOf` is the same split as the release (`permissions.js`):
 * `ask_user` whose payload does not validate is not a question.
 */
import { isDisplayAgent, isMissionId } from './names.js';

/** Cards the poller will diff. Above this, a missing tail must not look resolved. */
export const PENDING_CARD_CAP = 200;

const ASK_MIN_QUESTIONS = 1;
const ASK_MAX_QUESTIONS = 4;
const ASK_MIN_OPTIONS = 2;
const ASK_MAX_OPTIONS = 4;
const MAX_CHAT_POST_CHARS = 20_000;
const MAX_VOLETS = 12;
const MAX_GROUP_NAME_CHARS = 60;
const MAX_GROUPS = 6;
const GROUP_NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Characters kept from a tool command on the authenticated list. */
const COMMAND_PREVIEW_MAX = 160;

/** Lowercase UUID, the only card id this host will place on a resolve path. */
export const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;
const BEARER_VALUE = /Bearer\s+\S+/gi;
const LONG_HEX = /[0-9a-fA-F]{32,}/g;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * @param {unknown} value
 * @returns {'agent' | 'user' | null}
 */
function optionActor(value) {
  return value === 'agent' || value === 'user' ? value : null;
}

/**
 * `formMessageOf` in release 0.1.8: a blank message is absent, a non-string
 * or a text past 20,000 characters (after trim) is a defect.
 * @param {unknown} input
 * @returns {string | null}
 */
function formMessageDefect(input) {
  if (!isPlain(input) || input.message === undefined || input.message === null) return null;
  if (typeof input.message !== 'string') return 'field `message` is not a string';
  if (input.message.trim() === '') return null;
  if (input.message.trim().length > MAX_CHAT_POST_CHARS) return 'field `message` is too long';
  return null;
}

/**
 * `validateSeriesPlanForm` in release 0.1.8. `null` means the form can render.
 * @param {unknown} form
 * @returns {string | null}
 */
function seriesPlanDefect(form) {
  if (!isPlain(form)) return 'the form is not an object';
  if (form.kind !== 'series_plan') return 'field `kind` missing or other than `series_plan`';
  if (typeof form.chantier !== 'string' || form.chantier.trim() === '') return 'field `chantier` missing or empty';
  const volets = form.volets;
  if (!Array.isArray(volets)) return 'field `volets` missing or not an array';
  if (volets.length === 0) return 'array `volets` is empty';
  if (volets.length > MAX_VOLETS) return 'too many parts';
  for (let i = 0; i < volets.length; i += 1) {
    const part = volets[i];
    if (!isPlain(part)) return 'part is not an object';
    if (typeof part.title !== 'string' || part.title.trim() === '') return 'part title is missing';
    if (part.description !== undefined && typeof part.description !== 'string') return 'part description is not a string';
    if (part.group !== undefined) {
      if (typeof part.group !== 'string' || part.group.trim() === '') return 'part group is empty';
      if (part.group.length > MAX_GROUP_NAME_CHARS) return 'part group is too long';
      if (GROUP_NAME_CONTROL_CHARS.test(part.group)) return 'part group has a control character';
    }
  }
  const groups = [];
  for (const part of volets) {
    if (!isPlain(part) || typeof part.group !== 'string' || part.group.trim() === '') continue;
    if (!groups.includes(part.group)) groups.push(part.group);
  }
  if (groups.length > MAX_GROUPS) return 'too many groups';
  return null;
}

/**
 * `validateAskUserPayload` in release 0.1.8. `null` means the card can render.
 * @param {unknown} input
 * @returns {string | null}
 */
export function askUserDefect(input) {
  if (!isPlain(input)) return 'the payload is not an object';
  const message = formMessageDefect(input);
  if (message) return message;
  if (input.form !== undefined) {
    if (!isPlain(input.form)) return 'field `form` is not an object';
    if (input.form.kind === 'series_plan') return seriesPlanDefect(input.form);
    return 'field `form` has an unknown type';
  }
  const questions = input.questions;
  if (questions === undefined || questions === null) return 'field `questions` missing';
  if (!Array.isArray(questions)) return 'field `questions` is not an array';
  if (questions.length < ASK_MIN_QUESTIONS) return 'empty `questions` array';
  if (questions.length > ASK_MAX_QUESTIONS) return 'too many questions';
  for (const question of questions) {
    if (!isPlain(question)) return 'question is not an object';
    if (typeof question.question !== 'string' || question.question.trim() === '') return 'question text is missing';
    if (question.placeholder !== undefined && typeof question.placeholder !== 'string') return 'placeholder is not a string';
    const options = question.options;
    if (options === undefined || options === null || (Array.isArray(options) && options.length === 0)) {
      if (question.multiSelect === true) return 'multiSelect needs options';
      continue;
    }
    if (!Array.isArray(options)) return 'options is not an array';
    if (options.length < ASK_MIN_OPTIONS || options.length > ASK_MAX_OPTIONS) return 'option count is out of range';
    for (const option of options) {
      if (!isPlain(option)) return 'option is not an object';
      if (typeof option.label !== 'string' || option.label.trim() === '') return 'option label is missing';
    }
  }
  return null;
}

/**
 * `questionKindOf` in release 0.1.8. `null` is a tool approval.
 * @param {{ tool_name?: unknown, input?: unknown }} card
 * @returns {'question' | 'series_plan' | null}
 */
export function questionKindOf(card) {
  if (!card || card.tool_name !== 'ask_user' || askUserDefect(card.input) !== null) return null;
  const input = /** @type {Record<string, unknown>} */ (card.input);
  const form = input.form;
  if (isPlain(form) && form.kind === 'series_plan') return 'series_plan';
  return 'question';
}

/**
 * Bearer tokens and long hex runs, then the preview cap.
 * @param {string} value
 * @returns {string}
 */
function redactString(value) {
  const cleaned = value.replace(BEARER_VALUE, 'Bearer [redacted]').replace(LONG_HEX, '[redacted]');
  return cleaned.length > COMMAND_PREVIEW_MAX ? cleaned.slice(0, COMMAND_PREVIEW_MAX) : cleaned;
}

/**
 * Preview of a tool command for `list_pending`. `null` when `input.command`
 * is not a string. No other input field is read.
 * @param {unknown} input
 * @returns {string | null}
 */
export function commandPreview(input) {
  if (!isPlain(input) || typeof input.command !== 'string') return null;
  return redactString(input.command);
}

/**
 * @param {unknown} questions
 */
function projectQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.filter(isPlain).map((question) => ({
    question: asString(question.question) ?? '',
    header: asString(question.header),
    options: (Array.isArray(question.options) ? question.options : []).filter(isPlain).map((option) => ({
      label: asString(option.label) ?? '',
      description: asString(option.description),
      actor: optionActor(option.actor),
    })),
    multi_select: question.multiSelect === true,
    placeholder: asString(question.placeholder),
  }));
}

/**
 * @param {unknown} form
 */
function projectPlan(form) {
  const record = isPlain(form) ? form : {};
  const volets = Array.isArray(record.volets) ? record.volets : [];
  return {
    title: asString(record.chantier) ?? '',
    volets: volets.filter(isPlain).map((part) => ({
      title: asString(part.title) ?? '',
      description: asString(part.description),
      group: asString(part.group),
    })),
  };
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function timestamp(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * One card, or `null` when the id, mission, or agent cannot be shown.
 * The agent is a display name (`isDisplayAgent`), not a path name.
 * The returned object is built field by field. An approval has no tool input:
 * that shape is what a webhook may carry.
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
export function projectCard(raw) {
  if (!isPlain(raw)) return null;
  if (typeof raw.id !== 'string' || !CARD_ID.test(raw.id)) return null;
  if (!isMissionId(raw.mission_id)) return null;
  if (!isDisplayAgent(raw.agent)) return null;
  const created = timestamp(raw.created_at);
  if (created === null) return null;
  const timeout = timestamp(raw.timeout_ms);
  let expires = null;
  if (timeout !== null && timeout > 0) {
    const sum = created + timeout;
    expires = Number.isSafeInteger(sum) ? sum : null;
  }
  const base = {
    id: raw.id.toLowerCase(),
    mission_id: raw.mission_id,
    agent: raw.agent,
    created_at: created,
    expires_at: expires,
  };
  const kind = questionKindOf(raw);
  if (kind === 'series_plan') {
    return {
      type: 'series_plan',
      ...base,
      questions: [],
      plan: projectPlan(isPlain(raw.input) ? raw.input.form : null),
    };
  }
  if (kind === 'question') {
    const input = /** @type {Record<string, unknown>} */ (raw.input);
    return {
      type: 'question',
      ...base,
      questions: projectQuestions(input.questions),
      plan: null,
    };
  }
  const toolName = typeof raw.tool_name === 'string' && TOOL_NAME.test(raw.tool_name) ? raw.tool_name : 'tool';
  return {
    type: 'approval',
    ...base,
    tool_name: toolName,
  };
}

/**
 * Authenticated list. Same card as `projectCard`, and for an approval the
 * command preview only. `shell_command` and `script_previews` are not read.
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
export function projectListedCard(raw) {
  const card = projectCard(raw);
  if (!card || card.type !== 'approval') return card;
  return { ...card, command: commandPreview(isPlain(raw) ? raw.input : null) };
}
