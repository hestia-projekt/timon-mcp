import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  CONSENT_TTL_MS,
  MAX_DCR_CLIENTS,
  REFRESH_TTL_MS,
} from '../constants.js';
import { digestEqual, randomToken, s256Challenge, sha256Buffer, sha256Hex } from './crypto.js';

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * @param {object} ctx
 */
function ready(ctx) {
  return Boolean(ctx && ctx.sql && typeof ctx.sql.prepare === 'function' && typeof ctx.sql.transaction === 'function');
}

/**
 * @param {object} ctx
 * @param {number} now
 */
function purge(ctx, now) {
  ctx.sql.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now);
  ctx.sql.prepare('DELETE FROM oauth_requests WHERE expires_at <= ?').run(now);
  ctx.sql.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(now);
}

/**
 * @param {object} ctx
 * @param {{ name: string, redirectUris: string[] }} client
 * @param {number} [now]
 * @returns {{ ok: true, clientId: string } | { ok: false, reason: 'limit' | 'storage' }}
 */
export function registerClient(ctx, client, now = Date.now()) {
  if (!ready(ctx)) return { ok: false, reason: 'storage' };
  const clientId = randomToken(16);
  const stored = ctx.sql.transaction(() => {
    purge(ctx, now);
    const count = ctx.sql.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get();
    if (Number(count && count.n) >= MAX_DCR_CLIENTS) return false;
    ctx.sql.prepare(
      'INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
    ).run(clientId, client.name, JSON.stringify(client.redirectUris), now);
    return true;
  });
  if (!stored) return { ok: false, reason: 'limit' };
  return { ok: true, clientId };
}

/**
 * @param {object} ctx
 * @param {string} clientId
 * @returns {{ clientId: string, name: string, redirectUris: string[] } | null}
 */
export function findClient(ctx, clientId) {
  if (!ready(ctx) || typeof clientId !== 'string' || !clientId || clientId.length > 128) return null;
  const row = ctx.sql.prepare(
    'SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?',
  ).get(clientId);
  if (!row || typeof row.redirect_uris !== 'string') return null;
  let uris;
  try {
    uris = JSON.parse(row.redirect_uris);
  } catch {
    return null;
  }
  if (!Array.isArray(uris) || !uris.every((item) => typeof item === 'string')) return null;
  return { clientId: String(row.client_id), name: String(row.client_name), redirectUris: uris };
}

/**
 * @param {object} ctx
 * @param {{ clientId: string, redirectUri: string, codeChallenge: string, resource: string, subject: string, state: string | null }} fields
 * @param {number} [now]
 * @returns {{ requestId: string, csrf: string } | null}
 */
export function createConsent(ctx, fields, now = Date.now()) {
  if (!ready(ctx)) return null;
  const requestId = randomToken();
  const csrf = randomToken();
  ctx.sql.transaction(() => {
    purge(ctx, now);
    ctx.sql.prepare(
      `INSERT INTO oauth_requests
        (request_id, csrf_hash, client_id, redirect_uri, code_challenge, resource, subject, state, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      requestId,
      sha256Hex(csrf),
      fields.clientId,
      fields.redirectUri,
      fields.codeChallenge,
      fields.resource,
      fields.subject,
      fields.state,
      now + CONSENT_TTL_MS,
    );
  });
  return { requestId, csrf };
}

/**
 * Checks the CSRF digest and the subject, then deletes the consent.
 * A failed check still burns the row so the token cannot be replayed.
 * @param {object} ctx
 * @param {string} requestId
 * @param {string} csrf
 * @param {string} subject
 * @param {number} now
 * @returns {object | null}
 */
function consumeConsent(ctx, requestId, csrf, subject, now) {
  if (typeof requestId !== 'string' || !requestId) return null;
  const row = ctx.sql.prepare('SELECT * FROM oauth_requests WHERE request_id = ?').get(requestId);
  if (!row) return null;
  // A missing or wrong CSRF still burns the row: the form cannot be replayed.
  ctx.sql.prepare('DELETE FROM oauth_requests WHERE request_id = ?').run(requestId);
  if (typeof csrf !== 'string' || !csrf) return null;
  if (Number(row.expires_at) <= now) return null;
  if (row.subject !== subject) return null;
  const expected = Buffer.from(String(row.csrf_hash), 'hex');
  const actual = sha256Buffer(csrf);
  if (!digestEqual(expected, actual)) return null;
  return row;
}

/**
 * @param {object} ctx
 * @param {string} requestId
 * @param {string} csrf
 * @param {string} subject
 * @param {string} resource
 * @param {number} [now]
 * @returns {{ code: string, redirectUri: string, state: string | null } | null}
 */
export function approveConsent(ctx, requestId, csrf, subject, resource, now = Date.now()) {
  if (!ready(ctx)) return null;
  return ctx.sql.transaction(() => {
    purge(ctx, now);
    const row = consumeConsent(ctx, requestId, csrf, subject, now);
    if (!row || row.resource !== resource) return null;
    const code = randomToken();
    ctx.sql.prepare(
      `INSERT INTO oauth_codes
        (code_hash, client_id, redirect_uri, code_challenge, resource, subject, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sha256Hex(code),
      row.client_id,
      row.redirect_uri,
      row.code_challenge,
      row.resource,
      row.subject,
      now + CODE_TTL_MS,
    );
    return { code, redirectUri: String(row.redirect_uri), state: row.state == null ? null : String(row.state) };
  });
}

/**
 * @param {object} ctx
 * @param {string} requestId
 * @param {string} csrf
 * @param {string} subject
 * @param {string} resource
 * @param {number} [now]
 * @returns {{ redirectUri: string, state: string | null } | null}
 */
export function denyConsent(ctx, requestId, csrf, subject, resource, now = Date.now()) {
  if (!ready(ctx)) return null;
  return ctx.sql.transaction(() => {
    purge(ctx, now);
    const row = consumeConsent(ctx, requestId, csrf, subject, now);
    if (!row || row.resource !== resource) return null;
    return { redirectUri: String(row.redirect_uri), state: row.state == null ? null : String(row.state) };
  });
}

/**
 * Exchanges a code. The code row is deleted on first presentation, including
 * when the verifier or the binding does not match.
 * @param {object} ctx
 * @param {{ code: string, clientId: string, redirectUri: string, verifier: string, resource: string }} input
 * @param {number} [now]
 */
export function exchangeCode(ctx, input, now = Date.now()) {
  if (!ready(ctx)) return { ok: false };
  const codeHash = sha256Hex(input.code);
  return ctx.sql.transaction(() => {
    purge(ctx, now);
    const row = ctx.sql.prepare(
      'SELECT client_id, redirect_uri, code_challenge, resource, subject, expires_at FROM oauth_codes WHERE code_hash = ?',
    ).get(codeHash);
    if (!row) return { ok: false };
    ctx.sql.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(codeHash);
    if (Number(row.expires_at) <= now) return { ok: false };
    if (row.client_id !== input.clientId) return { ok: false };
    if (row.redirect_uri !== input.redirectUri) return { ok: false };
    if (row.resource !== input.resource) return { ok: false };
    if (!verifierMatches(input.verifier, String(row.code_challenge))) return { ok: false };
    return insertPair(ctx, row, now);
  });
}

/**
 * Rotates a refresh token. Presenting a token that was already rotated
 * revokes the whole family.
 * @param {object} ctx
 * @param {{ refresh: string, clientId: string, resource: string }} input
 * @param {number} [now]
 */
export function rotateRefresh(ctx, input, now = Date.now()) {
  if (!ready(ctx)) return { ok: false };
  const hash = sha256Hex(input.refresh);
  return ctx.sql.transaction(() => {
    purge(ctx, now);
    const row = ctx.sql.prepare(
      `SELECT client_id, resource, subject, family_id, expires_at, revoked_at
       FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`,
    ).get(hash);
    if (!row) return { ok: false };
    if (row.revoked_at != null) {
      ctx.sql.prepare(
        'UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
      ).run(now, row.family_id);
      return { ok: false };
    }
    if (Number(row.expires_at) <= now) return { ok: false };
    if (row.client_id !== input.clientId || row.resource !== input.resource) return { ok: false };
    ctx.sql.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?').run(now, hash);
    return insertPair(ctx, row, now, String(row.family_id));
  });
}

/**
 * @param {object} ctx
 * @param {string} token
 * @param {string | null} resource canonical MCP resource currently configured
 * @param {number} [now]
 */
export function accessIsValid(ctx, token, resource, now = Date.now()) {
  if (!ready(ctx) || !resource || !token) return false;
  purge(ctx, now);
  const row = ctx.sql.prepare(
    `SELECT resource, expires_at, revoked_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`,
  ).get(sha256Hex(token));
  if (!row || row.revoked_at != null) return false;
  if (Number(row.expires_at) <= now) return false;
  return row.resource === resource;
}

/**
 * @param {string} verifier
 * @param {string} challenge
 */
function verifierMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !VERIFIER.test(verifier)) return false;
  return digestEqual(sha256Buffer(s256Challenge(verifier)), sha256Buffer(challenge));
}

/**
 * @param {object} ctx
 * @param {{ client_id: string, resource: string, subject: string }} row
 * @param {number} now
 * @param {string} [familyId] stable across refresh rotation; a new family on the code exchange
 */
function insertPair(ctx, row, now, familyId) {
  const access = randomToken();
  const refresh = randomToken();
  const family = familyId || randomToken(16);
  const insert = ctx.sql.prepare(
    `INSERT INTO oauth_tokens
      (token_hash, kind, client_id, resource, subject, family_id, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  insert.run(sha256Hex(access), 'access', row.client_id, row.resource, row.subject, family, now + ACCESS_TTL_MS, now);
  insert.run(sha256Hex(refresh), 'refresh', row.client_id, row.resource, row.subject, family, now + REFRESH_TTL_MS, now);
  return {
    ok: true,
    access,
    refresh,
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
  };
}
