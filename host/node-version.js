/**
 * `node:sqlite` is a stable built-in from Node.js 22.13.0.
 * Node 22.0 through 22.4 have no such module. Node 22.5 through 22.12
 * expose it only behind `--experimental-sqlite`. Node 23 kept that flag
 * through 23.3 and dropped it in 23.4.0. Node 24 and later ship it
 * unflagged. The standalone host checks this before loading that module,
 * and exits if the process is older.
 */
export const MIN_STANDALONE_NODE = Object.freeze([22, 13, 0]);

/**
 * Lowest unflagged `node:sqlite` on each major line. A major absent from
 * this map is refused below 24 and accepted from 24 up.
 */
const SQLITE_MIN_BY_MAJOR = Object.freeze({
  22: Object.freeze([22, 13, 0]),
  23: Object.freeze([23, 4, 0]),
});

/**
 * @param {unknown} version `process.versions.node`, with or without a leading `v`.
 * @returns {[number, number, number]}
 */
export function parseNodeVersion(version) {
  const text = String(version ?? '').replace(/^v/, '');
  const [major = '0', minor = '0', patch = '0'] = text.split('.');
  return [major, minor, patch].map((part) => {
    const match = /^(\d+)/.exec(part);
    return match ? Number(match[1]) : 0;
  });
}

/**
 * @param {unknown} version
 * @returns {boolean}
 */
export function nodeSupportsSqlite(version) {
  const [major, minor, patch] = parseNodeVersion(version);
  if (major >= 24) return true;
  const floor = SQLITE_MIN_BY_MAJOR[major];
  if (!floor) return false;
  const [, needMinor, needPatch] = floor;
  if (minor !== needMinor) return minor > needMinor;
  return patch >= needPatch;
}

/**
 * Shown on stderr when the standalone process is too old. No path, no stack.
 * @param {unknown} version
 * @returns {string}
 */
export function standaloneNodeMessage(version) {
  const [major, minor] = MIN_STANDALONE_NODE;
  const raw = String(version ?? '');
  const shown = raw.startsWith('v') ? raw : `v${raw}`;
  return `timon-mcp standalone needs Node.js ${major}.${minor} or newer (node:sqlite). This process is ${shown}.`;
}
