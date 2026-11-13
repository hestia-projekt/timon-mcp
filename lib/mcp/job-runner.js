/**
 * Runs tool work outside the HTTP request's AsyncLocalStorage store.
 *
 * The daemon keeps the caller of a route in an AsyncLocalStorage store that
 * follows promises and `setImmediate` (`plugins/als.js`). A public route has
 * an anonymous viewer (`null`). In that store, `ctx.missions.send` throws
 * `forbidden`, and `ctx.missions.list` / `get` read every mission on the
 * install, not only this plugin's. That is unacceptable.
 *
 * The store does not follow a timer that was armed earlier, outside any
 * request. `apply()` starts this pump. The route only enqueues the call and
 * awaits its promise. The timer invokes the call with an empty store, which
 * the daemon treats as the background identity `plugin:timon-mcp`. The plugin
 * then sees only the missions it started and the tasks it created.
 *
 * Do not call `ctx.missions` or `ctx.kanban` from a route handler. Do not
 * schedule the work with `setImmediate`, `queueMicrotask`, `process.nextTick`
 * or a promise created in the handler: those stay inside the request store.
 */

const PUMP_MS = 10;

/**
 * @returns {{
 *   start: () => void,
 *   stop: () => void,
 *   submit: (run: () => unknown) => Promise<unknown>,
 * }}
 */
export function createJobRunner() {
  /** @type {Array<{ run: () => unknown, resolve: (value: unknown) => void, reject: (err: unknown) => void }>} */
  const queue = [];
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let stopped = false;

  function pump() {
    const batch = queue.splice(0, queue.length);
    for (const job of batch) {
      try {
        // Called on the interval armed in `apply()`, not on the request.
        const result = job.run();
        Promise.resolve(result).then(job.resolve, job.reject);
      } catch (err) {
        job.reject(err);
      }
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(pump, PUMP_MS);
      if (typeof timer.unref === 'function') timer.unref();
    },
    /**
     * Drops the timer. Called from `ctx.effect` when the plugin unloads.
     * Jobs still in the queue fail; a job the pump already started may finish.
     */
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const pending = queue.splice(0, queue.length);
      const unloaded = Object.assign(new Error('plugin unloaded'), { code: 'unloaded' });
      for (const job of pending) job.reject(unloaded);
    },
    /**
     * @param {() => unknown} run Invoked by the pump, never by the caller.
     * @returns {Promise<unknown>}
     */
    submit(run) {
      if (typeof run !== 'function') {
        return Promise.reject(new TypeError('job must be a function'));
      }
      if (stopped) {
        return Promise.reject(Object.assign(new Error('plugin unloaded'), { code: 'unloaded' }));
      }
      return new Promise((resolve, reject) => {
        queue.push({ run, resolve, reject });
      });
    },
  };
}
