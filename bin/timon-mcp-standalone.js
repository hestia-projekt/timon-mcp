/**
 * Process entry for the standalone host. Importing this file does not listen.
 * The checkout keeps `bin/`, `host/` and `lib/` together: the imports are
 * resolved from this file, not from the working directory.
 *
 * The version check runs before `host/standalone.js` is loaded. A static
 * import would pull in `node:sqlite` first and fail with Node's own error
 * on every release before 22.13.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { nodeSupportsSqlite, standaloneNodeMessage } from '../host/node-version.js';

if (isDirectRun()) {
  if (!nodeSupportsSqlite(process.versions.node)) {
    process.stderr.write(`${standaloneNodeMessage(process.versions.node)}\n`);
    process.exit(1);
  }
  const { startStandalone } = await import('../host/standalone.js');
  startStandalone().then((host) => {
    process.stdout.write(`timon-mcp standalone listening on 127.0.0.1:${host.port}\n`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      host.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }, (err) => {
    process.stderr.write(`timon-mcp standalone failed to start: ${publicCause(err)}\n`);
    process.exit(1);
  });
}

/**
 * A short fixed cause. Paths, stacks and anything that could carry a secret stay out.
 * @param {unknown} err
 */
function publicCause(err) {
  const message = err instanceof Error ? err.message : '';
  if (message.length > 200 || message.length === 0) return 'startup failed';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ,.'():_-]*$/.test(message)) return 'startup failed';
  if (/[0-9a-f]{16,}/i.test(message)) return 'startup failed';
  return message;
}

/**
 * @returns {boolean}
 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
