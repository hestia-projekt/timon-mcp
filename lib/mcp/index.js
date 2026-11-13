import { assertPluginMount } from '../http.js';

/**
 * Streamable HTTP MCP routes (step 3) mount here. Step 1 checks the mount and
 * registers nothing.
 * @param {{ get: Function, use: Function }} router
 * @param {object} ctx
 */
export function mountMcp(router, ctx) {
  assertPluginMount(router, ctx, 'mcp');
}
