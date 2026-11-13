import { assertPluginMount } from '../http.js';

/**
 * Authentication routes (step 2) mount here. Step 1 checks the mount and
 * registers nothing.
 * @param {{ get: Function, use: Function }} router
 * @param {object} ctx
 */
export function mountAuth(router, ctx) {
  assertPluginMount(router, ctx, 'auth');
}
