/**
 * Answer checks for a card read from `GET /api/permissions` (release 0.1.8).
 *
 * Question text follows `answerDefect` in `questions-facade.js`. A plan
 * follows `validateSeriesPlanAnswer` in `series-plan.js`. A choice is also
 * refused when the question offered options and the choice is not one of
 * them. The strings are the ones the release returns to the caller.
 *
 * `FORM_CANCELLED` is `DENY_REASONS.formCancelled`. The host sends it as the
 * deny message of a cancel, and sends nothing else with it.
 */
import { questionKindOf } from './permissions.js';

/** Channels a caller may name. The default is the first. */
export const RELAY_CHANNELS = Object.freeze(['hermes']);

/** Longest deny `message` the host will send. Release 0.1.8 does not cap it. */
export const DENY_MESSAGE_MAX = 2000;

/** `MAX_ANSWER_CHARS` in `questions-facade.js`. */
export const ANSWER_NOTE_MAX = 8000;

/** Serialised `updatedInput`. Larger bodies are refused before the network. */
export const UPDATED_INPUT_MAX_BYTES = 32 * 1024;

export const FORM_CANCELLED = 'The user closed the form without answering ("Cancel" button). This is NOT a refusal '
  + 'of your request: they saw the questions and did not decide. Rephrase more simply, or '
  + 'proceed while clearly stating the assumption you are making for lack of an answer.';

const SERIES_PLAN_MODES = Object.freeze([
  'sequential-here',
  'sequential-new-mission',
  'kanban-full',
  'kanban-code-self',
  'kanban-code-group',
]);

const SERIES_PLAN_ROLES = Object.freeze(['orchestrator', 'mission', 'code', 'review', 'merge', 'doc']);

const ROLES_BY_MODE = Object.freeze({
  'sequential-here': ['orchestrator'],
  'sequential-new-mission': ['orchestrator', 'mission'],
  'kanban-full': ['orchestrator', 'code', 'review', 'merge', 'doc'],
  'kanban-code-self': ['orchestrator', 'code', 'doc'],
  'kanban-code-group': ['orchestrator', 'code', 'merge', 'doc'],
});

const SERIES_PLAN_GROUP_ROLES = Object.freeze(['code', 'review', 'merge', 'doc']);

const PLAN_KEYS = new Set(['mode', 'roles', 'groups', 'note']);
const ROLE_KEYS = new Set(['backend', 'model', 'fallbackBackend', 'fallbackModel']);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isAnswerText(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= ANSWER_NOTE_MAX;
}

/**
 * Labels the question offered, or `null` when the answer is free text.
 * @param {Record<string, unknown>} question
 * @returns {string[] | null}
 */
function optionLabels(question) {
  if (!Array.isArray(question.options) || question.options.length === 0) return null;
  /** @type {string[]} */
  const labels = [];
  for (const option of question.options) {
    if (isPlain(option) && typeof option.label === 'string') labels.push(option.label);
  }
  return labels;
}

/**
 * @param {string[] | null} labels
 * @param {string} value
 */
function knownOption(labels, value) {
  return labels === null || labels.includes(value);
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>[]}
 */
function rawQuestions(raw) {
  const input = isPlain(raw.input) ? raw.input : {};
  if (!Array.isArray(input.questions)) return [];
  return input.questions.filter(isPlain);
}

/**
 * Group names on the plan form, in first-seen order.
 * @param {Record<string, unknown>} raw
 * @returns {string[]}
 */
export function knownPlanGroups(raw) {
  const input = isPlain(raw.input) ? raw.input : {};
  const form = isPlain(input.form) ? input.form : {};
  const volets = Array.isArray(form.volets) ? form.volets : [];
  /** @type {string[]} */
  const names = [];
  for (const part of volets) {
    if (!isPlain(part) || typeof part.group !== 'string' || part.group.trim() === '') continue;
    if (!names.includes(part.group)) names.push(part.group);
  }
  return names;
}

/**
 * Defect of a question answer, or `null`. `card` is the daemon card.
 * `answer` is `{ answers, note? }`.
 * @param {Record<string, unknown>} card
 * @param {{ answers?: unknown, note?: unknown }} answer
 * @returns {string | null}
 */
export function questionAnswerDefect(card, answer) {
  if (answer.plan !== undefined) {
    return 'this question is a form: answer with `{ answers }` or `{ cancel: true }`';
  }
  if (!isPlain(answer.answers)) {
    return '`answers` must be an object keyed by the text of each question';
  }
  if (answer.note !== undefined && typeof answer.note !== 'string') return '`note` must be a string';
  const questions = rawQuestions(card);
  const byText = new Map(questions.map((question) => [question.question, question]));
  for (const key of Object.keys(answer.answers)) {
    if (!byText.has(key)) return `unknown question: ${key.slice(0, 80)}`;
  }
  for (const question of questions) {
    const text = typeof question.question === 'string' ? question.question : '';
    const value = answer.answers[text];
    const where = `answer to "${text.slice(0, 48)}"`;
    const labels = optionLabels(question);
    if (value === undefined) return `${where} is missing`;
    if (isPlain(value)) {
      const extra = Object.keys(value).find((key) => key !== 'choice' && key !== 'choices' && key !== 'text');
      if (extra) {
        return `${where}: unknown field \`${extra.slice(0, 40)}\` (expected \`choice\`, \`choices\` and \`text\`)`;
      }
      if (!isAnswerText(value.text)) return `${where}: \`text\` must be a non-empty string`;
      if (value.choice !== undefined && value.choices !== undefined) {
        return `${where}: give \`choice\` or \`choices\`, not both`;
      }
      if (value.choice !== undefined && !isAnswerText(value.choice)) {
        return `${where}: \`choice\` must be a non-empty string`;
      }
      if (value.choice !== undefined && !knownOption(labels, /** @type {string} */ (value.choice))) {
        return `${where}: unknown option`;
      }
      if (value.choices !== undefined) {
        if (question.multiSelect !== true) {
          return `${where}: \`choices\` is accepted only on a multi-select question`;
        }
        if (!Array.isArray(value.choices) || value.choices.some((item) => !isAnswerText(item))) {
          return `${where}: each of \`choices\` must be a non-empty string`;
        }
        if (labels && value.choices.some((item) => !labels.includes(item))) return `${where}: unknown option`;
      }
    } else if (Array.isArray(value)) {
      if (question.multiSelect !== true) {
        return `${where}: a list is accepted only on a multi-select question`;
      }
      if (value.some((item) => typeof item !== 'string' || item.trim() === '' || item.length > ANSWER_NOTE_MAX)) {
        return `${where}: each choice must be a non-empty string`;
      }
      if (labels && value.some((item) => !labels.includes(item))) return `${where}: unknown option`;
    } else if (typeof value !== 'string' || value.trim() === '' || value.length > ANSWER_NOTE_MAX) {
      return `${where} must be a non-empty string`;
    } else if (!knownOption(labels, value)) {
      return `${where}: unknown option`;
    }
  }
  if (typeof answer.note === 'string' && answer.note.length > ANSWER_NOTE_MAX) return '`note` is too long';
  return null;
}

/**
 * @param {string} label
 * @param {unknown} cfg
 * @returns {string | null}
 */
function roleConfigDefect(label, cfg) {
  if (!isPlain(cfg)) return `${label}: the configuration is not an object`;
  for (const key of Object.keys(cfg)) {
    if (!ROLE_KEYS.has(key)) return `${label}: unknown field \`${key.slice(0, 40)}\``;
  }
  for (const field of ROLE_KEYS) {
    const value = cfg[field];
    if (value !== undefined && typeof value !== 'string') return `${label}: field \`${field}\` is not a string`;
  }
  const hasBackend = typeof cfg.fallbackBackend === 'string' && cfg.fallbackBackend !== '';
  const hasModel = typeof cfg.fallbackModel === 'string' && cfg.fallbackModel !== '';
  if (hasModel && !hasBackend) return `${label}: \`fallbackModel\` without \`fallbackBackend\``;
  return null;
}

/**
 * @param {unknown} plan
 * @returns {string | null}
 */
function planShapeDefect(plan) {
  if (!isPlain(plan)) return 'the answer is not an object';
  for (const key of Object.keys(plan)) {
    if (!PLAN_KEYS.has(key)) return `unknown field \`${key.slice(0, 40)}\``;
  }
  if (plan.roles !== undefined && !isPlain(plan.roles)) return 'field `roles` is not an object';
  if (isPlain(plan.roles)) {
    for (const cfg of Object.values(plan.roles)) {
      if (!isPlain(cfg)) continue;
      for (const key of Object.keys(cfg)) {
        if (!ROLE_KEYS.has(key)) return `unknown field \`${key.slice(0, 40)}\``;
      }
    }
  }
  if (plan.groups !== undefined && !isPlain(plan.groups)) return 'field `groups` is not an object';
  if (isPlain(plan.groups)) {
    for (const cfgs of Object.values(plan.groups)) {
      if (!isPlain(cfgs)) continue;
      for (const cfg of Object.values(cfgs)) {
        if (!isPlain(cfg)) continue;
        for (const key of Object.keys(cfg)) {
          if (!ROLE_KEYS.has(key)) return `unknown field \`${key.slice(0, 40)}\``;
        }
      }
    }
  }
  if (typeof plan.note === 'string' && plan.note.length > ANSWER_NOTE_MAX) return 'field `note` is too long';
  return null;
}

/**
 * `validateSeriesPlanAnswer` in release 0.1.8.
 * @param {Record<string, unknown>} answer
 * @param {string[]} knownGroups
 * @returns {string | null}
 */
function seriesPlanAnswerDefect(answer, knownGroups) {
  if (!SERIES_PLAN_MODES.includes(/** @type {string} */ (answer.mode))) {
    return `unknown mode: ${String(answer.mode)}`;
  }
  const mode = /** @type {keyof typeof ROLES_BY_MODE} */ (answer.mode);
  const allowed = ROLES_BY_MODE[mode];
  const roles = answer.roles ?? {};
  if (!isPlain(roles)) return 'field `roles` is not an object';
  for (const [role, cfg] of Object.entries(roles)) {
    if (!SERIES_PLAN_ROLES.includes(role)) return `unknown role: ${role}`;
    if (!allowed.includes(role)) return `role \`${role}\` is outside mode \`${answer.mode}\``;
    const defect = roleConfigDefect(`role \`${role}\``, cfg);
    if (defect) return defect;
  }
  if (answer.groups !== undefined) {
    if (!isPlain(answer.groups)) return 'field `groups` is not an object';
    const known = new Set(knownGroups);
    for (const [group, cfgs] of Object.entries(answer.groups)) {
      if (!known.has(group)) return `unknown group: ${group}`;
      if (!isPlain(cfgs)) return `group \`${group}\`: the configuration is not an object`;
      for (const [role, cfg] of Object.entries(cfgs)) {
        if (!SERIES_PLAN_GROUP_ROLES.includes(role)) {
          return SERIES_PLAN_ROLES.includes(role)
            ? `group \`${group}\`: role \`${role}\` is not set per group`
            : `group \`${group}\`: unknown role: ${role}`;
        }
        if (!allowed.includes(role)) {
          return `group \`${group}\`: role \`${role}\` is outside mode \`${answer.mode}\``;
        }
        const defect = roleConfigDefect(`group \`${group}\`, role \`${role}\``, cfg);
        if (defect) return defect;
      }
    }
  }
  if (answer.note !== undefined && typeof answer.note !== 'string') return 'field `note` is not a string';
  return null;
}

/**
 * Defect of a kanban-plan answer, or `null`.
 * @param {Record<string, unknown>} card
 * @param {unknown} plan
 * @returns {string | null}
 */
export function planAnswerDefect(card, plan) {
  const shape = planShapeDefect(plan);
  if (shape) return shape;
  return seriesPlanAnswerDefect(/** @type {Record<string, unknown>} */ (plan), knownPlanGroups(card));
}

/**
 * The plan object the host sends. Validation has already refused other keys.
 * @param {Record<string, unknown>} plan
 */
export function pickPlan(plan) {
  /** @type {Record<string, unknown>} */
  const out = {
    mode: plan.mode,
    roles: isPlain(plan.roles) ? plan.roles : {},
  };
  if (plan.groups !== undefined) out.groups = plan.groups;
  if (typeof plan.note === 'string' && plan.note.length > 0) out.note = plan.note;
  return out;
}

/**
 * Shape of an `answer_question` call, before any daemon read.
 * `null` means the call may continue.
 * @param {Record<string, unknown>} args
 * @returns {string | null}
 */
export function localAnswerDefect(args) {
  const cancel = Object.prototype.hasOwnProperty.call(args, 'cancel');
  const answers = Object.prototype.hasOwnProperty.call(args, 'answers');
  const plan = Object.prototype.hasOwnProperty.call(args, 'plan');
  const note = Object.prototype.hasOwnProperty.call(args, 'note');
  if (cancel && args.cancel !== true) return 'cancel must be true';
  if (args.cancel === true) {
    if (answers || plan || note) return 'cancel does not take an answer';
    return null;
  }
  if (answers && plan) return 'give an answer or a plan, not both';
  if (plan && note) return 'a plan answer has no separate note';
  if (!answers && !plan) return 'an answer, a plan, or cancel is required';
  if (answers && !isPlain(args.answers)) {
    return '`answers` must be an object keyed by the text of each question';
  }
  if (plan && !isPlain(args.plan)) return 'the answer is not an object';
  if (note && typeof args.note !== 'string') return '`note` must be a string';
  return null;
}

/**
 * @param {Record<string, unknown>} card
 * @returns {'question' | 'series_plan' | null}
 */
export function cardKind(card) {
  return questionKindOf(card);
}
