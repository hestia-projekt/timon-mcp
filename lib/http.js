/**
 * Predictable HTTP failures. A 4xx keeps its status and code. Anything else
 * is passed on so the daemon can answer its generic 500 without the message.
 */

const MISSION_STATUS = {
  invalid: 400,
  not_found: 404,
  forbidden: 403,
  not_running: 409,
  turn_in_progress: 409,
  backend_exhausted: 503,
  override_denied: 403,
  failed: 502,
};

const TASK_STATUS = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
};

/**
 * @param {string} code
 * @param {string} message
 */
export function httpFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {unknown} router
 * @param {unknown} ctx
 * @param {string} surface
 */
export function assertPluginMount(router, ctx, surface) {
  if (!ctx || typeof ctx !== 'object') {
    throw httpFailure('invalid_context', `${surface} requires the plugin context`);
  }
  if (!router || typeof router.use !== 'function' || typeof router.get !== 'function') {
    throw httpFailure('invalid_router', `${surface} requires a router with get() and use()`);
  }
}

/**
 * @param {unknown} err
 * @returns {{ status: number, error: string, message: string } | null}
 */
export function describeHttpError(err) {
  if (!err || typeof err !== 'object') return null;
  const error = /** @type {{ status?: unknown, code?: unknown, rule?: unknown, name?: unknown, message?: unknown }} */ (err);
  const status = Number(error.status);
  if (status >= 400 && status < 500 && typeof error.code === 'string' && error.code) {
    return { status, error: error.code, message: text(error.message, error.code) };
  }
  if (error.name === 'PluginMissionError' && typeof error.code === 'string' && MISSION_STATUS[error.code]) {
    return { status: MISSION_STATUS[error.code], error: error.code, message: text(error.message, error.code) };
  }
  if (error.name === 'PluginTaskError' && typeof error.code === 'string' && TASK_STATUS[error.code]) {
    return { status: TASK_STATUS[error.code], error: error.code, message: text(error.message, error.code) };
  }
  if (error.name === 'PluginPolicyError') {
    const code = typeof error.code === 'string' && error.code
      ? error.code
      : (typeof error.rule === 'string' ? error.rule : '');
    if (code) return { status: 403, error: code, message: text(error.message, code) };
  }
  if (error.name === 'PluginPermissionError') {
    return { status: 403, error: 'permission_missing', message: text(error.message, 'permission missing') };
  }
  return null;
}

/**
 * Last handlers on the plugin router: unknown routes and explained failures.
 * Register this after every route.
 * @param {{ use: Function }} router
 */
export function installTerminalHandlers(router) {
  router.use(function notFound(req, res) {
    const method = req && req.method ? req.method : 'GET';
    const path = req && (req.path || req.url) ? (req.path || req.url) : '/';
    res.status(404).json({
      error: 'not_found',
      message: `No route for ${method} ${path}`,
    });
  });

  router.use(function onPluginError(err, _req, res, next) {
    if (res.headersSent) {
      next(err);
      return;
    }
    const described = describeHttpError(err);
    if (!described) {
      next(err);
      return;
    }
    res.status(described.status).json({
      error: described.error,
      message: described.message,
    });
  });
}

/**
 * @param {unknown} value
 * @param {string} fallback
 */
function text(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}
