import { describe, expect, it } from 'vitest';
import { createAbsentRemoteSeedGuard, MISSING_GRACE_MS } from './absentRemoteSeedGuard.js';
import {
  createVerifiedWriteGuard,
  installVerifiedWriteGuard,
  targetScopedHasSyncedBefore,
  CYCLE_READ_TTL_MS,
  WRITE_UNVERIFIED_CODE,
  WRITE_UNVERIFIED_REASON,
} from './verifiedWriteGuard.js';
import { VERIFIED_REMOTE_KEY, readVerifiedRemote } from './verifiedRemote.js';

const T0 = Date.parse('2026-10-12T12:00:00.000Z');

const storage = () => {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    get size() { return store.size; },
  };
};

// The gate under test, wired the way adapter.js wires it.
const gate = ({ hasSyncedBefore = true, target = 'T1', now = () => T0, store = storage() } = {}) => {
  const seedGuard = createAbsentRemoteSeedGuard({ hasSyncedBefore: () => hasSyncedBefore, now });
  const guard = createVerifiedWriteGuard({ seedGuard, targetKey: () => target, storage: store, now });
  return { guard, store };
};

describe('the verified-write gate', () => {
  it('lets the cycle write through with the ETag the cycle just read', () => {
    const { guard } = gate();
    guard.observeRead({ payload: { tasks: [] }, etag: '"e1"' });
    expect(guard.decideWrite()).toEqual({ allowed: true, mode: 'cycle', etag: '"e1"' });
    expect(guard.consumeWritePlan()).toEqual({ mode: 'cycle', etag: '"e1"' });
    expect(guard.consumeWritePlan()).toBeNull(); // one-shot
  });

  it('records the verified read of the current target for later writes', () => {
    const { guard, store } = gate();
    guard.observeRead({ payload: {}, etag: '"e1"' });
    expect(readVerifiedRemote(store)).toMatchObject({ targetKey: 'T1', etag: '"e1"', readAt: T0 });
  });

  it('refuses a write that no read backs, and says so', () => {
    const { guard } = gate();
    expect(guard.decideWrite()).toEqual({
      allowed: false, mode: 'unverified', code: WRITE_UNVERIFIED_CODE, reason: WRITE_UNVERIFIED_REASON,
    });
  });

  it('makes a write that no read backs conditional on the last verified read', () => {
    // App.jsx's 5-second debounce and the header button: engine.upload() with no
    // read. The server must be able to refuse it.
    const { guard } = gate();
    guard.observeRead({ payload: {}, etag: '"e1"' });
    guard.decideWrite();                  // the cycle's own write consumes this read
    expect(guard.decideWrite()).toEqual({ allowed: true, mode: 'conditional', etag: '"e1"' });
    expect(guard.consumeWritePlan()).toEqual({ mode: 'conditional', etag: '"e1"' });
  });

  it('never authorizes a write with a read of a different target', () => {
    let target = 'server-A';
    const seedGuard = createAbsentRemoteSeedGuard({ hasSyncedBefore: () => true, now: () => T0 });
    const guard = createVerifiedWriteGuard({ seedGuard, targetKey: () => target, storage: storage(), now: () => T0 });
    guard.observeRead({ payload: {}, etag: '"A1"' });
    guard.decideWrite();                  // consumed by the A cycle
    target = 'server-B';                  // the user fixes the address
    expect(guard.decideWrite().allowed).toBe(false);
    // and reading the new target is what re-opens writing
    guard.observeRead({ payload: {}, etag: '"B1"' });
    expect(guard.decideWrite()).toEqual({ allowed: true, mode: 'cycle', etag: '"B1"' });
  });

  it('does not reuse a read older than the cycle window', () => {
    let now = T0;
    const seedGuard = createAbsentRemoteSeedGuard({ hasSyncedBefore: () => true, now: () => now });
    const guard = createVerifiedWriteGuard({ seedGuard, targetKey: () => 'T1', storage: storage(), now: () => now });
    guard.observeRead({ payload: {}, etag: '"e1"' });
    now = T0 + CYCLE_READ_TTL_MS + 1;
    // The stale read cannot authorize an unbacked write; the persisted ETag can
    // (it is the same knowledge, and the server validates it).
    expect(guard.decideWrite()).toEqual({ allowed: true, mode: 'conditional', etag: '"e1"' });
  });

  it('authorizes a seed write with no validator, even after a verified read', () => {
    // The file is believed absent: `If-Match` would demand it exist, so the seed
    // must not carry one. The seed rule owns whether the absence is real.
    const { guard } = gate({ hasSyncedBefore: false });
    guard.observeRead({ payload: {}, etag: '"old"' });   // an earlier read of this target
    guard.decideWrite();                                  // consumed
    guard.observeRead(null);                              // now the file is gone
    expect(guard.decideWrite()).toEqual({ allowed: true, mode: 'seed' });
    expect(guard.consumeWritePlan()).toEqual({ mode: 'seed', etag: null });
  });

  it('reports the absence hold instead of letting the seed through', () => {
    const { guard } = gate({ hasSyncedBefore: true });
    guard.observeRead(null);
    expect(guard.decideWrite()).toEqual({
      allowed: false, mode: 'seed-held', code: 'ABSENT_REMOTE_HOLD', reason: expect.stringContaining('missing'),
    });
  });

  it('still seeds a genuine absence once the grace window expires', () => {
    let now = T0;
    const seedGuard = createAbsentRemoteSeedGuard({ hasSyncedBefore: () => true, now: () => now });
    const guard = createVerifiedWriteGuard({ seedGuard, targetKey: () => 'T1', storage: storage(), now: () => now });
    guard.observeRead(null);
    expect(guard.decideWrite().allowed).toBe(false);
    now = T0 + MISSING_GRACE_MS;
    guard.observeRead(null);
    expect(guard.decideWrite()).toEqual({ allowed: true, mode: 'seed' });
  });

  it('refuses an unbacked write when the server sends no ETag', () => {
    // A cycle write still goes out (the engine merged first and would stop
    // syncing otherwise); a write nothing read for has nothing to stand on.
    const { guard } = gate();
    guard.observeRead({ payload: {} });                  // 200, no ETag header
    expect(guard.decideWrite()).toEqual({ allowed: true, mode: 'cycle', etag: null });
    expect(guard.decideWrite().allowed).toBe(false);
  });

  it('does not let a stale absence authorize a later write', () => {
    // A cycle read nothing and then never reached its upload (the payload build
    // threw). The absence must not still be standing when an unrelated upload
    // arrives: that would be an unconditional write with no read behind it.
    let now = T0;
    const seedGuard = createAbsentRemoteSeedGuard({ hasSyncedBefore: () => false, now: () => now });
    const guard = createVerifiedWriteGuard({ seedGuard, targetKey: () => 'T1', storage: storage(), now: () => now });
    guard.observeRead(null);                             // first run: the seed rule would allow it
    now = T0 + CYCLE_READ_TTL_MS + 1;
    expect(guard.decideWrite()).toEqual({
      allowed: false, mode: 'unverified', code: WRITE_UNVERIFIED_CODE, reason: WRITE_UNVERIFIED_REASON,
    });
  });

  it('lets a real read end the absence, so the next write is a normal cycle write', () => {
    const { guard } = gate({ hasSyncedBefore: false });
    guard.observeRead(null);                             // the file was missing
    guard.observeRead({ payload: {}, etag: '"e2"' });    // the file is back
    expect(guard.decideWrite()).toEqual({ allowed: true, mode: 'cycle', etag: '"e2"' });
  });

  it('records the target of the last successful sync', () => {
    const { guard, store } = gate();
    guard.recordLastSyncedTarget();
    expect(readVerifiedRemote(store)).toMatchObject({ lastSyncTargetKey: 'T1', lastSyncedAt: T0 });
  });
});

describe('installVerifiedWriteGuard', () => {
  const provider = () => {
    const calls = { download: 0, upload: [] };
    return {
      calls,
      name: 'fake',
      getFileUrl: () => 'https://dav.example.com/GLANCE/dayglance/dayglance-sync.json',
      async download() { calls.download += 1; return this.result; },
      async upload(cfg, envelope, etag = null) { calls.upload.push({ cfg, envelope, etag, fileUrl: this.getFileUrl() }); },
    };
  };

  it('observes reads and injects the validator into an unbacked upload', async () => {
    const { guard } = gate();
    const p = provider();
    installVerifiedWriteGuard({ webdav: p }, guard);
    expect(p.download.absentRemoteSeedGuarded).toBe(true);
    expect(p.upload.verifiedWriteGuarded).toBe(true);

    p.result = { payload: {}, etag: '"e1"' };
    // `this` survives the wrapper: providers call this.getFileUrl().
    expect(await p.download({})).toEqual({ payload: {}, etag: '"e1"' });

    guard.decideWrite();                        // the cycle's own write
    await p.upload({}, { data: {} });           // no ETag from the engine
    expect(p.calls.upload[0].etag).toBe('"e1"');
    expect(p.calls.upload[0].fileUrl).toBe('https://dav.example.com/GLANCE/dayglance/dayglance-sync.json');
  });

  it('falls back to the verified read when the engine uploads without validating', async () => {
    // The gate lives in the validator; this covers the package calling upload()
    // directly, which must still not write unconditionally.
    const { guard } = gate();
    const p = provider();
    installVerifiedWriteGuard({ webdav: p }, guard);
    p.result = { payload: {}, etag: '"e1"' };
    await p.download({});
    guard.decideWrite();
    guard.discardWritePlan();
    await p.upload({}, { data: {} });
    expect(p.calls.upload[0].etag).toBe('"e1"');
  });

  it('keeps the ETag the engine supplied', async () => {
    const { guard } = gate();
    const p = provider();
    installVerifiedWriteGuard({ webdav: p }, guard);
    guard.observeRead({ payload: {}, etag: '"read"' });
    guard.decideWrite();
    await p.upload({}, { data: {} }, '"engine"');
    expect(p.calls.upload[0].etag).toBe('"engine"');
  });

  it('does not put If-Match on a seed write', async () => {
    const { guard } = gate({ hasSyncedBefore: false });
    const p = provider();
    installVerifiedWriteGuard({ webdav: p }, guard);
    p.result = null;
    await p.download({});
    guard.decideWrite();
    await p.upload({}, { data: {} });
    expect(p.calls.upload[0].etag).toBeNull();
  });

  it('is idempotent and tolerates a missing providers map', () => {
    const { guard } = gate();
    const p = provider();
    installVerifiedWriteGuard({ webdav: p }, guard);
    const downloadOnce = p.download;
    const uploadOnce = p.upload;
    installVerifiedWriteGuard({ webdav: p }, guard);
    expect(p.download).toBe(downloadOnce);
    expect(p.upload).toBe(uploadOnce);
    expect(() => installVerifiedWriteGuard(undefined, guard)).not.toThrow();
  });
});

describe('targetScopedHasSyncedBefore', () => {
  it('is true only for the target this device synced', () => {
    const store = storage();
    store.setItem(VERIFIED_REMOTE_KEY, JSON.stringify({ lastSyncTargetKey: 'A' }));
    expect(targetScopedHasSyncedBefore({ targetKey: () => 'A', storage: store })).toBe(true);
    expect(targetScopedHasSyncedBefore({ targetKey: () => 'B', storage: store })).toBe(false);
  });

  it('falls back to the engine stamp only while no target has been recorded', () => {
    const store = storage();
    store.setItem('day-planner-cloud-sync-last-synced', '2026-10-01T00:00:00.000Z');
    expect(targetScopedHasSyncedBefore({ targetKey: () => 'B', storage: store, legacyLastSyncedKey: 'day-planner-cloud-sync-last-synced' })).toBe(true);
    store.setItem(VERIFIED_REMOTE_KEY, JSON.stringify({ lastSyncTargetKey: 'A' }));
    expect(targetScopedHasSyncedBefore({ targetKey: () => 'B', storage: store, legacyLastSyncedKey: 'day-planner-cloud-sync-last-synced' })).toBe(false);
  });

  it('is false with neither record nor stamp', () => {
    expect(targetScopedHasSyncedBefore({ targetKey: () => 'A', storage: storage() })).toBe(false);
  });
});
