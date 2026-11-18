/**
 * Outbound webhook for a pending or resolved card.
 *
 * The URL comes from the host environment. The secret comes from the same
 * environment and is never written to a log, a journal, or the body.
 * Redirects are not followed. A delivery is tried a fixed number of times
 * and then abandoned. The abandonment log names the event and the card id.
 * It does not include the body, the secret, or a signature.
 */
import { createHmac } from 'node:crypto';
import { scrubValue } from './daemon.js';

/** Standard Webhooks prefix. The remainder is canonical base64. */
const WHSEC_PREFIX = 'whsec_';

/** Tries per event, including the first. */
export const WEBHOOK_ATTEMPTS = 3;

/** Wait before the second and third tries. Bounded, and not configurable. */
export const WEBHOOK_BACKOFF_MS = Object.freeze([200, 800]);

const URL_MAX = 2000;
const SECRET_MIN = 16;
const SECRET_MAX = 512;
const DELIVERY_TIMEOUT_MS = 5_000;

/**
 * @param {string} raw
 * @returns {string}
 */
export function resolveWebhookUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > URL_MAX || raw !== raw.trim()) {
    throw new Error('pending webhook URL is invalid');
  }
  if (/[\s\u0000-\u001f]/.test(raw)) throw new Error('pending webhook URL is invalid');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('pending webhook URL is invalid');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('pending webhook URL is invalid');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) {
    return url.href;
  }
  throw new Error('pending webhook URL is invalid');
}

/**
 * `null` when no URL is configured: the host sends nothing.
 * A URL without a usable secret refuses to start. The secret is not echoed.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ url: string, secret: string } | null}
 */
export function resolveWebhookConfig(env) {
  const raw = env.TIMON_MCP_PENDING_WEBHOOK_URL;
  if (raw === undefined || raw === '') return null;
  const url = resolveWebhookUrl(raw);
  const secret = env.TIMON_MCP_PENDING_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || secret.length < SECRET_MIN || secret.length > SECRET_MAX || /[\r\n\u0000]/.test(secret)) {
    throw new Error('pending webhook secret is missing');
  }
  // Validates a `whsec_` secret before the process listens. The key is not kept.
  standardWebhookKey(secret);
  return { url, secret };
}

/**
 * Canonical base64 (RFC 4648 §4): alphabet, padding, and zero padding bits.
 * @param {string} encoded
 * @returns {Buffer | null}
 */
function decodeBase64Key(encoded) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/.test(encoded)) {
    return null;
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length === 0 || key.toString('base64') !== encoded) return null;
  return key;
}

/**
 * HMAC key for `webhook-signature`.
 * A `whsec_` secret uses the base64 payload. Any other secret is its UTF-8 bytes.
 * The `x-timon-signature` key stays the secret string.
 * @param {string} secret
 * @returns {Buffer}
 */
function standardWebhookKey(secret) {
  if (secret.startsWith(WHSEC_PREFIX)) {
    const key = decodeBase64Key(secret.slice(WHSEC_PREFIX.length));
    if (!key) throw new Error('pending webhook secret is not valid base64');
    return key;
  }
  return Buffer.from(secret, 'utf8');
}

/**
 * Forms of the secret that must not show up in a log or a body.
 * Longer needles first, so a short form cannot split a longer one.
 * @param {string} secret
 * @returns {string[]}
 */
export function webhookSecretNeedles(secret) {
  /** @type {string[]} */
  const needles = [];
  if (secret.length >= 8) needles.push(secret);
  if (secret.startsWith(WHSEC_PREFIX)) {
    const encoded = secret.slice(WHSEC_PREFIX.length);
    if (encoded.length >= 8) needles.push(encoded);
    const key = decodeBase64Key(encoded);
    if (key) {
      const utf8 = key.toString('utf8');
      if (utf8.length >= 8 && Buffer.from(utf8, 'utf8').equals(key)) needles.push(utf8);
      const hex = key.toString('hex');
      if (hex.length >= 8) needles.push(hex);
    }
  }
  needles.sort((a, b) => b.length - a.length);
  return needles;
}

/**
 * `<event>_<card id>_<occurrence>`. One occurrence, every attempt.
 * The next occurrence of that event for the card uses the next number.
 * Control characters are dropped so the value can be a header.
 * @param {string} event
 * @param {string} cardId
 * @param {number} occurrence
 */
function standardWebhookId(event, cardId, occurrence) {
  const n = Number(occurrence);
  // `0` is not a recorded occurrence. A bad count must not reuse `_1`.
  const seq = Number.isSafeInteger(n) && n >= 1 ? String(n) : '0';
  const safeId = cardId.replace(/[\u0000-\u001f\u007f]/g, '');
  return `${event}_${safeId}_${seq}`;
}

/**
 * Milliseconds between polls. Default 5s. Below 1s or above 60s is refused.
 * @param {unknown} raw
 */
export function readPendingInterval(raw) {
  if (raw === undefined || raw === '') return 5_000;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    throw new Error('TIMON_MCP_PENDING_INTERVAL_MS is invalid');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60_000) {
    throw new Error('TIMON_MCP_PENDING_INTERVAL_MS is invalid');
  }
  return value;
}

/**
 * @param {string} secret
 * @param {string} timestamp
 * @param {string} body
 */
export function signWebhook(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.secret
 * @param {'pending' | 'resolved'} options.event
 * @param {Record<string, unknown>} options.card
 * @param {number} options.occurrence Count of this event for this card, starting at 1.
 * @param {(ms: number) => Promise<void>} options.sleep
 * @param {(message: string) => void} options.log
 * @param {() => number} [options.now]
 * @returns {Promise<boolean>} `false` after the bounded retries are exhausted.
 */
export async function deliverWebhook(options) {
  const secret = options.secret;
  const key = standardWebhookKey(secret);
  const needles = webhookSecretNeedles(secret);
  const scrubbed = scrubValue({ event: options.event, card: options.card }, needles);
  const body = JSON.stringify(scrubbed);
  const id = typeof options.card.id === 'string' ? options.card.id : '';
  const webhookId = standardWebhookId(options.event, id, options.occurrence);
  /** @type {string[]} */
  const signatures = [];
  for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt += 1) {
    // Milliseconds stay the `x-timon-*` clock. Seconds are a separate header.
    const timestamp = String((options.now ?? Date.now)());
    const seconds = String(Math.floor(Number(timestamp) / 1000));
    const signature = signWebhook(secret, timestamp, body);
    const standard = createHmac('sha256', key).update(`${webhookId}.${seconds}.${body}`).digest('base64');
    signatures.push(signature, `v1=${signature}`, standard, `v1,${standard}`);
    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-timon-timestamp': timestamp,
          'x-timon-signature': `v1=${signature}`,
          'webhook-id': webhookId,
          'webhook-timestamp': seconds,
          'webhook-signature': `v1,${standard}`,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      try { await response.body?.cancel(); } catch { /* the status is enough */ }
      if (response.status >= 200 && response.status < 300) return true;
    } catch {
      /* unreachable, timed out, or a redirect the runtime refused to expose */
    }
    if (attempt < WEBHOOK_ATTEMPTS) await options.sleep(WEBHOOK_BACKOFF_MS[attempt - 1]);
  }
  const line = `pending webhook abandoned event=${options.event} id=${id}`;
  const clean = scrubValue(line, [...needles, ...signatures]);
  options.log(typeof clean === 'string' ? clean : 'pending webhook abandoned');
  return false;
}
