import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * @param {number} [bytes]
 * @returns {string}
 */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * @param {string} value
 * @returns {string}
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @param {string} value
 * @returns {Buffer}
 */
export function sha256Buffer(value) {
  return createHash('sha256').update(value).digest();
}

/**
 * PKCE S256 challenge, unpadded base64url.
 * @param {string} verifier
 * @returns {string}
 */
export function s256Challenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Compares two digests. Different lengths never match and never throw.
 * @param {Buffer} left
 * @param {Buffer} right
 */
export function digestEqual(left, right) {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * @param {string} left
 * @param {string} right
 */
export function textEqual(left, right) {
  return digestEqual(Buffer.from(left), Buffer.from(right));
}
