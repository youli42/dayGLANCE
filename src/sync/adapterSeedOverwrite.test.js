import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The file tier's seed branch: a provider `download()` that resolves falsy means
// "there is no remote file yet — seed it with local state", and that write is
// unconditional. For every WebDAV provider falsy means exactly HTTP 404, and
// `skipLockCheck` also drops the If-Match validator, so the server cannot refuse
// it and nothing was merged because nothing was read.
//
// On a device that has synced before, a 404 is far more often a transport
// artifact — a misrouted outbound proxy, a captive portal, a path that resolved
// differently this time — than a deleted file. Seeding it from local state then
// replaces the remote snapshot with this device's copy and loses whatever the
// other device had written.
//
// This walks dayGLANCE's own engine factory (adapter.js, the one App.jsx builds)
// so the guard is asserted where the app actually builds it rather than on the
// predicate alone — the same reason adapterUploadFailure.test.js exists.

const store = new Map();
const originalLocalStorage = globalThis.localStorage;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
};
afterAll(() => { globalThis.localStorage = originalLocalStorage; });

const { createDayGlanceEngine } = await import('./adapter.js');
const { MISSING_GRACE_MS } = await import('./absentRemoteSeedGuard.js');

const LAST_SYNCED_KEY = 'day-planner-cloud-sync-last-synced';
const T0 = new Date('2026-10-11T12:00:00.000Z');
const SYNCED_BEFORE = '2026-10-10T00:00:00.000Z';

// The payload the device holds. NON-EMPTY on purpose: the pre-existing
// empty-payload guard refuses a payload of nothing over a populated store, and
// the point of this file is that an older-but-complete local snapshot — which
// passes that guard — must not overwrite a remote file it could not read.
const LOCAL_TASKS = [{ id: 't1', title: 'mine', lastModified: '2026-10-09T00:00:00.000Z' }];

function build({ download }) {
  const calls = { status: [], lastSynced: [], errors: [] };
  const downloadSpy = vi.fn(async () => download);
  const uploadSpy = vi.fn(async () => {});
  const provider = {
    name: 'fake', configFields: [],
    download: downloadSpy,
    upload: uploadSpy,
    test: vi.fn(),
  };

  // Injected through the engine's own transport seam, so the guard the app
  // installs is the one under test — a test that wrapped the provider itself
  // would pass even with the production install removed.
  const engine = createDayGlanceEngine({
    buildPayload: async () => ({
      data: { tasks: LOCAL_TASKS, unscheduledTasks: [] },
      lastModified: '2026-10-09T00:00:00.000Z',
    }),
    buildBackupPayload: async () => ({}),
    applyPayload: async () => {},
    onStatusChange: (s) => calls.status.push(s),
    onError: (msg, code) => { if (msg) calls.errors.push(code); },
    onLastSyncedChange: (iso) => calls.lastSynced.push(iso),
    onConflict: () => {},
    onPassphraseRequired: () => {},
    onFirstSyncReload: () => {},
    getSyncRetentionDays: () => 90,
  }, { providers: { fake: provider } });

  // The guards replace the provider methods with wrappers, so read and write
  // assertions use the spies the engine calls through.
  expect(provider.download).not.toBe(downloadSpy);
  expect(provider.download.absentRemoteSeedGuarded).toBe(true);
  expect(provider.upload).not.toBe(uploadSpy);
  expect(provider.upload.verifiedWriteGuarded).toBe(true);

  localStorage.setItem('day-planner-cloud-sync-config', JSON.stringify({ enabled: true, provider: 'fake' }));
  localStorage.setItem('day-planner-tasks', JSON.stringify(LOCAL_TASKS));
  return { engine, provider, downloadSpy, uploadSpy, calls };
}

async function runCycle(engine) {
  const p = engine.download();
  await vi.advanceTimersByTimeAsync(3000);
  await p;
}

// App.jsx's own status reducer (line ~950): a queued 'idle' must not overwrite an
// in-flight status, which is how a refused upload would otherwise leave the UI
// reading "syncing…" forever.
const uiStatus = (statuses) => statuses.reduce(
  (prev, s) => (s === 'idle' && (prev === 'uploading' || prev === 'downloading') ? prev : s),
  'idle',
);

describe('the file tier never seeds over a remote file it could not read', () => {
  beforeEach(() => {
    store.clear();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('holds the seed on a device that has synced before', async () => {
    localStorage.setItem(LAST_SYNCED_KEY, SYNCED_BEFORE);
    const { engine, uploadSpy, downloadSpy } = build({ download: null });

    await runCycle(engine);

    expect(downloadSpy).toHaveBeenCalled();
    // Nothing reached the server, so the remote file is untouched, and the
    // device does not claim to have synced.
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(LAST_SYNCED_KEY)).toBe(SYNCED_BEFORE);
  });

  it('reports the hold and leaves the UI on a settled status, not on "syncing…"', async () => {
    localStorage.setItem(LAST_SYNCED_KEY, SYNCED_BEFORE);
    const { engine, calls } = build({ download: null });

    await runCycle(engine);

    expect(calls.errors).toContain('ABSENT_REMOTE_HOLD');
    expect(calls.lastSynced).toEqual([]);
    expect(calls.status).not.toContain('success');
    expect(uiStatus(calls.status)).toBe('idle');
  });

  it('still seeds once the absence outlasts the grace window', async () => {
    localStorage.setItem(LAST_SYNCED_KEY, SYNCED_BEFORE);
    const { engine, uploadSpy, calls } = build({ download: null });

    await runCycle(engine);
    expect(uploadSpy).not.toHaveBeenCalled();

    // The file really is gone: past the window the device re-seeds it, with no
    // user action — the hold has to be recoverable or sync stalls silently.
    vi.setSystemTime(T0.getTime() + MISSING_GRACE_MS + 1000);
    await runCycle(engine);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LAST_SYNCED_KEY)).not.toBe(SYNCED_BEFORE);
    // Stamped twice by the engine on a successful seed: once by upload(), once
    // by the cycle's own closing bookkeeping.
    expect(calls.lastSynced.length).toBeGreaterThan(0);
  });

  it('still seeds immediately on a device that has never synced', async () => {
    // No LAST_SYNCED_KEY: nothing can have been evicted on a first run, and
    // refusing here would strand a fresh install against a new empty remote.
    const { engine, uploadSpy, calls } = build({ download: null });

    await runCycle(engine);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(calls.lastSynced.length).toBeGreaterThan(0);
    expect(calls.errors).not.toContain('ABSENT_REMOTE_HOLD');
  });

  it('never holds an upload that a real read preceded', async () => {
    localStorage.setItem(LAST_SYNCED_KEY, SYNCED_BEFORE);
    const remote = {
      payload: { data: { tasks: [], unscheduledTasks: [] }, lastModified: '2026-10-01T00:00:00.000Z' },
      etag: '"e1"',
    };
    const { engine, uploadSpy, calls } = build({ download: remote });

    await runCycle(engine);

    // The merge pushed the local copy with the validator it just read, and the
    // guard stayed out of the way.
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0][2]).toBe('"e1"');
    expect(calls.errors).not.toContain('ABSENT_REMOTE_HOLD');
  });
});
