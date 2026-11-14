/** Largest body this plugin will read itself. Public paths are already capped at 64 KB. */
const BODY_LIMIT = 64 * 1024;

/**
 * Header lookup that keeps an empty value. An empty identity header is a
 * refusal, not a missing header.
 * @param {object | null | undefined} req
 * @param {string} name
 * @returns {string | undefined}
 */
export function requestHeader(req, name) {
  const key = String(name || '').toLowerCase();
  if (!key || !req || typeof req !== 'object') return undefined;
  if (typeof req.get === 'function') {
    const value = req.get(name);
    if (typeof value === 'string') return value;
  }
  const headers = /** @type {{ headers?: Record<string, unknown> }} */ (req).headers;
  const raw = headers ? headers[key] : undefined;
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : undefined;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * JSON is parsed by the daemon. HTML forms and the token endpoint arrive as
 * `application/x-www-form-urlencoded`, which the daemon does not parse: the
 * handler reads that stream itself. Tests may also hand over an object or a
 * string already placed on `req.body`.
 * @param {object} req
 * @returns {Promise<{ fields: Record<string, unknown> } | { error: 'body_too_large' }>}
 */
export async function readBody(req) {
  const type = (requestHeader(req, 'content-type') || '').toLowerCase();
  if (type.includes('application/json')) {
    const body = req && req.body;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !Array.isArray(body)) {
      return { fields: /** @type {Record<string, unknown>} */ (body) };
    }
    return { fields: {} };
  }
  if (req && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) {
    return { fields: /** @type {Record<string, unknown>} */ (req.body) };
  }
  if (req && typeof req.body === 'string') return { fields: parseForm(req.body) };
  if (Buffer.isBuffer(req && req.body)) return { fields: parseForm(req.body.toString('utf8')) };
  if (type.includes('application/x-www-form-urlencoded') || type === '') {
    if (req && typeof req.on === 'function') {
      const raw = await readStream(req);
      if (raw === null) return { error: 'body_too_large' };
      return { fields: parseForm(raw) };
    }
  }
  return { fields: {} };
}

/**
 * @param {string} raw
 * @returns {Record<string, string>}
 */
function parseForm(raw) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const [key, value] of new URLSearchParams(raw)) fields[key] = value;
  return fields;
}

/**
 * @param {object} req
 * @returns {Promise<string | null>} null when the body exceeds the limit
 */
function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        settled = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
  });
}

/**
 * `Authorization: Bearer <token>`. A missing header is not the same as a
 * present but unusable one: only the latter carries `error="invalid_token"`.
 * @param {object | null | undefined} req
 * @returns {{ present: false } | { present: true, token: string }}
 */
export function presentedBearer(req) {
  const raw = requestHeader(req, 'authorization');
  if (raw === undefined) return { present: false };
  const match = /^Bearer[ \t]+(\S+)\s*$/i.exec(raw);
  if (!match || match[1].length > 512) return { present: true, token: '' };
  return { present: true, token: match[1] };
}
