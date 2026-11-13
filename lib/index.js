import { mountAuth } from './auth/index.js';
import { PLUGIN_ID } from './constants.js';
import { assertPluginMount, httpFailure, installTerminalHandlers } from './http.js';
import { mountMcp } from './mcp/index.js';
import { createJobRunner } from './mcp/job-runner.js';

export { PLUGIN_ID };

/**
 * @param {object} ctx Plugin context. `ctx.router()` is mounted by the daemon
 *   under `/api/plugins/<id>/`.
 */
export function apply(ctx) {
  if (!ctx || typeof ctx !== 'object' || typeof ctx.router !== 'function') {
    throw httpFailure('invalid_context', 'apply requires a plugin context with router()');
  }
  const router = ctx.router();
  assertPluginMount(router, ctx, 'apply');

  // Armed here, outside any request, so the pump is not captured by the
  // anonymous caller's AsyncLocalStorage store. See lib/mcp/job-runner.js.
  const jobs = createJobRunner();
  jobs.start();
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => jobs.stop());
  }

  router.all('/health', function health(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD');
      res.status(405).json({
        error: 'method_not_allowed',
        message: 'Use GET /health',
      });
      return;
    }
    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }
    res.status(200).json({ ok: true, id: PLUGIN_ID });
  });

  mountAuth(router, ctx);
  mountMcp(router, ctx, jobs);
  installTerminalHandlers(router);
}
