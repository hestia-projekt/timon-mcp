/**
 * Errors the plugin tools already understand (`error.name` and `error.code`).
 * They are not imported from the daemon. A route outside the closed list is
 * `DaemonRouteError` and is thrown before any network call.
 */

export class PluginMissionError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   */
  constructor(code, message = code) {
    super(message);
    this.name = 'PluginMissionError';
    this.code = code;
  }
}

export class PluginTaskError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [reason]
   */
  constructor(code, message, reason) {
    super(message);
    this.name = 'PluginTaskError';
    this.code = code;
    this.reason = reason;
  }
}

export class PluginPolicyError extends Error {
  /**
   * @param {string} pluginId
   * @param {string} rule
   * @param {string} message
   */
  constructor(pluginId, rule, message) {
    super(message);
    this.name = 'PluginPolicyError';
    this.pluginId = pluginId;
    this.rule = rule;
  }
}

/** Thrown when a method and path are outside the closed daemon list. */
export class DaemonRouteError extends Error {
  /**
   * @param {string} method
   * @param {string} path
   */
  constructor(method, path) {
    super('daemon route is not allowed');
    this.name = 'DaemonRouteError';
    this.code = 'route_denied';
    this.method = method;
    this.route = typeof path === 'string' ? path.split('?')[0] : '';
  }
}

/** The daemon could not be called. The message is fixed and carries no secret. */
export class DaemonCallError extends Error {
  constructor() {
    super('daemon is unreachable');
    this.name = 'DaemonCallError';
    this.code = 'unreachable';
  }
}

/**
 * The daemon answered with a body past the cap for that route.
 * The message is fixed and carries no secret. The bytes are not parsed.
 */
export class DaemonBodyError extends Error {
  constructor() {
    super('daemon response is too large');
    this.name = 'DaemonBodyError';
    this.code = 'too_large';
  }
}
