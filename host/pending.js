/**
 * Polls `GET /api/permissions` and tells the configured webhook about cards
 * that appeared (`pending`) or disappeared (`resolved`).
 *
 * Card ids are stored in the host sqlite database. A restart does not send
 * `pending` again for an id already recorded. With no webhook URL the poll
 * still records ids, and nothing is sent. `list_pending` reads the daemon
 * on demand and does not use that table.
 */
import { PERMISSIONS_TOO_LARGE } from './daemon.js';
import {
  DaemonBodyError,
  DaemonCallError,
  DaemonRouteError,
  PluginMissionError,
} from './errors.js';
import { isMissionId } from './names.js';
import { PENDING_CARD_CAP, projectCard } from './permissions.js';
import { deliverWebhook } from './webhook.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {{ prepare: Function }} sql
 */
function createStore(sql) {
  const one = sql.prepare('SELECT id, event, projection FROM host_pending_cards WHERE id = ?');
  const open = sql.prepare("SELECT id, projection FROM host_pending_cards WHERE event = 'pending' ORDER BY id");
  const save = sql.prepare(`
    INSERT INTO host_pending_cards (id, event, projection, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      event = excluded.event,
      projection = excluded.projection,
      updated_at = excluded.updated_at
  `);
  return {
    /**
     * @param {string} id
     */
    get(id) {
      return one.get(id);
    },
    open() {
      return open.all();
    },
    /**
     * @param {string} id
     * @param {'pending' | 'resolved'} event
     * @param {Record<string, unknown>} card
     * @param {number} now
     */
    save(id, event, card, now) {
      save.run(id, event, JSON.stringify(card), now);
    },
  };
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
 * @param {object} options
 * @param {{ request: Function }} options.client
 * @param {{ prepare: Function }} options.sql
 * @param {{ url: string, secret: string } | null} options.webhook
 * @param {(message: string) => void} options.log
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 */
export function createPendingWatcher(options) {
  const store = createStore(options.sql);
  const webhook = options.webhook;
  const log = options.log;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
  const now = options.now ?? Date.now;
  let chain = Promise.resolve();
  let stopped = false;

  /**
   * @returns {Promise<Record<string, unknown>[] | null>}
   */
  async function readCards() {
    /** @type {{ status: number, json: unknown }} */
    let result;
    try {
      result = await options.client.request('GET', '/api/permissions');
    } catch (err) {
      if (err instanceof DaemonBodyError) log('pending poll too_large');
      else log('pending poll failed');
      return null;
    }
    if (result.status !== 200 || !isPlain(result.json) || !Array.isArray(result.json.pending)) {
      log('pending poll failed');
      return null;
    }
    if (result.json.pending.length > PENDING_CARD_CAP) {
      log('pending list is over the cap');
      return null;
    }
    /** @type {Record<string, unknown>[]} */
    const cards = [];
    for (const raw of result.json.pending) {
      const card = projectCard(raw);
      if (card) cards.push(card);
    }
    cards.sort((a, b) => Number(a.created_at) - Number(b.created_at) || String(a.id).localeCompare(String(b.id)));
    return cards;
  }

  /**
   * @param {'pending' | 'resolved'} event
   * @param {Record<string, unknown>} card
   */
  async function emit(event, card) {
    if (!webhook) return true;
    return deliverWebhook({
      url: webhook.url,
      secret: webhook.secret,
      event,
      card,
      sleep,
      log,
      now,
    });
  }

  async function once() {
    if (stopped) return;
    const cards = await readCards();
    if (!cards) return;
    const seen = new Set(cards.map((card) => String(card.id)));
    for (const card of cards) {
      if (stopped) return;
      const id = String(card.id);
      const row = store.get(id);
      const text = JSON.stringify(card);
      if (row && row.event === 'pending') {
        if (row.projection !== text) store.save(id, 'pending', card, now());
        continue;
      }
      await emit('pending', card);
      if (stopped) return;
      store.save(id, 'pending', card, now());
    }
    for (const row of store.open()) {
      if (stopped) return;
      if (seen.has(row.id)) continue;
      let card;
      try {
        const parsed = JSON.parse(row.projection);
        card = isPlain(parsed) ? parsed : null;
      } catch {
        card = null;
      }
      if (!card || card.id !== row.id) {
        log(`pending card projection is unreadable id=${row.id}`);
        store.save(row.id, 'resolved', { id: row.id }, now());
        continue;
      }
      await emit('resolved', card);
      if (stopped) return;
      store.save(row.id, 'resolved', card, now());
    }
  }

  function poll() {
    const run = chain.then(() => once());
    chain = run.then(() => {}, () => {});
    return run;
  }

  return {
    poll,
    idle() {
      return chain;
    },
    stop() {
      stopped = true;
    },
    /**
     * @param {{ mission_id?: unknown, limit?: unknown }} [args]
     */
    async list(args = {}) {
      const limit = boundedLimit(args.limit);
      if (args.mission_id !== undefined && !isMissionId(args.mission_id)) {
        throw new PluginMissionError('invalid', 'mission_id is invalid');
      }
      const missionId = typeof args.mission_id === 'string' ? args.mission_id : undefined;
      /** @type {{ status: number, json: unknown }} */
      let result;
      try {
        result = await options.client.request('GET', '/api/permissions');
      } catch (err) {
        if (err instanceof DaemonBodyError) throw new PluginMissionError('too_large', PERMISSIONS_TOO_LARGE);
        if (err instanceof DaemonCallError) throw new PluginMissionError('failed', 'daemon is unreachable');
        if (err instanceof DaemonRouteError) throw new PluginMissionError('failed', 'daemon route is not allowed');
        throw new PluginMissionError('failed', 'daemon is unreachable');
      }
      if (result.status !== 200 || !isPlain(result.json) || !Array.isArray(result.json.pending)) {
        throw new PluginMissionError('failed', 'daemon is unreachable');
      }
      /** @type {Record<string, unknown>[]} */
      const cards = [];
      for (const raw of result.json.pending) {
        const card = projectCard(raw);
        if (!card) continue;
        if (missionId && card.mission_id !== missionId) continue;
        cards.push(card);
      }
      cards.sort((a, b) => Number(a.created_at) - Number(b.created_at) || String(a.id).localeCompare(String(b.id)));
      return cards.slice(0, limit);
    },
  };
}
