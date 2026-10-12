/**
 * What this device last verified about the remote sync file, per target.
 *
 * ── Why it is device-local state, and why it is stored at all ──────────────
 * The write guard's whole job is "this write is built on knowledge we have".
 * Two facts have to survive a reload, or the guard forgets them and falls back
 * to the behaviour that lost data:
 *
 *   • the ETag of the last successful read of a target — without it a write the
 *     engine did not read for (the 5-second debounce, the header button) has no
 *     validator to send, and an unconditional PUT is exactly the overwrite;
 *   • which target the last successful sync was against — without it "this device
 *     has synced before" is a global stamp, so a new (empty) folder is treated as
 *     a hazy absence and a new server inherits the old one's absence streak.
 *
 * `createdAt`/`readAt` are epoch ms from the device clock; they order this
 * device's own observations, never another device's.
 *
 * A corrupt or unreadable record reads as "nothing verified" — the guard then
 * refuses writes it cannot justify rather than guessing.
 */

export const VERIFIED_REMOTE_KEY = 'day-planner-cloud-sync-verified-remote';

const EMPTY = Object.freeze({
  targetKey: null,
  etag: null,
  readAt: 0,
  lastSyncTargetKey: null,
  lastSyncedAt: 0,
});

const storageOrNull = (storage) => {
  if (storage) return storage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
};

const asString = (value) => (typeof value === 'string' && value ? value : null);
const asTime = (value) => (Number.isFinite(value) ? value : 0);

/**
 * @param {Storage|null} [storage] injectable for tests
 * @returns {{targetKey:string|null, etag:string|null, readAt:number,
 *            lastSyncTargetKey:string|null, lastSyncedAt:number}}
 */
export function readVerifiedRemote(storage) {
  const store = storageOrNull(storage);
  if (!store) return { ...EMPTY };
  try {
    const raw = store.getItem(VERIFIED_REMOTE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    return {
      targetKey: asString(parsed.targetKey),
      etag: asString(parsed.etag),
      readAt: asTime(parsed.readAt),
      lastSyncTargetKey: asString(parsed.lastSyncTargetKey),
      lastSyncedAt: asTime(parsed.lastSyncedAt),
    };
  } catch {
    // Unreadable (corrupt JSON, storage disabled): nothing is verified.
    return { ...EMPTY };
  }
}

/**
 * Merge `patch` into the stored record. Never throws: a device whose storage is
 * full or unavailable keeps syncing with an unverified guard (and therefore keeps
 * refusing writes it cannot justify) instead of breaking the sync cycle.
 */
export function writeVerifiedRemote(patch, storage) {
  const store = storageOrNull(storage);
  if (!store) return { ...EMPTY };
  const next = { ...readVerifiedRemote(store), ...(patch || {}) };
  try { store.setItem(VERIFIED_REMOTE_KEY, JSON.stringify(next)); } catch { /* kept in memory for this cycle */ }
  return next;
}

export function clearVerifiedRemote(storage) {
  const store = storageOrNull(storage);
  if (!store) return;
  try { store.removeItem(VERIFIED_REMOTE_KEY); } catch { /* nothing to clear */ }
}
