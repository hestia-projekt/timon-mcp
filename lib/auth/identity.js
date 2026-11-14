import { sha256Hex } from './crypto.js';
import { normalizeEmail, readIdentityOptions } from './config.js';
import { requestHeader } from './body.js';

/**
 * Resolves the gateway identity on `GET` and `POST /oauth/authorize` only.
 * Callers must not use it on `/mcp` or on any other route: the identity
 * header is not a credential there.
 *
 * `resolve` returns null when the header is missing or empty, or when the
 * address is not on the allowlist. A blank header name in settings falls
 * back to the built-in default. An empty allowlist refuses everyone.
 * @param {object | null | undefined} ctx
 */
export function createIdentityResolver(ctx) {
  const options = () => readIdentityOptions(ctx);
  return {
    /**
     * @param {object | null | undefined} req
     * @returns {{ subject: string, email: string } | null}
     */
    resolve(req) {
      const { headerName, allowlist } = options();
      if (!headerName) return null;
      const raw = requestHeader(req, headerName);
      if (typeof raw !== 'string' || !raw.trim()) return null;
      const email = normalizeEmail(raw);
      if (!email || !allowlist.includes(email)) return null;
      return { subject: sha256Hex(email), email };
    },
    /** Documentary right name, for pages and the README. Not read from a header. */
    rightName() {
      return options().right;
    },
  };
}
