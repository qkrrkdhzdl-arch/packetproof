/*
 * hash.js — content fingerprints via WebCrypto.
 *
 * Two files with the same bytes get the same SHA-256 here even when their
 * names differ, which is how Packetproof catches "the same file attached
 * twice under two names" and how a sealed manifest proves afterwards exactly
 * which bytes were in the packet.
 */

export async function sha256Hex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const short = (hex, n = 8) => hex.slice(0, n);
