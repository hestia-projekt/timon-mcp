import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { authenticate } from '../../lib/auth/index.js';
import { BEARER_SECRET, MAX_DCR_CLIENTS, STALE_CLIENT_MS } from '../../lib/constants.js';
import { apply } from '../../lib/index.js';
import { createFakeCtx } from '../helpers/fake-ctx.js';

const PLUGIN = 'timon-mcp';
const PUBLIC = 'https://mcp.example';
const RESOURCE = `${PUBLIC}/mcp`;
const REDIRECT = 'https://client.example/cb';
const META = `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`;
const INVALID = `${META}, error="invalid_token"`;

test('OAuth metadata follows the protected-resource and authorization-server documents', async (t) => {
  const silent = await open(t, { settings: {} });
  const missingResource = await http(silent, '/oauth/protected-resource');
  const missingServer = await http(silent, '/oauth/authorization-server');
  assert.equal(missingResource.response.status, 503);
  assert.equal(missingResource.json.error, 'not_configured');
  assert.equal(missingServer.response.status, 503);
  assert.equal(missingServer.json.error, 'not_configured');

  const broken = await open(t, { settings: settings({ public_url: 'https://mcp.example/a"b' }) });
  assert.equal((await http(broken, '/oauth/protected-resource')).response.status, 503);

  const opened = await open(t, {
    settings: settings({
      public_url: `${PUBLIC}/`,
      issuer: 'https://issuer.example/',
      resource: `${RESOURCE}/`,
    }),
  });
  const resource = await http(opened, '/oauth/protected-resource');
  const server = await http(opened, '/oauth/authorization-server');
  assert.deepEqual(resource.json, {
    resource: RESOURCE,
    authorization_servers: ['https://issuer.example'],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  });
  assert.deepEqual(server.json, {
    issuer: 'https://issuer.example',
    authorization_endpoint: 'https://issuer.example/oauth/authorize',
    token_endpoint: 'https://issuer.example/oauth/token',
    registration_endpoint: 'https://issuer.example/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
});

test('dynamic registration accepts only public clients and bounded redirect URIs', async (t) => {
  const opened = await open(t, { settings: settings() });
  const created = await registerClient(opened, [
    REDIRECT,
    'http://localhost/cb',
    'http://127.0.0.1/cb',
  ]);
  assert.equal(created.response.status, 201);
  assert.equal(Object.hasOwn(created.json, 'client_secret'), false);
  assert.equal(created.json.token_endpoint_auth_method, 'none');
  assert.deepEqual(created.json.grant_types, ['authorization_code', 'refresh_token']);
  assert.equal(typeof created.json.client_id, 'string');

  const refused = [
    { redirect_uris: ['http://localhost.evil.com/cb'] },
    { redirect_uris: ['http://127.0.0.1.evil.com/cb'] },
    { redirect_uris: ['http://client.example/cb'] },
    { redirect_uris: ['https://client.example/cb#fragment'] },
    { redirect_uris: ['https://user:pass@client.example/cb'] },
    { redirect_uris: [REDIRECT, REDIRECT] },
    { redirect_uris: [] },
    { redirect_uris: [REDIRECT], client_secret: 'not-issued' },
    { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' },
    { redirect_uris: [REDIRECT], grant_types: ['password'] },
    { redirect_uris: [REDIRECT], grant_types: ['refresh_token'] },
    { redirect_uris: Array.from({ length: 9 }, (_, index) => `https://client.example/cb/${index}`) },
  ];
  for (const body of refused) {
    const response = await registerClient(opened, body.redirect_uris, body);
    assert.equal(response.response.status, 400, JSON.stringify(Object.keys(body)));
    assert.equal(Object.hasOwn(response.json, 'client_secret'), false);
  }
});

test('registration stops at the client cap', async (t) => {
  const opened = await open(t, { settings: settings() });
  const insert = opened.ctx.sql.prepare(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
  );
  for (let index = 0; index < MAX_DCR_CLIENTS; index += 1) {
    insert.run(`client-${index}`, 'n', '[]', Date.now());
  }
  const response = await registerClient(opened, [REDIRECT]);
  assert.equal(response.response.status, 403);
  assert.equal(response.json.error, 'invalid_client_metadata');
});

test('registration reclaims stale clients that hold nothing live', async (t) => {
  const opened = await open(t, { settings: settings() });
  const stale = Date.now() - STALE_CLIENT_MS - 1000;
  const insert = opened.ctx.sql.prepare(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
  );
  const revoked = opened.ctx.sql.prepare(
    `INSERT INTO oauth_tokens
      (token_hash, kind, client_id, resource, subject, family_id, expires_at, revoked_at, created_at)
     VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let index = 0; index < MAX_DCR_CLIENTS; index += 1) {
    const clientId = `stale-${index}`;
    insert.run(clientId, 'n', '[]', stale);
    revoked.run(`revoked-${index}`, clientId, RESOURCE, 'subject', `family-${index}`, Date.now() + 60_000, stale, stale);
  }
  const response = await registerClient(opened, [REDIRECT]);
  assert.equal(response.response.status, 201);
  assert.equal(typeof response.json.client_id, 'string');
  assert.equal(count(opened, 'oauth_clients'), 1);
  const kept = opened.ctx.sql.prepare('SELECT client_id FROM oauth_clients').get();
  assert.equal(kept.client_id, response.json.client_id);
});

test('registration keeps the cap when stale clients still hold a live token', async (t) => {
  const opened = await open(t, { settings: settings() });
  const now = Date.now();
  const stale = now - STALE_CLIENT_MS - 1000;
  const later = now + 60_000;
  const insert = opened.ctx.sql.prepare(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
  );
  const token = opened.ctx.sql.prepare(
    `INSERT INTO oauth_tokens
      (token_hash, kind, client_id, resource, subject, family_id, expires_at, revoked_at, created_at)
     VALUES (?, 'access', ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const code = opened.ctx.sql.prepare(
    `INSERT INTO oauth_codes
      (code_hash, client_id, redirect_uri, code_challenge, resource, subject, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const consent = opened.ctx.sql.prepare(
    `INSERT INTO oauth_requests
      (request_id, csrf_hash, client_id, redirect_uri, code_challenge, resource, subject, state, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  for (let index = 0; index < MAX_DCR_CLIENTS; index += 1) {
    const clientId = `live-${index}`;
    insert.run(clientId, 'n', '[]', stale);
    if (index === 0) {
      code.run(`code-${index}`, clientId, REDIRECT, 'challenge', RESOURCE, 'subject', later);
    } else if (index === 1) {
      consent.run(`request-${index}`, `csrf-${index}`, clientId, REDIRECT, 'challenge', RESOURCE, 'subject', later);
    } else {
      token.run(`hash-${index}`, clientId, RESOURCE, 'subject', `family-${index}`, later, stale);
    }
  }
  const response = await registerClient(opened, [REDIRECT]);
  assert.equal(response.response.status, 403);
  assert.equal(response.json.error, 'invalid_client_metadata');
  assert.equal(count(opened, 'oauth_clients'), MAX_DCR_CLIENTS);
});

test('authorization issues a code only for an allowlisted identity', async (t) => {
  const address = email();
  const other = email();
  const opened = await open(t, { settings: settings({ email_allowlist: address }) });
  const registered = await registerClient(opened, [REDIRECT]);
  const clientId = registered.json.client_id;
  const { challenge } = pair();

  const absent = await authorize(opened, clientId, challenge, undefined);
  assert.equal(absent.response.status, 403);
  assert.equal(absent.response.headers.get('location'), null);
  assert.equal(absent.text.includes('Aucun code'), true);
  assert.equal(absent.text.includes(address), false);
  assert.equal(absent.text.includes('timon'), true);
  assert.equal(count(opened, 'oauth_codes'), 0);

  const empty = await authorize(opened, clientId, challenge, '');
  assert.equal(empty.response.status, 403);
  assert.equal(count(opened, 'oauth_codes'), 0);

  const outsider = await authorize(opened, clientId, challenge, other);
  assert.equal(outsider.response.status, 403);
  assert.equal(outsider.text.includes(other), false);
  assert.equal(count(opened, 'oauth_codes'), 0);

  opened.state.settings.email_allowlist = '';
  const closed = await authorize(opened, clientId, challenge, address);
  assert.equal(closed.response.status, 403);
  assert.equal(count(opened, 'oauth_codes'), 0);

  opened.state.settings.email_allowlist = address;
  opened.state.settings.identity_header = '';
  const unnamed = await authorize(opened, clientId, challenge, address);
  assert.equal(unnamed.response.status, 200);
  assert.equal(unnamed.text.includes('action=""'), true);
  assert.equal(unnamed.text.includes('Aucun code'), false);
  assert.equal(unnamed.text.includes(address), false);
  assert.equal(count(opened, 'oauth_codes'), 0);
  const unnamedDenied = await approve(opened, unnamed.text, address, 'deny');
  assert.equal(unnamedDenied.response.status, 302);
  const unnamedLocation = new URL(unnamedDenied.response.headers.get('location'));
  assert.equal(unnamedLocation.searchParams.get('error'), 'access_denied');
  assert.equal(unnamedLocation.searchParams.get('code'), null);
  assert.equal(count(opened, 'oauth_codes'), 0);
  assert.equal(count(opened, 'oauth_requests'), 0);

  delete opened.state.settings.identity_header;
  const mixed = address.replace('ada.', 'Ada.');
  opened.state.settings.email_allowlist = address;
  const page = await authorize(opened, clientId, challenge, mixed);
  assert.equal(page.response.status, 200);
  assert.equal(page.text.includes(address), false);
  assert.equal(page.text.includes(mixed), false);
  assert.equal(page.text.includes('<script'), false);
  assert.equal(page.text.includes('<link'), false);
  assert.equal(page.text.includes('<img'), false);
  assert.equal(page.text.includes('action=""'), true);
  assert.equal(page.response.headers.get('x-content-type-options'), 'nosniff');
  const csrf = hidden(page.text, 'csrf');
  const requestId = hidden(page.text, 'request_id');
  const stored = opened.ctx.sql.prepare('SELECT csrf_hash, subject FROM oauth_requests WHERE request_id = ?').get(requestId);
  assert.equal(stored.csrf_hash === csrf, false);
  assert.equal(stored.csrf_hash, sha256(csrf));
  assert.equal(stored.subject, sha256(address));

  const burned = await http(opened, '/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-ambactos-email': address,
    },
    body: form({ request_id: requestId, decision: 'approve' }),
  });
  assert.equal(burned.response.status, 400);
  assert.equal(burned.response.headers.get('location'), null);
  assert.equal(count(opened, 'oauth_codes'), 0);
  assert.equal(count(opened, 'oauth_requests'), 0);

  opened.state.settings.identity_header = 'x-user-email';
  const ignored = await authorize(opened, clientId, challenge, address);
  assert.equal(ignored.response.status, 403);
  const custom = await http(opened, authQuery(clientId, challenge), {
    headers: { 'x-user-email': address },
  });
  assert.equal(custom.response.status, 200);

  delete opened.state.settings.identity_header;
  const foreignRedirect = await authorize(opened, clientId, challenge, address, {
    redirect_uri: 'https://client.example/other',
  });
  assert.equal(foreignRedirect.response.status, 400);
  assert.equal(foreignRedirect.response.headers.get('location'), null);
  assert.equal(foreignRedirect.text.includes('Aucun code'), true);
  assert.equal(count(opened, 'oauth_codes'), 0);

  const plain = await authorize(opened, clientId, challenge, address, {
    code_challenge_method: 'plain',
  });
  assert.equal(plain.response.status, 302);
  const plainLocation = new URL(plain.response.headers.get('location'));
  assert.equal(plainLocation.searchParams.get('error'), 'invalid_request');
  assert.equal(plainLocation.searchParams.get('code'), null);
  assert.equal(count(opened, 'oauth_codes'), 0);

  const deniedPage = await authorize(opened, clientId, challenge, address);
  const denied = await approve(opened, deniedPage.text, address, 'deny');
  assert.equal(denied.response.status, 302);
  assert.equal(new URL(denied.response.headers.get('location')).searchParams.get('error'), 'access_denied');
  assert.equal(count(opened, 'oauth_codes'), 0);
});

test('PKCE S256, redirect binding and single-use codes', async (t) => {
  const address = email();
  const opened = await open(t, { settings: settings({ email_allowlist: address }) });
  const session = await login(opened, address);
  const row = opened.ctx.sql.prepare('SELECT expires_at, code_hash FROM oauth_codes').get();
  const skew = Number(row.expires_at) - Date.now();
  assert.equal(skew <= 60_000, true);
  assert.equal(skew > 45_000, true);
  assert.equal(row.code_hash, sha256(session.code));
  assert.equal(row.code_hash === session.code, false);

  const wrong = await exchange(opened, session, { code_verifier: pair().verifier });
  assert.equal(wrong.response.status, 400);
  assert.equal(wrong.json.error, 'invalid_grant');
  assert.equal(count(opened, 'oauth_codes'), 0);
  const again = await exchange(opened, session);
  assert.equal(again.response.status, 400);
  assert.equal(again.json.error, 'invalid_grant');

  const second = await login(opened, address);
  const moved = await exchange(opened, second, { redirect_uri: 'https://client.example/other' });
  assert.equal(moved.response.status, 400);
  assert.equal(moved.json.error, 'invalid_grant');
  const reused = await exchange(opened, second);
  assert.equal(reused.json.error, 'invalid_grant');

  const third = await login(opened, address);
  opened.ctx.sql.prepare('UPDATE oauth_codes SET expires_at = ?').run(Date.now() - 1000);
  const expired = await exchange(opened, third);
  assert.equal(expired.json.error, 'invalid_grant');

  const fourth = await login(opened, address);
  const otherResource = await exchange(opened, fourth, { resource: 'https://other.example/mcp' });
  assert.equal(otherResource.response.status, 400);
  assert.equal(otherResource.json.error, 'invalid_target');
  assert.equal(count(opened, 'oauth_codes'), 1);
  const recovered = await exchange(opened, fourth);
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.json.token_type, 'Bearer');
  assert.equal(recovered.json.expires_in, 900);
  assert.equal(recovered.json.scope, 'mcp');
  assert.equal(recovered.response.headers.get('cache-control'), 'no-store');
});

test('the authorization-code flow lists tools and rotates the refresh token', async (t) => {
  const address = email();
  const opened = await open(t, { settings: settings({ email_allowlist: address }) });
  const watch = spyConsole();
  const secrets = [];
  try {
    const session = await login(opened, address);
    secrets.push(session.code, session.verifier, address, hidden(session.page, 'csrf'));
    const issued = await exchange(opened, session);
    assert.equal(issued.response.status, 200);
    const access = issued.json.access_token;
    const refresh = issued.json.refresh_token;
    secrets.push(access, refresh);
    const listed = await mcp(opened, `Bearer ${access}`);
    assert.equal(listed.response.status, 200);
    assert.equal(listed.json.result.tools.length, 6);

    const rotated = await token(opened, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: session.clientId,
      resource: RESOURCE,
    });
    assert.equal(rotated.response.status, 200);
    const nextAccess = rotated.json.access_token;
    const nextRefresh = rotated.json.refresh_token;
    secrets.push(nextAccess, nextRefresh);
    assert.equal(nextAccess === access, false);
    assert.equal(nextRefresh === refresh, false);
    assert.equal((await mcp(opened, `Bearer ${access}`)).response.status, 200);
    assert.equal((await mcp(opened, `Bearer ${nextAccess}`)).response.status, 200);

    const rejected = await token(opened, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: session.clientId,
      resource: RESOURCE,
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.json.error, 'invalid_grant');
    assert.equal((await mcp(opened, `Bearer ${nextAccess}`)).response.status, 401);
    assert.equal((await token(opened, {
      grant_type: 'refresh_token',
      refresh_token: nextRefresh,
      client_id: session.clientId,
      resource: RESOURCE,
    })).json.error, 'invalid_grant');

    const cells = dump(opened);
    for (const secret of secrets) assert.equal(cells.includes(secret), false);
    assert.equal(cells.includes(sha256(access)), true);
    assert.equal(cells.includes(sha256(refresh)), true);
    const journal = `${watch.lines.join('\n')}\n${opened.state.logs.map((entry) => entry.message).join('\n')}`;
    for (const secret of secrets) assert.equal(journal.includes(secret), false);
    assert.equal(journal.includes(address), false);
    assert.equal(opened.state.logs.some((entry) => entry.message === 'oauth: tokens issued'), true);
    assert.equal(opened.state.logs.some((entry) => entry.message === 'oauth: refresh rotated'), true);
  } finally {
    watch.restore();
  }
});

test('POST /mcp rejects a missing, invalid, expired or wrong-audience bearer', async (t) => {
  const address = email();
  const opened = await open(t, { settings: settings({ email_allowlist: address }) });
  const missing = await mcp(opened, null);
  assert.equal(missing.response.status, 401);
  assert.equal(missing.response.headers.get('www-authenticate'), META);
  assert.deepEqual(missing.json, { error: 'unauthorized', message: 'authentication required' });

  const bogus = randomBytes(32).toString('base64url');
  const invalid = await mcp(opened, `Bearer ${bogus}`);
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.response.headers.get('www-authenticate'), INVALID);
  assert.deepEqual(invalid.json, { error: 'unauthorized', message: 'invalid token' });
  assert.equal(invalid.text.includes(bogus), false);

  const queried = await http(opened, `/mcp?access_token=${bogus}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(queried.response.status, 401);
  assert.equal(queried.response.headers.get('www-authenticate'), META);

  const session = await login(opened, address);
  const issued = await exchange(opened, session);
  const access = issued.json.access_token;
  opened.ctx.sql.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE token_hash = ? AND kind = ?')
    .run(Date.now() - 1000, sha256(access), 'access');
  const expired = await mcp(opened, `Bearer ${access}`);
  assert.equal(expired.response.status, 401);
  assert.equal(expired.response.headers.get('www-authenticate'), INVALID);

  const second = await login(opened, address);
  const fresh = await exchange(opened, second);
  opened.state.settings.resource = 'https://other.example/mcp';
  const audience = await mcp(opened, `Bearer ${fresh.json.access_token}`);
  assert.equal(audience.response.status, 401);
  assert.equal(audience.response.headers.get('www-authenticate'), INVALID);

  const bare = await open(t, { settings: {} });
  const noUrl = await mcp(bare, null);
  const badUrl = await mcp(bare, `Bearer ${bogus}`);
  assert.equal(noUrl.response.headers.get('www-authenticate'), 'Bearer');
  assert.equal(badUrl.response.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
});

test('the static bearer is read from the vault and ignored when it is absent', async (t) => {
  const token = randomBytes(32).toString('base64url');
  const opened = await open(t, {
    settings: settings(),
    secrets: { [BEARER_SECRET]: token },
  });
  const accepted = await mcp(opened, `bEaReR ${token}`);
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.json.result.tools.length, 6);

  const prefix = await mcp(opened, `Bearer ${token.slice(0, 12)}`);
  assert.equal(prefix.response.status, 401);

  const long = 'a'.repeat(513);
  opened.state.secrets.set(BEARER_SECRET, long);
  assert.equal((await mcp(opened, `Bearer ${long}`)).response.status, 401);

  opened.state.secrets.delete(BEARER_SECRET);
  assert.equal((await mcp(opened, `Bearer ${token}`)).response.status, 401);

  opened.ctx.secrets.get = async () => {
    throw new Error('vault unavailable');
  };
  assert.equal((await mcp(opened, `Bearer ${token}`)).response.status, 401);

  const unset = await open(t, { settings: settings(), secrets: {} });
  assert.equal((await mcp(unset, `Bearer ${token}`)).response.status, 401);
  assert.equal((await mcp(unset, 'Bearer')).response.status, 401);
});

test('an oauth failure logs the error name and not its message', async (t) => {
  const opened = await open(t, { settings: settings() });
  const secret = randomBytes(16).toString('hex');
  const watch = spyConsole();
  opened.ctx.sql.transaction = () => {
    const error = new Error(`boom ${secret}`);
    error.name = 'SqlBoom';
    throw error;
  };
  try {
    const response = await registerClient(opened, [REDIRECT]);
    assert.equal(response.response.status, 500);
    assert.equal(response.json.error, 'server_error');
    assert.equal(response.text.includes(secret), false);
    const journal = `${watch.lines.join('\n')}\n${opened.state.logs.map((entry) => entry.message).join('\n')}`;
    assert.equal(journal.includes(secret), false);
    assert.equal(journal.includes('boom'), false);
    assert.equal(opened.state.logs.some((entry) => entry.message === 'oauth: request failed (SqlBoom)'), true);
  } finally {
    watch.restore();
  }
});

test('the identity header is ignored on POST /mcp', async (t) => {
  const address = email();
  const token = randomBytes(32).toString('base64url');
  const opened = await open(t, {
    settings: settings({ email_allowlist: address }),
    secrets: { [BEARER_SECRET]: token },
  });
  const req = {
    headers: { authorization: `Bearer ${token}` },
    get(name) {
      if (String(name).toLowerCase() === 'x-ambactos-email') throw new Error('identity header was read');
      return this.headers[String(name).toLowerCase()];
    },
  };
  assert.equal((await authenticate(req, opened.ctx)).ok, true);

  const refused = await http(opened, '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-ambactos-email': address,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(refused.response.status, 401);
  assert.equal(count(opened, 'oauth_tokens'), 0);
  assert.equal(refused.text.includes(address), false);
});

/**
 * @param {import('node:test').TestContext} t
 * @param {{ settings?: object, secrets?: Record<string, string> }} [options]
 */
async function open(t, options = {}) {
  const opened = await createFakeCtx({
    id: PLUGIN,
    secrets: options.secrets ?? {},
    settings: options.settings === undefined ? settings() : options.settings,
  });
  t.after(() => opened.close());
  apply(opened.ctx);
  return opened;
}

/**
 * @param {Record<string, string>} [over]
 */
function settings(over = {}) {
  return {
    public_url: PUBLIC,
    issuer: PUBLIC,
    resource: RESOURCE,
    ...over,
  };
}

/**
 * @param {{ baseUrl: string }} opened
 * @param {string} path
 * @param {RequestInit} [options]
 */
async function http(opened, path, options = {}) {
  const response = await fetch(`${opened.baseUrl}/api/plugins/${PLUGIN}${path}`, {
    redirect: 'manual',
    ...options,
  });
  const text = await response.text();
  let json = null;
  if ((response.headers.get('content-type') || '').includes('json') && text) json = JSON.parse(text);
  return { response, text, json };
}

/**
 * @param {{ baseUrl: string }} opened
 * @param {string[]} uris
 * @param {Record<string, unknown>} [extra]
 */
function registerClient(opened, uris, extra = {}) {
  const body = { client_name: 'client MCP', redirect_uris: uris, ...extra };
  return http(opened, '/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * @param {string} clientId
 * @param {string} challenge
 * @param {Record<string, string>} [over]
 */
function authQuery(clientId, challenge, over = {}) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    state: 's1',
    ...over,
  });
  return `/oauth/authorize?${params}`;
}

/**
 * @param {{ baseUrl: string }} opened
 * @param {string} clientId
 * @param {string} challenge
 * @param {string | undefined} address `undefined` omits the header, `''` sends it empty
 * @param {Record<string, string>} [over]
 */
function authorize(opened, clientId, challenge, address, over = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (address !== undefined) headers['x-ambactos-email'] = address;
  return http(opened, authQuery(clientId, challenge, over), { headers });
}

/**
 * @param {{ baseUrl: string }} opened
 * @param {string} html
 * @param {string} address
 * @param {string} [decision]
 */
function approve(opened, html, address, decision = 'approve') {
  return http(opened, '/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-ambactos-email': address,
    },
    body: form({
      request_id: hidden(html, 'request_id'),
      csrf: hidden(html, 'csrf'),
      decision,
    }),
  });
}

/**
 * @param {{ baseUrl: string, ctx: { sql: { prepare: Function } } }} opened
 * @param {string} address
 */
async function login(opened, address) {
  const registered = await registerClient(opened, [REDIRECT]);
  assert.equal(registered.response.status, 201);
  const { verifier, challenge } = pair();
  const page = await authorize(opened, registered.json.client_id, challenge, address);
  assert.equal(page.response.status, 200);
  const approved = await approve(opened, page.text, address);
  assert.equal(approved.response.status, 302);
  const location = new URL(approved.response.headers.get('location'));
  assert.equal(location.searchParams.get('state'), 's1');
  const code = location.searchParams.get('code');
  assert.equal(typeof code, 'string');
  return { clientId: registered.json.client_id, verifier, code, page: page.text };
}

/**
 * @param {{ baseUrl: string }} opened
 * @param {{ clientId: string, verifier: string, code: string }} session
 * @param {Record<string, string>} [over]
 */
function exchange(opened, session, over = {}) {
  return token(opened, {
    grant_type: 'authorization_code',
    code: session.code,
    client_id: session.clientId,
    redirect_uri: REDIRECT,
    code_verifier: session.verifier,
    resource: RESOURCE,
    ...over,
  });
}

/**
 * @param {{ baseUrl: string }} opened
 * @param {Record<string, string>} fields
 */
function token(opened, fields) {
  return http(opened, '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form(fields),
  });
}

/**
 * @param {{ baseUrl: string }} opened
 * @param {string | null} authorization
 */
function mcp(opened, authorization) {
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (authorization) headers.authorization = authorization;
  return http(opened, '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

/**
 * @param {Record<string, string>} fields
 */
function form(fields) {
  return new URLSearchParams(fields).toString();
}

/**
 * @param {string} html
 * @param {string} name
 */
function hidden(html, name) {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  assert.ok(match, name);
  return match[1];
}

function pair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * @param {string} value
 */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function email() {
  return `ada.${randomBytes(4).toString('hex')}@example.com`;
}

/**
 * @param {{ ctx: { sql: { prepare: Function } } }} opened
 * @param {string} table
 */
function count(opened, table) {
  return Number(opened.ctx.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

/**
 * @param {{ ctx: { sql: { prepare: Function } } }} opened
 */
function dump(opened) {
  /** @type {string[]} */
  const cells = [];
  for (const table of ['oauth_clients', 'oauth_requests', 'oauth_codes', 'oauth_tokens']) {
    for (const row of opened.ctx.sql.prepare(`SELECT * FROM ${table}`).all()) {
      for (const value of Object.values(row)) {
        if (value != null) cells.push(String(value));
      }
    }
  }
  return cells.join('\n');
}

function spyConsole() {
  /** @type {string[]} */
  const lines = [];
  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  /** @type {Record<string, (...args: unknown[]) => void>} */
  const previous = {};
  let done = false;
  for (const level of levels) {
    previous[level] = console[level];
    console[level] = (...args) => {
      lines.push(args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
    };
  }
  return {
    lines,
    restore() {
      if (done) return;
      done = true;
      for (const level of levels) console[level] = previous[level];
    },
  };
}
