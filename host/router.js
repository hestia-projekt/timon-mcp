/**
 * Express-shaped router for the standalone host. The daemon mounts a real
 * Express router; this one speaks the methods the plugin calls (`get`, `post`,
 * `all`, `use`, `status`, `json`, `set`). No npm dependency.
 */

/**
 * @param {string | null} path
 * @param {'exact' | 'prefix'} mode `use(path)` is a prefix mount, like Express.
 */
function compile(path, mode) {
  if (path == null) return null;
  const normalized = mode === 'prefix' ? stripTrailingSlash(path) : path;
  if (mode === 'prefix' && (normalized === '' || normalized === '/')) return null;
  const keys = [];
  const body = normalized.split('/').map((segment) => {
    if (segment.startsWith(':') && segment.length > 1) {
      keys.push(segment.slice(1));
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const tail = mode === 'prefix' ? '(?=/|$)' : '/?$';
  return { keys, re: new RegExp(`^${body}${tail}`) };
}

/**
 * @param {string} path
 */
function stripTrailingSlash(path) {
  if (path.length > 1 && path.endsWith('/')) return path.replace(/\/+$/, '');
  return path;
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
 * @returns {{ params: Record<string, string>, matched: string } | null}
 */
function matchPath(layer, req) {
  if (!layer.re) return { params: {}, matched: '' };
  const found = layer.re.exec(req.path || '/');
  if (!found) return null;
  /** @type {Record<string, string>} */
  const params = {};
  layer.keys.forEach((key, index) => {
    params[key] = decodeURIComponent(found[index + 1]);
  });
  return { params, matched: found[0] };
}

/**
 * @param {string | undefined} value
 * @param {string} matched
 * @param {boolean} keepSearch
 */
function remainder(value, matched, keepSearch) {
  const raw = typeof value === 'string' && value ? value : '/';
  const queryAt = raw.indexOf('?');
  const pathname = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const search = queryAt === -1 ? '' : raw.slice(queryAt);
  let rest = pathname.startsWith(matched) ? pathname.slice(matched.length) : pathname;
  if (!rest.startsWith('/')) rest = `/${rest}`;
  return keepSearch ? `${rest}${search}` : rest;
}

export function createRouter() {
  /** @type {Array<{ method: string, path: string | null, keys: string[], re: RegExp | null, prefix: boolean, handle: Function, error: boolean }>} */
  const layers = [];

  /**
   * @param {string} method
   * @param {string} path
   * @param {Function[]} handlers
   */
  function add(method, path, handlers) {
    const compiled = compile(path, 'exact');
    for (const handle of handlers) {
      if (typeof handle !== 'function') throw new TypeError('router handler must be a function');
      layers.push({
        method,
        path,
        keys: compiled ? compiled.keys : [],
        re: compiled ? compiled.re : null,
        prefix: false,
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
      const compiled = compile(mount, 'prefix');
      for (const handle of list) {
        if (typeof handle !== 'function') throw new TypeError('router handler must be a function');
        layers.push({
          method: 'ALL',
          path: mount,
          keys: compiled ? compiled.keys : [],
          re: compiled ? compiled.re : null,
          prefix: true,
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
     * @returns {Promise<unknown>}
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
          const hit = matchPath(layer, req);
          if (!hit) {
            step(err);
            return;
          }
          const previous = {
            params: req.params,
            path: req.path,
            url: req.url,
            baseUrl: req.baseUrl,
          };
          req.params = hit.params;
          if (layer.prefix && hit.matched) {
            req.path = remainder(req.path, hit.matched, false);
            req.url = remainder(req.url, hit.matched, true);
            req.baseUrl = `${typeof req.baseUrl === 'string' ? req.baseUrl : ''}${hit.matched}`;
          }
          let called = false;
          const restore = () => {
            req.params = previous.params;
            req.path = previous.path;
            req.url = previous.url;
            req.baseUrl = previous.baseUrl;
          };
          const next = (nextErr) => {
            if (called) return;
            called = true;
            restore();
            step(nextErr);
          };
          const finish = () => {
            if (called) return;
            called = true;
            restore();
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
 * @param {import('node:http').ServerResponse} raw
 * @param {(value: unknown) => unknown} [scrub]
 */
export function createResponse(raw, scrub) {
  const clean = typeof scrub === 'function' ? scrub : (value) => value;
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
      send(response, raw, JSON.stringify(clean(body) ?? null), 'application/json; charset=utf-8');
      return response;
    },
    end(body) {
      const text = body == null ? '' : String(body);
      send(response, raw, typeof body === 'string' ? String(clean(text)) : text, null);
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
