import {
  DEFAULT_EXPECTED_RIGHT,
  DEFAULT_IDENTITY_HEADER,
  OAUTH_SCOPE,
  SETTING_EMAIL_ALLOWLIST,
  SETTING_EXPECTED_RIGHT,
  SETTING_IDENTITY_HEADER,
  SETTING_ISSUER,
  SETTING_PUBLIC_URL,
  SETTING_RESOURCE,
} from '../constants.js';

/**
 * @param {object | null | undefined} ctx
 * @param {string} key
 * @returns {string | undefined} trimmed string, `''` when set empty, undefined when unset
 */
export function readSetting(ctx, key) {
  try {
    if (!ctx || !ctx.settings || typeof ctx.settings.get !== 'function') return undefined;
    const value = ctx.settings.get(key);
    if (typeof value !== 'string') return undefined;
    return value.trim();
  } catch {
    return undefined;
  }
}

/**
 * Absolute http(s) URL without userinfo, query or fragment.
 * A trailing slash on the path is removed. The origin form has no path.
 * @param {string | undefined} value
 * @returns {string | null}
 */
export function canonicalUrl(value) {
  if (typeof value !== 'string' || !value || /[\s\\"]/.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash || url.search) {
    return null;
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  const canonical = `${url.protocol}//${url.host}${path}`;
  // A quote or a comma would break the WWW-Authenticate challenge.
  if (/["\\\s,]/.test(canonical)) return null;
  return canonical;
}

/**
 * Public URL, issuer and MCP resource. Any missing or invalid value means
 * OAuth is not configured: callers answer with an explicit error.
 * @param {object | null | undefined} ctx
 * @returns {{ publicUrl: string, issuer: string, resource: string } | null}
 */
export function readOauthConfig(ctx) {
  const publicUrl = canonicalUrl(readSetting(ctx, SETTING_PUBLIC_URL));
  const issuer = canonicalUrl(readSetting(ctx, SETTING_ISSUER));
  const resource = canonicalUrl(readSetting(ctx, SETTING_RESOURCE));
  if (!publicUrl || !issuer || !resource) return null;
  return { publicUrl, issuer, resource };
}

/**
 * @param {object | null | undefined} ctx
 * @param {boolean} invalid
 * @returns {string}
 */
export function challengeHeader(ctx, invalid) {
  const publicUrl = canonicalUrl(readSetting(ctx, SETTING_PUBLIC_URL));
  if (!publicUrl) return invalid ? 'Bearer error="invalid_token"' : 'Bearer';
  const base = `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`;
  return invalid ? `${base}, error="invalid_token"` : base;
}

/**
 * @param {{ issuer: string }} config
 */
export function authorizationServerMetadata(config) {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oauth/authorize`,
    token_endpoint: `${config.issuer}/oauth/token`,
    registration_endpoint: `${config.issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
  };
}

/**
 * @param {{ issuer: string, resource: string }} config
 */
export function protectedResourceMetadata(config) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [OAUTH_SCOPE],
  };
}

/**
 * Header name, documentary right, and email allowlist.
 * An unset or blank header name uses the built-in default.
 * An empty allowlist refuses every address.
 * @param {object | null | undefined} ctx
 */
export function readIdentityOptions(ctx) {
  const configured = readSetting(ctx, SETTING_IDENTITY_HEADER);
  const headerName = configured || DEFAULT_IDENTITY_HEADER;
  const right = readSetting(ctx, SETTING_EXPECTED_RIGHT) || DEFAULT_EXPECTED_RIGHT;
  const allowlist = parseAllowlist(readSetting(ctx, SETTING_EMAIL_ALLOWLIST) ?? '');
  return { headerName, right, allowlist };
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
export function parseAllowlist(raw) {
  /** @type {string[]} */
  const out = [];
  for (const part of String(raw).split(/[\s,;]+/)) {
    const email = normalizeEmail(part);
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}

/**
 * @param {string} value
 * @returns {string | null}
 */
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  return email;
}

/**
 * https anywhere, or http limited to localhost and 127.0.0.1 (any port, any path).
 * @param {string} value
 */
export function isAllowedRedirect(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value !== value.trim()) return false;
  if (/[\s\\]/.test(value) || value.includes('#')) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.href !== value && url.href !== `${value}/` && !sameRedirect(url, value)) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1';
}

/**
 * `new URL` may add a trailing slash on an empty path. The registered string
 * is kept as the client sent it when the only difference is that slash.
 * @param {URL} url
 * @param {string} value
 */
function sameRedirect(url, value) {
  if (url.pathname !== '/' || value.endsWith('/')) return false;
  return `${url.origin}${url.search}` === value || url.origin === value;
}
