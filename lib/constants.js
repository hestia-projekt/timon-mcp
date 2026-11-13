/** Manifest id. The daemon mounts routes under `/api/plugins/<id>/`. */
export const PLUGIN_ID = 'timon-mcp';

/**
 * Background identity the daemon applies when the request store is empty.
 * `apply()` escapes the anonymous public request so facades see this owner.
 */
export const BACKGROUND_IDENTITY = `plugin:${PLUGIN_ID}`;

/** Pilot with no project. Any other target is `<project>.main`. */
export const PILOT_AGENT = '_main';

/** Streamable HTTP revisions this server speaks. Latest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26']);

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Same ceiling as `ctx.missions.send`. */
export const MESSAGE_MAX_CHARS = 20_000;

/**
 * One public POST may wait, but the daemon allows 60 requests a minute on the
 * anonymous path. 25s leaves room for a retry; 50s is the hard cap.
 */
export const WAIT_DEFAULT_S = 25;

export const WAIT_MAX_S = 50;

/** Shown as a tool error. The client must not retry in a loop. */
export const APPROVAL_MESSAGE = "en attente d'approbation de l'opérateur";

/** Project slug the operator already uses for `<project>.main`. */
export const PROJECT_PATTERN = '^[a-z0-9][a-z0-9-]{0,39}$';
