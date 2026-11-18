/**
 * Polls `GET /api/permissions` and tells the configured webhook about cards
 * that appeared (`pending`) or disappeared (`resolved`).
 *
 * Card ids are stored in the host sqlite database. A restart does not send
 * `pending` again for an id already recorded. With no webhook URL the poll
 * still records ids, and nothing is sent. A URL set later can still emit
 * `resolved` for a recorded card that disappears. A card that was never
 * recorded does not. `list_pending` reads the daemon on demand and does not
 * use that table.
 *
 * A timer tick that arrives while a pass is running is ignored. The pass
 * reads, diffs, and enqueues. It does not wait for a webhook try. At most
 * `DELIVERY_CONCURRENCY` deliveries run at once, and at most
 * `DELIVERY_QUEUE_CAP` are outstanding. Resolved rows are kept up to
 * `RESOLVED_ROW_CAP`; the oldest are deleted past that.
 * Each sent occurrence uses `webhook-id` `<event>_<card id>_<n>`. `n` is
 * the next count in `host_pending_webhook_seq` for that card and event.
 * The count is written only when the occurrence is recorded, in the same
 * transaction as the card row, so retries and a restart before the record
 * keep it. The next record of that event uses the next count. Purging a
 * resolved card row does not delete the count.
 * A card `projectCard` refuses stays seen for that pass. The host logs the
 * id only. `resolved` is emitted only when the id is absent from the list.
 */
import { PERMISSIONS_TOO_LARGE } from './daemon.js';
import {
  DaemonBodyError,
  DaemonCallError,
  DaemonRouteError,
  PluginMissionError,
} from './errors.js';
import { isMissionId } from './names.js';
import { PENDING_CARD_CAP, projectCard, projectListedCard } from './permissions.js';
import { deliverWebhook } from './webhook.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Resolved rows kept after a complete poll. Oldest go first past this. */
export const RESOLVED_ROW_CAP = 200;

/** Webhook deliveries running at the same time. */
export const DELIVERY_CONCURRENCY = 4;

/**
 * Outstanding deliveries, waiting and in flight together.
 * A pass that reaches this leaves the rest unrecorded for a later pass.
 */
export const DELIVERY_QUEUE_CAP = 32;

/** A dropped id is logged alone, and not as a whole card. */
const DROPPED_ID_MAX = 200;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
function readSeq(raw) {
  if (typeof raw === 'bigint') {
    if (raw < 0n || raw > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
    return Number(raw);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n;
}

/**
 * @param {{ prepare: Function, transaction?: Function }} sql
 */
function createStore(sql) {
  const one = sql.prepare('SELECT id, event, projection FROM host_pending_cards WHERE id = ?');
  const open = sql.prepare("SELECT id, projection FROM host_pending_cards WHERE event = 'pending' ORDER BY id");
  const countResolved = sql.prepare("SELECT COUNT(*) AS n FROM host_pending_cards WHERE event = 'resolved'");
  const deleteOldestResolved = sql.prepare(`
    DELETE FROM host_pending_cards
    WHERE id IN (
      SELECT id FROM host_pending_cards
      WHERE event = 'resolved'
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    )
  `);
  const saveCard = sql.prepare(`
    INSERT INTO host_pending_cards (id, event, projection, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      event = excluded.event,
      projection = excluded.projection,
      updated_at = excluded.updated_at
  `);
  const seqRow = sql.prepare('SELECT pending_seq, resolved_seq FROM host_pending_webhook_seq WHERE id = ?');
  const saveSeq = sql.prepare(`
    INSERT INTO host_pending_webhook_seq (id, pending_seq, resolved_seq)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      pending_seq = excluded.pending_seq,
      resolved_seq = excluded.resolved_seq
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
     * Next occurrence of `event` for this card, and the counts to store
     * once that occurrence is recorded. A missing row counts as zero.
     * Nothing is written here: a restart before the record recomputes it.
     * @param {string} id
     * @param {'pending' | 'resolved'} event
     * @returns {{ occurrence: number, seqs: { pending: number, resolved: number } }}
     */
    nextSeqs(id, event) {
      const row = seqRow.get(id);
      const pending = readSeq(row && row.pending_seq);
      const resolved = readSeq(row && row.resolved_seq);
      const occurrence = (event === 'pending' ? pending : resolved) + 1;
      return {
        occurrence,
        seqs: {
          pending: event === 'pending' ? occurrence : pending,
          resolved: event === 'resolved' ? occurrence : resolved,
        },
      };
    },
    /**
     * @param {string} id
     * @param {'pending' | 'resolved'} event
     * @param {Record<string, unknown>} card
     * @param {number} now
     */
    save(id, event, card, now) {
      saveCard.run(id, event, JSON.stringify(card), now);
    },
    /**
     * Card row and occurrence counts commit together. The count is the one
     * `nextSeqs` already handed to this delivery, not a new increment.
     * @param {string} id
     * @param {'pending' | 'resolved'} event
     * @param {Record<string, unknown>} card
     * @param {number} now
     * @param {{ pending: number, resolved: number }} seqs
     */
    saveOccurrence(id, event, card, now, seqs) {
      const write = () => {
        saveCard.run(id, event, JSON.stringify(card), now);
        saveSeq.run(id, seqs.pending, seqs.resolved);
      };
      if (typeof sql.transaction === 'function') sql.transaction(write);
      else write();
    },
    purgeResolved() {
      const row = countResolved.get();
      const extra = Number(row && row.n) - RESOLVED_ROW_CAP;
      if (!Number.isFinite(extra) || extra <= 0) return;
      deleteOldestResolved.run(extra);
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
  let busy = false;
  /** @type {Array<{ event: 'pending' | 'resolved', card: Record<string, unknown>, id: string, key: string, occurrence: number, seqs: { pending: number, resolved: number } }>} */
  const queue = [];
  /** Keys of jobs that are queued or in flight. */
  const inflight = new Set();
  let active = 0;
  let outstanding = 0;
  let deliveryIdle = Promise.resolve();
  let markDeliveryIdle = () => {};

  /**
   * `projectCard` refused this value. The id is logged when it is a string.
   * The card body is not. The caller still keeps the raw id as seen.
   * @param {unknown} raw
   */
  function noteDropped(raw) {
    if (!isPlain(raw) || typeof raw.id !== 'string') {
      log('pending card dropped');
      return;
    }
    const id = raw.id.replace(/[\u0000\r\n]/g, '').slice(0, DROPPED_ID_MAX);
    log(`pending card dropped id=${id}`);
  }

  function noteQueued() {
    if (outstanding === 0) {
      deliveryIdle = new Promise((resolve) => {
        markDeliveryIdle = resolve;
      });
    }
    outstanding += 1;
  }

  function noteFinished() {
    outstanding -= 1;
    if (outstanding === 0) markDeliveryIdle();
  }

  /**
   * @param {'pending' | 'resolved'} event
   * @param {Record<string, unknown>} card
   * @param {number} occurrence
   * @param {{ pending: number, resolved: number }} seqs
   * @returns {boolean} `false` when the global ceiling refused the job.
   */
  function acceptDelivery(event, card, occurrence, seqs) {
    const id = String(card.id);
    const key = `${event}:${id}`;
    if (inflight.has(key)) return true;
    if (outstanding >= DELIVERY_QUEUE_CAP) return false;
    inflight.add(key);
    noteQueued();
    queue.push({ event, card, id, key, occurrence, seqs });
    pump();
    return true;
  }

  function pump() {
    while (!stopped && active < DELIVERY_CONCURRENCY && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      active += 1;
      void runDelivery(job);
    }
  }

  /**
   * @param {{ event: 'pending' | 'resolved', card: Record<string, unknown>, id: string, key: string, occurrence: number, seqs: { pending: number, resolved: number } }} job
   */
  async function runDelivery(job) {
    try {
      if (!stopped) await emit(job.event, job.card, job.occurrence);
    } catch {
      /* deliverWebhook already bounds its own failures */
    } finally {
      active -= 1;
    }
    if (!stopped) {
      try {
        store.saveOccurrence(job.id, job.event, job.card, now(), job.seqs);
        if (job.event === 'resolved') store.purgeResolved();
      } catch {
        log(`pending card record failed id=${job.id}`);
      }
    }
    inflight.delete(job.key);
    noteFinished();
    pump();
  }

  /**
   * Projected cards, plus every raw id the daemon still lists.
   * `null` when the list cannot be trusted.
   * @returns {Promise<{ cards: Record<string, unknown>[], seen: Set<string> } | null>}
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
    const seen = new Set();
    for (const raw of result.json.pending) {
      if (isPlain(raw) && typeof raw.id === 'string' && raw.id.length > 0) seen.add(raw.id);
      const card = projectCard(raw);
      if (!card) {
        noteDropped(raw);
        continue;
      }
      seen.add(String(card.id));
      cards.push(card);
    }
    cards.sort((a, b) => Number(a.created_at) - Number(b.created_at) || String(a.id).localeCompare(String(b.id)));
    return { cards, seen };
  }

  /**
   * @param {'pending' | 'resolved'} event
   * @param {Record<string, unknown>} card
   * @param {number} occurrence
   */
  async function emit(event, card, occurrence) {
    if (!webhook) return true;
    return deliverWebhook({
      url: webhook.url,
      secret: webhook.secret,
      event,
      card,
      occurrence,
      sleep,
      log,
      now,
    });
  }

  /**
   * @param {'pending' | 'resolved'} event
   * @param {Record<string, unknown>} card
   * @returns {boolean} `false` when the job did not fit and was not recorded.
   */
  function recordOrEnqueue(event, card) {
    const id = String(card.id);
    if (!webhook) {
      store.save(id, event, card, now());
      if (event === 'resolved') store.purgeResolved();
      return true;
    }
    // Read the count, do not write it. The write waits until this delivery
    // is recorded, so a restart before that record sends this same id again.
    const { occurrence, seqs } = store.nextSeqs(id, event);
    return acceptDelivery(event, card, occurrence, seqs);
  }

  async function once() {
    if (stopped) return;
    const loaded = await readCards();
    if (!loaded) return;
    const { cards, seen } = loaded;
    let queueFull = false;
    for (const card of cards) {
      if (stopped) return;
      const id = String(card.id);
      const row = store.get(id);
      const text = JSON.stringify(card);
      if (row && row.event === 'pending') {
        if (row.projection !== text) store.save(id, 'pending', card, now());
        continue;
      }
      if (inflight.has(`pending:${id}`)) continue;
      if (!recordOrEnqueue('pending', card)) queueFull = true;
    }
    for (const row of store.open()) {
      if (stopped) return;
      if (seen.has(row.id)) continue;
      if (inflight.has(`pending:${row.id}`) || inflight.has(`resolved:${row.id}`)) continue;
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
      if (!recordOrEnqueue('resolved', card)) queueFull = true;
    }
    if (!stopped) store.purgeResolved();
    if (queueFull) log('pending delivery queue is full');
  }

  function poll() {
    if (busy) return chain;
    busy = true;
    const run = chain.then(async () => {
      try {
        await once();
      } finally {
        busy = false;
      }
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  return {
    poll,
    idle() {
      return chain.then(() => deliveryIdle);
    },
    stop() {
      stopped = true;
      const dropped = queue.splice(0);
      for (const job of dropped) {
        inflight.delete(job.key);
        noteFinished();
      }
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
        const card = projectListedCard(raw);
        if (!card) {
          noteDropped(raw);
          continue;
        }
        if (missionId && card.mission_id !== missionId) continue;
        cards.push(card);
      }
      cards.sort((a, b) => Number(a.created_at) - Number(b.created_at) || String(a.id).localeCompare(String(b.id)));
      return cards.slice(0, limit);
    },
  };
}
