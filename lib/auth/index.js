import { assertPluginMount } from '../http.js';

/**
 * Authentication hook for `POST /mcp`.
 *
 * TODO(étape 3): replace this pass-through with OAuth 2.1 (protected-resource
 * metadata, authorization-server metadata, dynamic client registration, PKCE)
 * and the static bearer token for local CLIs. Step 2 leaves the entry point
 * unauthenticated on purpose: every well-formed request is accepted.
 *
 * @param {object} req Incoming request. The hook is wired so step 3 can reject
 *   it without moving the call site.
 * @returns {{ ok: true } | { ok: false, status: number, message: string }}
 */
export function authenticate(req) {
  if (!req || typeof req !== 'object') {
    return { ok: false, status: 400, message: 'missing request' };
  }
  return { ok: true };
}

/**
 * Authentication routes mount here in step 3. Step 2 checks the mount and
 * registers nothing: `authenticate` is called from the MCP route.
 * @param {{ get: Function, use: Function }} router
 * @param {object} ctx
 */
export function mountAuth(router, ctx) {
  assertPluginMount(router, ctx, 'auth');
}
