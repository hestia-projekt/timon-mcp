/**
 * `answer_question`, `resolve_approval`, and `list_decisions` for the
 * standalone host. Mounted with the other host tools on `POST /mcp`.
 * `lib/` does not list them. The manifest does not gain `questions:answer`:
 * this host does not call `ctx.questions`.
 *
 * Identity is not a parameter. `decided_by` is the account id behind the
 * daemon token. `relayed_by` is the OAuth subject already stored for the
 * caller, or `static` for the static bearer, plus `relay_channel`.
 */
import { DENY_MESSAGE_MAX, RELAY_CHANNELS } from './answers.js';
import { CARD_ID } from './permissions.js';

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

const cardId = { type: 'string', minLength: 36, maxLength: 36, pattern: CARD_ID.source };
const relayChannel = { type: 'string', enum: [...RELAY_CHANNELS] };

export const DECISION_TOOLS = [
  {
    name: 'answer_question',
    needsCaller: true,
    ...schema(
      'Answers a waiting question or kanban plan. id is the card id. A question takes answers, an object keyed by the question text, and an optional note. Each choice must be one of the options the question offered, and choices is accepted only when that question is multi-select. A plan takes plan (mode, roles, and optional groups and note). cancel set to true closes the form and sends no answer. Give only one of answers, plan, or cancel. Optional relay_channel defaults to hermes. The host reads the card from the daemon before it answers and refuses a tool approval. The status is the one the daemon accepted. decided_by is not a parameter. Does not count against the host spawn window. Does not emit the pending webhook.',
      {
        id: cardId,
        answers: {},
        plan: {},
        note: { type: 'string', maxLength: 8000 },
        cancel: {},
        relay_channel: relayChannel,
      },
      ['id'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     * @param {{ kind?: string, subject?: string }} caller
     */
    async run(ctx, args, caller) {
      return ctx.decisions.answer(args, caller);
    },
  },
  {
    name: 'resolve_approval',
    needsCaller: true,
    ...schema(
      'Allows or denies a waiting tool approval. id is the card id. behavior is allow or deny. deny takes an optional message of at most 2000 characters. scope, paste, and updatedInput are not parameters and are refused. The host reads the card from the daemon before it answers and refuses a question or a kanban plan. Optional relay_channel defaults to hermes. The status is the one the daemon accepted. decided_by is not a parameter. Does not count against the host spawn window. Does not emit the pending webhook.',
      {
        id: cardId,
        behavior: { type: 'string', enum: ['allow', 'deny'] },
        message: { type: 'string', minLength: 1, maxLength: DENY_MESSAGE_MAX },
        relay_channel: relayChannel,
      },
      ['id', 'behavior'],
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     * @param {{ kind?: string, subject?: string }} caller
     */
    async run(ctx, args, caller) {
      return ctx.decisions.resolveApproval(args, caller);
    },
  },
  {
    name: 'list_decisions',
    ...schema(
      'Reads the host decision journal, newest first. Optional limit is 1 to 100 and 50 when omitted. Each row is the card id, the type (question, series_plan, or approval), the status the daemon accepted (allow, deny, answered, or cancelled), the time, decided_by (an account id, or daemon-token), and relayed_by (the OAuth subject digest, or static, and the channel). No address, no secret, and no account payload is returned. Does not call the daemon and does not count against the host spawn window.',
      {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    ),
    /**
     * @param {object} ctx
     * @param {Record<string, unknown>} args
     */
    run(ctx, args) {
      return { decisions: ctx.decisions.list(args) };
    },
  },
];
