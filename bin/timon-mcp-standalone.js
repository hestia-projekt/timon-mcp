/**
 * Process entry for the standalone host. Importing this file does not listen.
 * The checkout keeps `bin/`, `host/` and `lib/` together: the imports are
 * resolved from this file, not from the working directory.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startStandalone } from '../host/standalone.js';

if (isDirectRun()) {
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
  }, () => {
    process.stderr.write('timon-mcp standalone failed to start\n');
    process.exit(1);
  });
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
