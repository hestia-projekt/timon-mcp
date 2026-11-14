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

/**
 * Vault name of the static bearer used by local CLIs.
 * Shared with `timon.secrets` in package.json. Never pass it as a literal
 * to `ctx.secrets.get`.
 */
export const BEARER_SECRET = 'TIMON_MCP_BEARER_TOKEN';

export const SETTING_PUBLIC_URL = 'public_url';
export const SETTING_ISSUER = 'issuer';
export const SETTING_RESOURCE = 'resource';
export const SETTING_IDENTITY_HEADER = 'identity_header';
export const SETTING_EXPECTED_RIGHT = 'expected_right';
export const SETTING_EMAIL_ALLOWLIST = 'email_allowlist';

/**
 * Used when `identity_header` has never been saved.
 * Clearing the saved value disables the header on purpose.
 */
export const DEFAULT_IDENTITY_HEADER = 'x-ambactos-email'; // timon-check: nom de l'en-tête de la passerelle, valeur par défaut du réglage

/** Documentary only: the gateway enforces this right before it proxies. */
export const DEFAULT_EXPECTED_RIGHT = 'timon';

/** Authorization codes are single-use and live at most 60 seconds. */
export const CODE_TTL_MS = 60_000;

/** Access tokens are opaque and short-lived. Refresh tokens rotate. */
export const ACCESS_TTL_MS = 15 * 60 * 1000;

export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Consent form lifetime. The CSRF secret is stored only as a SHA-256 digest. */
export const CONSENT_TTL_MS = 5 * 60 * 1000;

/** Public dynamic clients. Further registrations are refused past this cap. */
export const MAX_DCR_CLIENTS = 128;

export const OAUTH_SCOPE = 'mcp';
