/**
 * Express-shaped router for contract tests. The daemon mounts a real Express
 * router; this one speaks the same methods the plugin uses (`get`, `post`,
 * `put`, `patch`, `delete`, `all`, `use`, `status`, `json`, `set`).
 */

/**
 * @param {string | null} path
 */
function compile(path) {
  if (path == null) return null;
  const keys = [];
  const body = path.split('/').map((segment) => {
    if (segment.startsWith(':') && segment.length > 1) {
      keys.push(segment.slice(1));
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { keys, re: new RegExp(`^${body}/?$`) };
}

/**
 * @param {string | undefined} method
 * @param {string} actual
 */
function methodMatches(method, actual) {
  if (!method || method === 'ALL') return true;
  if (method === actual) return true;
  return method === 'GET' && actual === 'HEAD';
}

/**
 * @param {{ path: string | null, keys: string[], re: RegExp | null }} layer
 * @param {{ path: string }} req
 * @returns {Record<string, string> | null}
 */
function matchPath(layer, req) {
  if (!layer.re) return {};
  const found = layer.re.exec(req.path);
  if (!found) return null;
  /** @type {Record<string, string>} */
  const params = {};
  layer.keys.forEach((key, index) => {
    params[key] = decodeURIComponent(found[index + 1]);
  });
  return params;
}

export function createRouter() {
  /** @type {Array<{ method: string, path: string | null, keys: string[], re: RegExp | null, handle: Function, error: boolean }>} */
  const layers = [];

  /**
   * @param {string} method
   * @param {string} path
   * @param {Function[]} handlers
   */
  function add(method, path, handlers) {
    const compiled = compile(path);
    for (const handle of handlers) {
      if (typeof handle !== 'function') {
        throw new TypeError('router handler must be a function');
      }
      layers.push({
        method,
        path,
        keys: compiled ? compiled.keys : [],
        re: compiled ? compiled.re : null,
        handle,
        error: false,
      });
    }
  }

  const router = {
    get(path, ...handlers) { add('GET', path, handlers); return router; },
    post(path, ...handlers) { add('POST', path, handlers); return router; },
    put(path, ...handlers) { add('PUT', path, handlers); return router; },
    patch(path, ...handlers) { add('PATCH', path, handlers); return router; },
    delete(path, ...handlers) { add('DELETE', path, handlers); return router; },
    all(path, ...handlers) { add('ALL', path, handlers); return router; },
    /**
     * @param {string | Function} path
     * @param {...Function} handlers
     */
    use(path, ...handlers) {
      const list = typeof path === 'function' ? [path, ...handlers] : handlers;
      const mount = typeof path === 'function' ? null : path;
      const compiled = compile(mount);
      for (const handle of list) {
        if (typeof handle !== 'function') {
          throw new TypeError('router handler must be a function');
        }
        layers.push({
          method: 'ALL',
          path: mount,
          keys: compiled ? compiled.keys : [],
          re: compiled ? compiled.re : null,
          handle,
          error: handle.length >= 4,
        });
      }
      return router;
    },
    /**
     * @param {object} req
     * @param {object} res
     * @param {unknown} [initialErr]
     * @returns {Promise<unknown>} the error still unhandled, or null
     */
    handle(req, res, initialErr) {
      return new Promise((resolve) => {
        let index = 0;
        /** @param {unknown} err */
        const step = (err) => {
          if (res.headersSent) {
            resolve(null);
            return;
          }
          if (index >= layers.length) {
            resolve(err ?? null);
            return;
          }
          const layer = layers[index++];
          if (err) {
            if (!layer.error) {
              step(err);
              return;
            }
          } else if (layer.error) {
            step(undefined);
            return;
          }
          if (!methodMatches(layer.method, req.method)) {
            step(err);
            return;
          }
          const params = matchPath(layer, req);
          if (!params) {
            step(err);
            return;
          }
          const previous = req.params;
          req.params = params;
          let called = false;
          const next = (nextErr) => {
            if (called) return;
            called = true;
            req.params = previous;
            step(nextErr);
          };
          const finish = () => {
            if (called) return;
            called = true;
            req.params = previous;
            if (res.headersSent) resolve(null);
            else step(err);
          };
          try {
            const out = layer.error
              ? layer.handle(err, req, res, next)
              : layer.handle(req, res, next);
            if (out && typeof out.then === 'function') {
              out.then(() => finish(), (failure) => {
                if (!called) next(failure);
              });
              return;
            }
            if (!called) finish();
          } catch (failure) {
            if (!called) next(failure);
          }
        };
        step(initialErr);
      });
    },
  };

  return router;
}

/**
 * Response façade with the Express methods the plugin calls.
 * @param {import('node:http').ServerResponse} raw
 */
export function createResponse(raw) {
  const response = {
    headersSent: false,
    statusCode: 200,
    locals: {},
    status(code) {
      response.statusCode = code;
      return response;
    },
    set(field, value) {
      if (field && typeof field === 'object') {
        for (const [name, item] of Object.entries(field)) raw.setHeader(name, item);
      } else {
        raw.setHeader(field, value);
      }
      return response;
    },
    setHeader(name, value) {
      raw.setHeader(name, value);
      return response;
    },
    getHeader(name) {
      return raw.getHeader(name);
    },
    json(body) {
      send(response, raw, JSON.stringify(body ?? null), 'application/json; charset=utf-8');
      return response;
    },
    end(body) {
      send(response, raw, body == null ? '' : String(body), null);
      return response;
    },
  };
  return response;
}

/**
 * @param {{ headersSent: boolean, statusCode: number }} response
 * @param {import('node:http').ServerResponse} raw
 * @param {string} body
 * @param {string | null} contentType
 */
function send(response, raw, body, contentType) {
  if (response.headersSent) return;
  response.headersSent = true;
  if (contentType && !raw.getHeader('Content-Type')) raw.setHeader('Content-Type', contentType);
  raw.statusCode = response.statusCode;
  raw.end(body);
}
