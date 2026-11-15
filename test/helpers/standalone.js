/**
 * Starts the standalone host against the in-process fake daemon.
 * The token file is always under a temporary directory.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BEARER_SECRET } from '../../lib/constants.js';
import { startStandalone } from '../../host/standalone.js';
import { startFakeDaemon } from './fake-daemon.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 */
export async function openStack(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'timon-mcp-host-'));
  const token = randomBytes(32).toString('hex');
  const bearer = randomBytes(32).toString('hex');
  const tokenFile = join(dir, 'daemon-token');
  const dbFile = join(dir, 'state.db');
  let settingsFile = '';
  if (options.settings) {
    settingsFile = join(dir, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify(options.settings));
  }
  if (options.writeToken !== false) writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });

  let daemon = null;
  if (options.daemon !== false) {
    daemon = await startFakeDaemon({
      token,
      echoToken: options.echoToken === true,
      foreignId: options.foreignId,
    });
  }
  const daemonUrl = daemon ? daemon.origin : (options.daemonUrl || 'http://127.0.0.1:9');
  const logs = [];
  const journal = [];
  let host;
  try {
    host = await startStandalone({
      port: 0,
      daemonUrl,
      tokenFile: options.tokenFile ?? tokenFile,
      dbFile,
      settingsFile,
      env: { [BEARER_SECRET]: bearer, ...(options.env ?? {}) },
      journal,
      logs,
      now: options.now,
    });
  } catch (err) {
    if (daemon) await daemon.close();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  t.after(async () => {
    await host.close();
    if (daemon) await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, daemon, token, bearer, dir, logs, journal, tokenFile, dbFile, daemonUrl };
}
