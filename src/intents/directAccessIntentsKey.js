/**
 * The Direct Access intents key (docs/direct-access-sync.md, Phase 7).
 *
 * Encrypted envelopes in the folder's event set are sealed under per-envelope
 * keys derived from one root key, and every device on the folder has to
 * derive the same root key: the sync passphrase they share, and one salt. The
 * WebDAV intents transport keeps its salt in a file on the server, which a
 * folder-only device (a phone with no WebDAV at all) can never reach, and an
 * iPhone holds a bookmark to the event set alone and could not read a second
 * file beside it. So the salt travels IN the event set:
 *
 *   glance-events.json = { version: 1, writtenBy?, salt?: base64, events }
 *
 * The file's salt, once there, is the salt: the merge keeps it and no device
 * replaces it. A sender that wants to encrypt and finds no salt in the file
 * brings one, in this order: the salt it already seeded (kept locally, so a
 * file the syncing tool loses is reseeded with the same one), the WebDAV
 * salt when this device also runs WebDAV intents (so the key it already holds
 * is the folder's key, and envelopes sealed before the salt travelled stay
 * readable), else a fresh random one. The derived key is cached with its
 * salt; a file naming a different salt means a new key, derived again from
 * the passphrase when it is in memory and asked for once when it is not.
 */

import { deriveIntentsRootKey } from '@glance-apps/intents';
import { getSyncPassphrase } from '../utils/crypto.js';
import { loadDirectAccessIntentsKey, storeDirectAccessIntentsKey } from './intentsKeyStore.js';
import { parseEventSetText, relativeEventsPath } from './folderIntents.js';

/** base64 of the 16 salt bytes this device brought to the event set, kept so a lost file is reseeded with the same one. */
export const DIRECT_ACCESS_INTENTS_SALT_KEY = 'dayglance-direct-access-intents-salt';

const defaultStorage = () => (typeof localStorage !== 'undefined' ? localStorage : null);

export function readOwnSalt(storage = defaultStorage()) {
  try { const v = storage?.getItem(DIRECT_ACCESS_INTENTS_SALT_KEY); return typeof v === 'string' && v ? v : null; } catch { return null; }
}
export function writeOwnSalt(saltB64, storage = defaultStorage()) {
  try { if (saltB64) storage?.setItem(DIRECT_ACCESS_INTENTS_SALT_KEY, saltB64); else storage?.removeItem(DIRECT_ACCESS_INTENTS_SALT_KEY); } catch { /* ignore */ }
}

export const newSaltB64 = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
};
export const saltBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Pure: the salt a sender uses. The file's wins; then what this device brought before; then WebDAV's; then a new one. */
export function chooseSalt({ fileSalt, ownSalt, webdavSalt, random = newSaltB64 }) {
  return fileSalt || ownSalt || webdavSalt || random();
}

/**
 * The root key for a salt: the cached one when it was derived from this
 * salt, else derived from the passphrase in memory and cached, else null.
 */
export async function keyForSalt(saltB64, { passphrase = getSyncPassphrase(), loadCached = loadDirectAccessIntentsKey, storeCached = storeDirectAccessIntentsKey } = {}) {
  if (!saltB64) return null;
  let cached = null;
  try { cached = await loadCached(); } catch { cached = null; }
  if (cached && cached.saltB64 === saltB64 && cached.key) return cached.key;
  if (!passphrase) return null;
  const key = await deriveIntentsRootKey(passphrase, saltBytes(saltB64));
  try { await storeCached({ saltB64, key }); } catch { /* the key still serves this session */ }
  return key;
}

/** The salt the event set names, or null: absent file, no salt yet, or a file that cannot be read now. */
export async function readFileSalt(transport, eventsPath) {
  try {
    const read = parseEventSetText(await transport.eventsRead(relativeEventsPath(eventsPath)));
    return read.kind === 'set' ? read.salt : null;
  } catch {
    return null;
  }
}

/**
 * What a sender needs to seal: the salt the file names (or the one this
 * device brings) and the key for it. `key` is null when no passphrase is in
 * memory and no cached key matches: hold, and ask for the passphrase.
 *
 * @returns {Promise<{salt: string, key: CryptoKey|null}>}
 */
export async function resolveDirectAccessIntentsKey({ transport, eventsPath, storage = defaultStorage(), webdavSalt = async () => null, passphrase, loadCached, storeCached, random } = {}) {
  const fileSalt = await readFileSalt(transport, eventsPath);
  const ownSalt = readOwnSalt(storage);
  const salt = chooseSalt({ fileSalt, ownSalt, webdavSalt: fileSalt || ownSalt ? null : await webdavSalt(), random });
  if (salt !== ownSalt) writeOwnSalt(salt, storage);
  const key = await keyForSalt(salt, { ...(passphrase !== undefined ? { passphrase } : {}), ...(loadCached ? { loadCached } : {}), ...(storeCached ? { storeCached } : {}) });
  return { salt, key };
}
