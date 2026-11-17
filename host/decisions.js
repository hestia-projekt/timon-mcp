/**
 * Answers a waiting card through the closed daemon routes.
 *
 * The card type is read from `GET /api/permissions` immediately before the
 * resolve call. A missing card is `card not found`. A body the card did not
 * ask for is refused before `POST /api/permissions/:id/resolve`.
 *
 * `GET /api/auth/me` is read only for `user.id`. The rest of that payload,
 * including the address, is not logged, not stored, and not returned.
 * The poller of `host/pending.js` remains the only emitter of `resolved`.
 */
import {
  ANSWER_NOTE_MAX,
  DENY_MESSAGE_MAX,
  FORM_CANCELLED,
  RELAY_CHANNELS,
  UPDATED_INPUT_MAX_BYTES,
  cardKind,
  localAnswerDefect,
  pickPlan,
  planAnswerDefect,
  questionAnswerDefect,
} from './answers.js';
import { PERMISSIONS_TOO_LARGE } from './daemon.js';
import {
  DaemonBodyError,
  DaemonCallError,
  DaemonRouteError,
  PluginMissionError,
} from './errors.js';
import { CARD_ID } from './permissions.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Account id, or the literal the release uses when the daemon token has no user. */
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} limit
 */
function boundedLimit(limit) {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new PluginMissionError('invalid', 'limit is invalid');
  }
  return limit;
}

/**
 * @param {unknown} err
 */
function transport(err) {
  if (err instanceof PluginMissionError) return err;
  if (err instanceof DaemonBodyError) return new PluginMissionError('too_large', PERMISSIONS_TOO_LARGE);
  if (err instanceof DaemonCallError) return new PluginMissionError('failed', 'daemon is unreachable');
  if (err instanceof DaemonRouteError) return new PluginMissionError('failed', 'daemon route is not allowed');
  return new PluginMissionError('failed', 'daemon is unreachable');
}

/**
 * @param {unknown} channel
 */
function channelOf(channel) {
  if (channel === undefined) return RELAY_CHANNELS[0];
  if (typeof channel !== 'string' || !RELAY_CHANNELS.includes(channel)) {
    throw new PluginMissionError('invalid', 'relay_channel is invalid');
  }
  return channel;
}

/**
 * @param {{ kind?: string, subject?: string } | undefined} caller
 * @param {string} channel
 * @returns {string | null}
 */
function relayLabel(caller, channel) {
  if (!caller) return null;
  if (caller.kind === 'static') return `static:${channel}`;
  if (caller.kind === 'oauth' && typeof caller.subject === 'string' && /^[0-9a-f]{64}$/.test(caller.subject)) {
    return `${caller.subject}:${channel}`;
  }
  return null;
}

/**
 * `user.id` only. `null` is an unusable response. `'daemon-token'` is a
 * daemon token with no account. The payload itself is not returned.
 * @param {{ status: number, json: unknown }} result
 * @returns {string | null}
 */
function accountId(result) {
  if (!result || result.status !== 200 || !isPlain(result.json)) return null;
  if (!Object.prototype.hasOwnProperty.call(result.json, 'user')) return null;
  if (result.json.user === null) return 'daemon-token';
  const user = result.json.user;
  if (!isPlain(user) || typeof user.id !== 'string' || !ACCOUNT_ID.test(user.id)) return null;
  return user.id;
}

/**
 * @param {object} options
 * @param {{ request: Function }} options.client
 * @param {{ prepare: Function }} options.sql
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 */
export function createDecisions(options) {
  const client = options.client;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const insert = options.sql.prepare(`
    INSERT INTO host_decisions (id, type, status, decided_by, relayed_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listRows = options.sql.prepare(`
    SELECT id, type, status, decided_by, relayed_by, created_at
    FROM host_decisions
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);

  /**
   * @param {string} id
   * @returns {Promise<Record<string, unknown>>}
   */
  async function loadCard(id) {
    /** @type {{ status: number, json: unknown }} */
    let result;
    try {
      result = await client.request('GET', '/api/permissions');
    } catch (err) {
      throw transport(err);
    }
    if (result.status !== 200 || !isPlain(result.json) || !Array.isArray(result.json.pending)) {
      throw new PluginMissionError('failed', 'daemon is unreachable');
    }
    for (const raw of result.json.pending) {
      if (isPlain(raw) && raw.id === id) return raw;
    }
    throw new PluginMissionError('card_not_found', 'card not found');
  }

  /**
   * @returns {Promise<string>}
   */
  async function readAccountId() {
    /** @type {{ status: number, json: unknown }} */
    let result;
    try {
      result = await client.request('GET', '/api/auth/me');
    } catch (err) {
      throw transport(err);
    }
    const id = accountId(result);
    if (id === null) {
      if (result && result.status === 200) {
        throw new PluginMissionError('invalid', 'account id is unusable');
      }
      throw new PluginMissionError('failed', 'daemon is unreachable');
    }
    return id;
  }

  /**
   * @param {Record<string, unknown>} body
   */
  function assertBodySize(body) {
    if (body.updatedInput === undefined) return;
    let size;
    try {
      size = Buffer.byteLength(JSON.stringify(body.updatedInput));
    } catch {
      throw new PluginMissionError('invalid', 'answer is too large');
    }
    if (size > UPDATED_INPUT_MAX_BYTES) throw new PluginMissionError('invalid', 'answer is too large');
  }

  /**
   * @param {string} id
   * @param {'question' | 'series_plan' | 'approval'} kind
   * @param {'allow' | 'deny'} sentBehavior
   * @param {boolean} sentCancel
   * @param {Record<string, unknown>} body
   * @param {string} relay
   */
  async function finish(id, kind, sentBehavior, sentCancel, body, relay) {
    assertBodySize(body);
    const decidedBy = await readAccountId();
    /** @type {{ status: number, json: unknown }} */
    let result;
    try {
      result = await client.request('POST', `/api/permissions/${id}/resolve`, body);
    } catch (err) {
      throw transport(err);
    }
    if (result.status === 404) throw new PluginMissionError('card_not_found', 'card not found');
    const status = outcomeOf(kind, sentBehavior, sentCancel, result);
    if (!status) throw new PluginMissionError('failed', 'daemon refused the decision');
    try {
      insert.run(id, kind, status, decidedBy, relay, now());
    } catch {
      log(`decision record failed id=${id}`);
    }
    return { id, type: kind, status };
  }

  return {
    /**
     * @param {Record<string, unknown>} args
     * @param {{ kind?: string, subject?: string }} caller
     */
    async answer(args, caller) {
      if (typeof args.id !== 'string' || !CARD_ID.test(args.id)) {
        throw new PluginMissionError('invalid', 'id is invalid');
      }
      const relay = relayLabel(caller, channelOf(args.relay_channel));
      if (!relay) throw new PluginMissionError('invalid', 'caller subject is missing');
      const local = localAnswerDefect(args);
      if (local) throw new PluginMissionError('invalid', local);
      const card = await loadCard(args.id);
      const kind = cardKind(card);
      if (kind !== 'question' && kind !== 'series_plan') {
        throw new PluginMissionError('invalid', 'this card is not a question');
      }
      if (args.cancel === true) {
        return finish(args.id, kind, 'deny', true, { behavior: 'deny', message: FORM_CANCELLED }, relay);
      }
      if (kind === 'series_plan') {
        if (args.answers !== undefined) {
          throw new PluginMissionError('invalid', 'this question is a Kanban plan: answer with `{ plan }` or `{ cancel: true }`');
        }
        const defect = planAnswerDefect(card, args.plan);
        if (defect) throw new PluginMissionError('invalid', defect);
        const plan = pickPlan(/** @type {Record<string, unknown>} */ (args.plan));
        return finish(args.id, kind, 'allow', false, { behavior: 'allow', updatedInput: { plan } }, relay);
      }
      if (args.plan !== undefined) {
        throw new PluginMissionError('invalid', 'this question is a form: answer with `{ answers }` or `{ cancel: true }`');
      }
      const defect = questionAnswerDefect(card, { answers: args.answers, note: args.note });
      if (defect) throw new PluginMissionError('invalid', defect);
      /** @type {Record<string, unknown>} */
      const updatedInput = { answers: args.answers };
      if (typeof args.note === 'string' && args.note.trim() !== '') updatedInput.note = args.note.trim();
      if (typeof updatedInput.note === 'string' && updatedInput.note.length > ANSWER_NOTE_MAX) {
        throw new PluginMissionError('invalid', '`note` is too long');
      }
      return finish(args.id, kind, 'allow', false, { behavior: 'allow', updatedInput }, relay);
    },

    /**
     * @param {Record<string, unknown>} args
     * @param {{ kind?: string, subject?: string }} caller
     */
    async resolveApproval(args, caller) {
      if (typeof args.id !== 'string' || !CARD_ID.test(args.id)) {
        throw new PluginMissionError('invalid', 'id is invalid');
      }
      if (args.behavior !== 'allow' && args.behavior !== 'deny') {
        throw new PluginMissionError('invalid', 'behavior is invalid');
      }
      const relay = relayLabel(caller, channelOf(args.relay_channel));
      if (!relay) throw new PluginMissionError('invalid', 'caller subject is missing');
      if (args.behavior === 'allow' && args.message !== undefined) {
        throw new PluginMissionError('invalid', 'an approval allow takes no message');
      }
      if (args.message !== undefined) {
        if (typeof args.message !== 'string' || args.message.length > DENY_MESSAGE_MAX || args.message.includes('\u0000')) {
          throw new PluginMissionError('invalid', 'message is invalid');
        }
      }
      const card = await loadCard(args.id);
      const kind = cardKind(card);
      if (kind === 'question' || kind === 'series_plan') {
        throw new PluginMissionError('invalid', 'this card is not an approval');
      }
      /** @type {Record<string, unknown>} */
      const body = { behavior: args.behavior };
      if (args.behavior === 'deny' && typeof args.message === 'string' && args.message.trim() !== '') {
        body.message = args.message;
      }
      return finish(args.id, 'approval', args.behavior, false, body, relay);
    },

    /**
     * @param {{ limit?: unknown }} [args]
     */
    list(args = {}) {
      const limit = boundedLimit(args.limit);
      const rows = listRows.all(limit);
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        decided_by: row.decided_by,
        relayed_by: row.relayed_by,
        created_at: row.created_at,
      }));
    },
  };
}

/**
 * Status the daemon accepted. An echoed `behavior` wins over the body we sent.
 * `{ ok: true }` with no behavior means the daemon applied that body.
 * @param {'question' | 'series_plan' | 'approval'} kind
 * @param {'allow' | 'deny'} sentBehavior
 * @param {boolean} sentCancel
 * @param {{ status: number, json: unknown }} result
 * @returns {'allow' | 'deny' | 'answered' | 'cancelled' | null}
 */
function outcomeOf(kind, sentBehavior, sentCancel, result) {
  if (result.status !== 200 || !isPlain(result.json)) return null;
  let behavior = sentBehavior;
  if (typeof result.json.behavior === 'string') {
    if (result.json.behavior !== 'allow' && result.json.behavior !== 'deny') return null;
    behavior = result.json.behavior;
  } else if (result.json.ok !== true) {
    return null;
  }
  if (kind === 'approval') return behavior;
  if (behavior === 'allow') return 'answered';
  if (behavior === 'deny' && sentCancel) return 'cancelled';
  if (behavior === 'deny') return 'deny';
  return null;
}
