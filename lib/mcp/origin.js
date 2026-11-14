/**
 * DNS-rebinding check required by Streamable HTTP (2025-03-26 and 2025-06-18).
 * A missing Origin is a non-browser client and is allowed. A present Origin
 * must name the same host as `Host`.
 *
 * An explicit port on `Host` must match the Origin port (written, or the
 * scheme default). A `Host` without a port accepts a port-less Origin of
 * either scheme. Behind TLS the daemon often sees `Host: example.com` while
 * the browser sends `Origin: https://example.com`. Building the expected URL
 * as `http://` would compare port 80 with 443 and reject that same-origin
 * request. `req.protocol` is not used: the connection to the daemon can stay
 * `http` after TLS is terminated upstream.
 * @param {object} req
 * @returns {string | null} a refusal reason, or null when the request may proceed
 */
export function foreignOrigin(req) {
  const origin = header(req, 'origin');
  if (origin == null || origin === '') return null;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return 'Origin is not a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Origin is not http(s)';
  }
  const host = header(req, 'host');
  if (!host) return 'Origin does not match this host';
  let expected;
  try {
    expected = new URL(`http://${host}`);
  } catch {
    return 'Origin does not match this host';
  }
  if (expected.hostname !== parsed.hostname) return 'foreign Origin';
  if (hostHasExplicitPort(host)) {
    if (expected.port !== originPort(parsed)) return 'foreign Origin';
    return null;
  }
  if (parsed.port && parsed.port !== defaultPort(parsed.protocol)) return 'foreign Origin';
  return null;
}

/**
 * @param {string} host
 */
function hostHasExplicitPort(host) {
  if (host.startsWith('[')) return /\]:\d+$/.test(host);
  const colon = host.lastIndexOf(':');
  if (colon === -1) return false;
  return /^\d+$/.test(host.slice(colon + 1));
}

/**
 * @param {URL} parsed
 */
function originPort(parsed) {
  return parsed.port || defaultPort(parsed.protocol);
}

/**
 * @param {string} protocol
 */
function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : '80';
}

/**
 * @param {object} req
 * @param {string} name
 * @returns {string | undefined}
 */
export function header(req, name) {
  if (req && typeof req.get === 'function') {
    const value = req.get(name);
    if (typeof value === 'string' && value) return value;
  }
  const raw = req && req.headers ? req.headers[name.toLowerCase()] : undefined;
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : undefined;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * JSON is the only response this server produces. A client that explicitly
 * refuses `application/json` cannot be answered (there is no SSE stream).
 * A missing Accept header is tolerated: non-browser clients often omit it.
 * @param {object} req
 */
export function acceptsJson(req) {
  const accept = header(req, 'accept');
  if (!accept) return true;
  const types = accept.split(',').map((part) => part.split(';')[0].trim().toLowerCase());
  return types.some((type) => type === 'application/json' || type === 'application/*' || type === '*/*');
}
