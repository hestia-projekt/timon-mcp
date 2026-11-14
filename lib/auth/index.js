import { assertPluginMount } from '../http.js';
import {
  ACCESS_TTL_MS,
  BEARER_SECRET,
  OAUTH_SCOPE,
  SETTING_RESOURCE,
} from '../constants.js';
import { presentedBearer, readBody } from './body.js';
import {
  authorizationServerMetadata,
  canonicalUrl,
  challengeHeader,
  isAllowedRedirect,
  protectedResourceMetadata,
  readOauthConfig,
  readSetting,
} from './config.js';
import { digestEqual, sha256Buffer } from './crypto.js';
import { createIdentityResolver } from './identity.js';
import {
  sendConsent,
  sendIdentityRefusal,
  sendNotConfigured,
  sendRefusal,
} from './pages.js';
import {
  accessIsValid,
  approveConsent,
  createConsent,
  denyConsent,
  exchangeCode,
  findClient,
  registerClient,
  rotateRefresh,
} from './store.js';

const CHALLENGE = /^[A-Za-z0-9\-_]{43,128}$/;

/**
 * Bearer check for `POST /mcp`. The identity header is not consulted.
 * A missing credential omits `error`. An unusable, expired or wrong-audience
 * token sets `error="invalid_token"`.
 * @param {object | null | undefined} req
 * @param {object | null | undefined} [ctx]
 * @returns {Promise<{ ok: true } | { ok: false, status: number, message: string, wwwAuthenticate: string }>}
 */
export async function authenticate(req, ctx) {
  if (!req || typeof req !== 'object') {
    return {
      ok: false,
      status: 400,
      message: 'missing request',
      wwwAuthenticate: challengeHeader(ctx, true),
    };
  }
  const presented = presentedBearer(req);
  if (!presented.present) {
    return {
      ok: false,
      status: 401,
      message: 'authentication required',
      wwwAuthenticate: challengeHeader(ctx, false),
    };
  }
  if (!presented.token || !(await staticMatches(ctx, presented.token))) {
    const resource = canonicalUrl(readSetting(ctx, SETTING_RESOURCE));
    let oauth = false;
    if (presented.token) {
      try {
        oauth = accessIsValid(ctx, presented.token, resource);
      } catch {
        oauth = false;
      }
    }
    if (!oauth) {
      return {
        ok: false,
        status: 401,
        message: 'invalid token',
        wwwAuthenticate: challengeHeader(ctx, true),
      };
    }
  }
  return { ok: true };
}

/**
 * OAuth 2.1 routes. The plugin is both the resource and the authorization
 * server. Paths avoid a dot so they can sit in `routes.publicPaths`; the
 * public `/.well-known` URLs are rewrites, documented in the README.
 * @param {{ get: Function, post?: Function, use: Function }} router
 * @param {object} ctx
 */
export function mountAuth(router, ctx) {
  assertPluginMount(router, ctx, 'auth');
  const get = router.get.bind(router);
  const post = typeof router.post === 'function' ? router.post.bind(router) : null;
  get('/oauth/protected-resource', (req, res) => guard(res, ctx, () => sendResourceMetadata(res, ctx)));
  get('/oauth/authorization-server', (req, res) => guard(res, ctx, () => sendServerMetadata(res, ctx)));
  if (post) {
    post('/oauth/register', (req, res) => guard(res, ctx, () => register(req, res, ctx)));
    post('/oauth/authorize', (req, res) => guard(res, ctx, () => authorizePost(req, res, ctx)));
    post('/oauth/token', (req, res) => guard(res, ctx, () => token(req, res, ctx)));
  }
  get('/oauth/authorize', (req, res) => guard(res, ctx, () => authorizeGet(req, res, ctx)));
}

/**
 * @param {object} res
 * @param {object} ctx
 * @param {() => Promise<void> | void} fn
 */
async function guard(res, ctx, fn) {
  try {
    await fn();
  } catch (error) {
    if (!res.headersSent) {
      note(ctx, `oauth: request failed (${error && error.name})`);
      sendOAuthError(res, 500, 'server_error', 'The authorization server could not complete the request.');
    }
  }
}

/**
 * @param {object} res
 * @param {object} ctx
 */
function sendResourceMetadata(res, ctx) {
  const config = readOauthConfig(ctx);
  if (!config) return sendNotConfiguredJson(res);
  res.status(200).json(protectedResourceMetadata(config));
}

/**
 * @param {object} res
 * @param {object} ctx
 */
function sendServerMetadata(res, ctx) {
  const config = readOauthConfig(ctx);
  if (!config) return sendNotConfiguredJson(res);
  res.status(200).json(authorizationServerMetadata(config));
}

/**
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 */
async function register(req, res, ctx) {
  const config = readOauthConfig(ctx);
  if (!config) return sendNotConfiguredJson(res);
  const body = await readBody(req);
  if ('error' in body) return sendOAuthError(res, 413, 'invalid_client_metadata', 'The request body is too large.');
  const metadata = body.fields;
  if (Object.prototype.hasOwnProperty.call(metadata, 'client_secret')) {
    return sendOAuthError(res, 400, 'invalid_client_metadata', 'Only public clients are accepted.');
  }
  const authMethod = metadata.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== 'none') {
    return sendOAuthError(res, 400, 'invalid_client_metadata', 'Only public clients are accepted.');
  }
  const grants = stringList(metadata.grant_types);
  if (grants && grants.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token')) {
    return sendOAuthError(res, 400, 'invalid_client_metadata', 'Unsupported grant type.');
  }
  if (grants && !grants.includes('authorization_code')) {
    return sendOAuthError(res, 400, 'invalid_client_metadata', 'authorization_code is required.');
  }
  const responses = stringList(metadata.response_types);
  if (responses && responses.some((item) => item !== 'code')) {
    return sendOAuthError(res, 400, 'invalid_client_metadata', 'Only the code response type is accepted.');
  }
  const uris = stringList(metadata.redirect_uris);
  if (!uris || uris.length === 0 || uris.length > 8) {
    return sendOAuthError(res, 400, 'invalid_redirect_uri', 'A public redirect_uri is required.');
  }
  if (new Set(uris).size !== uris.length || uris.some((uri) => !isAllowedRedirect(uri))) {
    return sendOAuthError(res, 400, 'invalid_redirect_uri', 'redirect_uri must be https, or http on localhost or 127.0.0.1.');
  }
  const stored = registerClient(ctx, { name: clientName(metadata.client_name), redirectUris: uris });
  if (!stored.ok && stored.reason === 'limit') {
    return sendOAuthError(res, 403, 'invalid_client_metadata', 'The client registration limit is reached.');
  }
  if (!stored.ok) {
    return sendOAuthError(res, 503, 'server_error', 'The authorization server could not complete the request.');
  }
  note(ctx, 'oauth: client registered');
  res.set('Cache-Control', 'no-store');
  res.status(201).json({
    client_id: stored.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName(metadata.client_name),
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: OAUTH_SCOPE,
  });
}

/**
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 */
function authorizeGet(req, res, ctx) {
  const config = readOauthConfig(ctx);
  if (!config) return sendNotConfigured(res);
  const clientId = queryValue(req, 'client_id');
  const redirectUri = queryValue(req, 'redirect_uri');
  const client = findClient(ctx, clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    return sendRefusal(res, 400, 'The client or the redirect_uri is not registered.');
  }
  const identity = createIdentityResolver(ctx).resolve(req);
  if (!identity) {
    note(ctx, 'oauth: authorization refused');
    return sendIdentityRefusal(res, createIdentityResolver(ctx).rightName());
  }
  const problem = authorizeProblem(req, config);
  if (problem) {
    note(ctx, 'oauth: authorization refused');
    redirectTo(res, redirectUri, { error: problem, state: validState(queryValue(req, 'state')) });
    return;
  }
  const consent = createConsent(ctx, {
    clientId,
    redirectUri,
    codeChallenge: queryValue(req, 'code_challenge'),
    resource: config.resource,
    subject: identity.subject,
    state: validState(queryValue(req, 'state')),
  });
  if (!consent) return sendNotConfigured(res);
  sendConsent(res, {
    requestId: consent.requestId,
    csrf: consent.csrf,
    clientName: client.name,
    redirectUri,
    resource: config.resource,
  });
}

/**
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 */
async function authorizePost(req, res, ctx) {
  const config = readOauthConfig(ctx);
  if (!config) return sendNotConfigured(res);
  const body = await readBody(req);
  if ('error' in body) return sendRefusal(res, 413, 'The request body is too large.');
  const identity = createIdentityResolver(ctx).resolve(req);
  if (!identity) {
    note(ctx, 'oauth: authorization refused');
    return sendIdentityRefusal(res, createIdentityResolver(ctx).rightName());
  }
  const requestId = textField(body.fields, 'request_id');
  const csrf = textField(body.fields, 'csrf');
  const decision = textField(body.fields, 'decision');
  if (decision === 'deny') {
    const denied = denyConsent(ctx, requestId, csrf, identity.subject, config.resource);
    if (!denied) return sendRefusal(res, 400, 'The request has expired or does not match.');
    note(ctx, 'oauth: authorization refused');
    redirectTo(res, denied.redirectUri, { error: 'access_denied', state: denied.state });
    return;
  }
  if (decision !== 'approve') return sendRefusal(res, 400, 'The decision is missing.');
  const issued = approveConsent(ctx, requestId, csrf, identity.subject, config.resource);
  if (!issued) return sendRefusal(res, 400, 'The request has expired or does not match.');
  note(ctx, 'oauth: code issued');
  redirectTo(res, issued.redirectUri, { code: issued.code, state: issued.state });
}

/**
 * @param {object} req
 * @param {object} res
 * @param {object} ctx
 */
async function token(req, res, ctx) {
  const config = readOauthConfig(ctx);
  if (!config) return sendNotConfiguredJson(res);
  const body = await readBody(req);
  if ('error' in body) return sendOAuthError(res, 413, 'invalid_request', 'The request body is too large.');
  const fields = body.fields;
  if (Object.prototype.hasOwnProperty.call(fields, 'client_secret') && textField(fields, 'client_secret')) {
    return sendOAuthError(res, 401, 'invalid_client', 'Public clients do not use a client secret.');
  }
  const clientId = textField(fields, 'client_id');
  const client = findClient(ctx, clientId);
  if (!client) return sendOAuthError(res, 401, 'invalid_client', 'Unknown client.');
  const resource = canonicalUrl(textField(fields, 'resource'));
  if (!resource || resource !== config.resource) {
    return sendOAuthError(res, 400, 'invalid_target', 'The resource does not match this server.');
  }
  const grant = textField(fields, 'grant_type');
  if (grant === 'authorization_code') {
    const issued = exchangeCode(ctx, {
      code: textField(fields, 'code'),
      clientId,
      redirectUri: textField(fields, 'redirect_uri'),
      verifier: textField(fields, 'code_verifier'),
      resource,
    });
    if (!issued.ok) return sendOAuthError(res, 400, 'invalid_grant', 'The authorization code was refused.');
    note(ctx, 'oauth: tokens issued');
    return sendTokens(res, issued);
  }
  if (grant === 'refresh_token') {
    const issued = rotateRefresh(ctx, {
      refresh: textField(fields, 'refresh_token'),
      clientId,
      resource,
    });
    if (!issued.ok) return sendOAuthError(res, 400, 'invalid_grant', 'The refresh token was refused.');
    note(ctx, 'oauth: refresh rotated');
    return sendTokens(res, issued);
  }
  return sendOAuthError(res, 400, 'unsupported_grant_type', 'Unsupported grant type.');
}

/**
 * @param {object} req
 * @param {{ resource: string }} config
 * @returns {string | null}
 */
function authorizeProblem(req, config) {
  if (queryValue(req, 'response_type') !== 'code') return 'invalid_request';
  if (queryValue(req, 'code_challenge_method') !== 'S256') return 'invalid_request';
  if (!CHALLENGE.test(queryValue(req, 'code_challenge'))) return 'invalid_request';
  const resource = canonicalUrl(queryValue(req, 'resource'));
  if (!resource || resource !== config.resource) return 'invalid_target';
  const state = queryValue(req, 'state');
  if (state && validState(state) == null) return 'invalid_request';
  return null;
}

/**
 * @param {string} state
 * @returns {string | null}
 */
function validState(state) {
  if (!state) return null;
  if (state.length > 512 || /[\r\n]/.test(state)) return null;
  return state;
}

/**
 * @param {object} res
 * @param {string} uri
 * @param {Record<string, string | null | undefined>} params
 */
function redirectTo(res, uri, params) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    sendRefusal(res, 400, 'The redirect is invalid.');
    return;
  }
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  const location = url.toString();
  if (/[\r\n]/.test(location)) {
    sendRefusal(res, 400, 'The redirect is invalid.');
    return;
  }
  res.set('Location', location);
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.status(302).end('');
}

/**
 * @param {object} res
 * @param {{ access: string, refresh: string, expiresIn: number }} issued
 */
function sendTokens(res, issued) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.status(200).json({
    access_token: issued.access,
    token_type: 'Bearer',
    expires_in: issued.expiresIn || Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: issued.refresh,
    scope: OAUTH_SCOPE,
  });
}

/**
 * @param {object} res
 * @param {number} status
 * @param {string} error
 * @param {string} description
 */
function sendOAuthError(res, status, error, description) {
  res.set('Cache-Control', 'no-store');
  res.status(status).json({ error, error_description: description });
}

/**
 * @param {object} res
 */
function sendNotConfiguredJson(res) {
  sendOAuthError(res, 503, 'not_configured', 'Set public_url, issuer and resource in the plugin settings.');
}

/**
 * Constant-time comparison of SHA-256 digests. An absent secret disables the
 * static token and still runs the comparison.
 * @param {object | null | undefined} ctx
 * @param {string} token
 */
async function staticMatches(ctx, token) {
  let secret;
  try {
    secret = ctx && ctx.secrets && typeof ctx.secrets.get === 'function'
      ? await ctx.secrets.get(BEARER_SECRET)
      : undefined;
  } catch {
    secret = undefined;
  }
  const configured = typeof secret === 'string' && secret.length > 0;
  const same = digestEqual(sha256Buffer(token), sha256Buffer(configured ? secret : ''));
  return configured && same;
}

/**
 * @param {object} ctx
 * @param {string} message
 */
function note(ctx, message) {
  const logger = ctx && ctx.log;
  if (logger && typeof logger.info === 'function') logger.info(message);
}

/**
 * @param {object} req
 * @param {string} name
 */
function queryValue(req, name) {
  const value = req && req.query ? req.query[name] : undefined;
  return typeof value === 'string' ? value : '';
}

/**
 * @param {Record<string, unknown>} fields
 * @param {string} name
 */
function textField(fields, name) {
  const value = fields[name];
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {string[] | null}
 */
function stringList(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) return [];
  return value;
}

/**
 * @param {unknown} value
 */
function clientName(value) {
  if (typeof value !== 'string') return 'MCP client';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return cleaned || 'MCP client';
}
