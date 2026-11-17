/**
 * Outbound webhook for a pending or resolved card.
 *
 * The URL comes from the host environment. The secret comes from the same
 * environment and is never written to a log, a journal, or the body.
 * Redirects are not followed. A delivery is tried a fixed number of times
 * and then abandoned. The abandonment log names the event and the card id.
 * It does not include the body.
 */
import { createHmac } from 'node:crypto';
import { scrubValue } from './daemon.js';

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
  return { url, secret };
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
 * @param {(ms: number) => Promise<void>} options.sleep
 * @param {(message: string) => void} options.log
 * @param {() => number} [options.now]
 * @returns {Promise<boolean>} `false` after the bounded retries are exhausted.
 */
export async function deliverWebhook(options) {
  const secret = options.secret;
  const scrubbed = scrubValue({ event: options.event, card: options.card }, [secret]);
  const body = JSON.stringify(scrubbed);
  const id = typeof options.card.id === 'string' ? options.card.id : '';
  for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt += 1) {
    const timestamp = String((options.now ?? Date.now)());
    const signature = signWebhook(secret, timestamp, body);
    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-timon-timestamp': timestamp,
          'x-timon-signature': `v1=${signature}`,
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
  options.log(`pending webhook abandoned event=${options.event} id=${id}`);
  return false;
}
