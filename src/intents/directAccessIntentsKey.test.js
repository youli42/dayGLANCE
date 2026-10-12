import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { chooseSalt, keyForSalt, resolveDirectAccessIntentsKey, readOwnSalt, writeOwnSalt, DIRECT_ACCESS_INTENTS_SALT_KEY } from './directAccessIntentsKey.js';
import { serializeEventSet } from './folderIntents.js';

function memLocalStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
beforeEach(() => { global.localStorage = memLocalStorage(); });
afterAll(() => { delete global.localStorage; });

const SALT_A = btoa(String.fromCharCode(...new Uint8Array(16).fill(1)));
const SALT_B = btoa(String.fromCharCode(...new Uint8Array(16).fill(2)));

describe('chooseSalt', () => {
  it("the file's salt wins; then this device's; then WebDAV's; then a new one", () => {
    const random = () => 'NEW';
    expect(chooseSalt({ fileSalt: 'F', ownSalt: 'O', webdavSalt: 'W', random })).toBe('F');
    expect(chooseSalt({ fileSalt: null, ownSalt: 'O', webdavSalt: 'W', random })).toBe('O');
    expect(chooseSalt({ fileSalt: null, ownSalt: null, webdavSalt: 'W', random })).toBe('W');
    expect(chooseSalt({ fileSalt: null, ownSalt: null, webdavSalt: null, random })).toBe('NEW');
  });
});

describe('keyForSalt', () => {
  it('uses the cached key for the same salt, derives and caches from the passphrase for another, and answers null without either', async () => {
    const store = { record: null };
    const loadCached = async () => store.record;
    const storeCached = vi.fn(async (r) => { store.record = r; });
    expect(await keyForSalt(SALT_A, { passphrase: null, loadCached, storeCached })).toBeNull();
    const k1 = await keyForSalt(SALT_A, { passphrase: 'pw', loadCached, storeCached });
    expect(k1).toBeTruthy();
    expect(storeCached).toHaveBeenCalledTimes(1);
    // Same salt, no passphrase: the cached key.
    expect(await keyForSalt(SALT_A, { passphrase: null, loadCached, storeCached })).toBe(k1);
    // A different salt: not the cached key; derived again when the passphrase is there.
    expect(await keyForSalt(SALT_B, { passphrase: null, loadCached, storeCached })).toBeNull();
    const k2 = await keyForSalt(SALT_B, { passphrase: 'pw', loadCached, storeCached });
    expect(k2).toBeTruthy();
    expect(store.record.saltB64).toBe(SALT_B);
    expect(await keyForSalt(null, { passphrase: 'pw', loadCached, storeCached })).toBeNull();
  });
});

describe('resolveDirectAccessIntentsKey', () => {
  const transportOver = (text) => ({ eventsRead: async () => text });
  it('adopts the salt the file names and remembers it; brings its own, WebDAV\'s or a new one to a file without', async () => {
    const store = { record: null };
    const deps = { loadCached: async () => store.record, storeCached: async (r) => { store.record = r; }, passphrase: 'pw', random: () => 'NEW' };
    // The file names a salt: adopted, derived, remembered as this device's.
    const r1 = await resolveDirectAccessIntentsKey({ transport: transportOver(serializeEventSet([], 'x', SALT_A)), ...deps });
    expect(r1.salt).toBe(SALT_A);
    expect(r1.key).toBeTruthy();
    expect(readOwnSalt()).toBe(SALT_A);
    // The file lost its salt (a conflicted copy): this device brings the same one back.
    const r2 = await resolveDirectAccessIntentsKey({ transport: transportOver(serializeEventSet([])), ...deps, webdavSalt: async () => 'W' });
    expect(r2.salt).toBe(SALT_A);
    expect(r2.key).toBe(r1.key);
    // Nothing anywhere: WebDAV's salt when this device has WebDAV intents, else a new one.
    writeOwnSalt(null);
    expect((await resolveDirectAccessIntentsKey({ transport: transportOver(null), ...deps, webdavSalt: async () => SALT_B })).salt).toBe(SALT_B);
    writeOwnSalt(null);
    expect((await resolveDirectAccessIntentsKey({ transport: transportOver(null), ...deps })).salt).toBe('NEW');
    expect(localStorage.getItem(DIRECT_ACCESS_INTENTS_SALT_KEY)).toBe('NEW');
  });

  it('answers the salt with no key when no passphrase is in memory and nothing cached matches', async () => {
    const r = await resolveDirectAccessIntentsKey({ transport: transportOver(serializeEventSet([], 'x', SALT_A)), loadCached: async () => null, storeCached: async () => {}, passphrase: null });
    expect(r).toEqual({ salt: SALT_A, key: null });
  });
});
