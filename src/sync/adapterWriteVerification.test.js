import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The file tier's two unbacked writers — App.jsx's 5-second debounced upload on
// data changes (App.jsx:2444-2451) and the header/desktop sync button
// (DesktopHeader.jsx:64 → cloudSyncUpload → engine.upload()) — call the engine
// with no payload and no ETag. The provider then PUT the whole local snapshot
// with no If-Match, so a device that had never read the remote (a wrong server
// address, a proxy pointed at the wrong host) replaced whatever the other
// devices had written.
//
// This walks dayGLANCE's own engine factory, so the gate is asserted where the
// app actually builds it: an upload nothing read for is refused, and one the
// engine did not validate still carries the ETag of the last verified read.

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
const { VERIFIED_REMOTE_KEY } = await import('./verifiedRemote.js');

const CONFIG_KEY = 'day-planner-cloud-sync-config';
const LAST_SYNCED_KEY = 'day-planner-cloud-sync-last-synced';
const SYNCED_BEFORE = '2026-10-10T00:00:00.000Z';
const LOCAL_TASKS = [{ id: 't1', title: 'mine', lastModified: '2026-10-09T00:00:00.000Z' }];

const serverA = () => ({
  enabled: true, provider: 'webdav', webdavUrl: 'https://dav-a.example.com',
  username: 'me', appPassword: 'p', syncFolder: 'GLANCE/dayglance',
});
const serverB = () => ({ ...serverA(), webdavUrl: 'https://dav-b.example.com' });

function build({ download = null } = {}) {
  const calls = { status: [], lastSynced: [], errors: [] };
  let nextDownload = download;
  // The guards replace the provider methods with wrappers, so call assertions
  // read the spies the wrappers call through.
  const downloadSpy = vi.fn(async () => nextDownload);
  const uploadSpy = vi.fn(async () => {});
  const provider = {
    name: 'fake', configFields: [],
    download: downloadSpy,
    upload: uploadSpy,
    test: vi.fn(),
  };
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
  }, { appFolderName: 'GLANCE/dayglance', providers: { webdav: provider } });

  // The guards are installed on the map the engine reads.
  expect(provider.download.absentRemoteSeedGuarded).toBe(true);
  expect(provider.upload.verifiedWriteGuarded).toBe(true);

  localStorage.setItem(CONFIG_KEY, JSON.stringify(serverA()));
  localStorage.setItem('day-planner-tasks', JSON.stringify(LOCAL_TASKS));
  return { engine, provider, uploadSpy, calls, setDownload: (value) => { nextDownload = value; } };
}

const remoteFile = (etag, { taskId = 'remote-1' } = {}) => ({
  payload: { data: { tasks: [{ id: taskId, title: 'theirs', lastModified: '2026-10-11T00:00:00.000Z' }], unscheduledTasks: [] } },
  etag,
});

async function settle(promise) {
  await vi.advanceTimersByTimeAsync(3000);
  await promise;
}

// App.jsx's status reducer (line ~950): a queued 'idle' must not overwrite an
// in-flight status, which is how a refused upload would leave the UI on
// "syncing…" forever.
const uiStatus = (statuses) => statuses.reduce(
  (prev, s) => (s === 'idle' && (prev === 'uploading' || prev === 'downloading') ? prev : s),
  'idle',
);

describe('a write with no read behind it', () => {
  beforeEach(() => { store.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('is refused, reported, and leaves the UI settled', async () => {
    const { engine, uploadSpy, calls } = build();

    await settle(engine.upload());   // the 5-second debounce / the header button

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(calls.errors).toContain('WRITE_UNVERIFIED');
    expect(calls.status).not.toContain('success');
    expect(uiStatus(calls.status)).toBe('idle');
    expect(calls.lastSynced).toEqual([]);
  });

  it('is allowed after a read of the same target, with the ETag of that read', async () => {
    localStorage.setItem(LAST_SYNCED_KEY, SYNCED_BEFORE);
    const { engine, uploadSpy, setDownload } = build();
    setDownload(remoteFile('"e1"'));

    await settle(engine.download());                    // reads, merges, writes
    const cycleUploads = uploadSpy.mock.calls.length;
    expect(cycleUploads).toBeGreaterThan(0);
    expect(uploadSpy.mock.calls[0][2]).toBe('"e1"');

    await settle(engine.upload());                      // no read of its own
    expect(uploadSpy.mock.calls.length).toBe(cycleUploads + 1);
    // The server can now refuse a write built on stale knowledge.
    expect(uploadSpy.mock.calls[cycleUploads][2]).toBe('"e1"');
  });

  it('is refused after the sync target changes, until the new target is read', async () => {
    localStorage.setItem(LAST_SYNCED_KEY, SYNCED_BEFORE);
    const { engine, uploadSpy, calls, setDownload } = build();
    setDownload(remoteFile('"a1"'));
    await settle(engine.download());
    const afterCycle = uploadSpy.mock.calls.length;
    expect(afterCycle).toBeGreaterThan(0);

    // The user fixes a wrong address: same device, different server.
    localStorage.setItem(CONFIG_KEY, JSON.stringify(serverB()));
    await settle(engine.upload());
    expect(uploadSpy.mock.calls.length).toBe(afterCycle);   // nothing written
    expect(calls.errors).toContain('WRITE_UNVERIFIED');

    // Reading the new target is what re-opens writing, against its ETag.
    setDownload(remoteFile('"b1"', { taskId: 'remote-b' }));
    await settle(engine.download());
    const afterBTarget = uploadSpy.mock.calls.length;
    expect(uploadSpy.mock.calls[afterBTarget - 1][2]).toBe('"b1"');
    await settle(engine.upload());
    expect(uploadSpy.mock.calls[afterBTarget][2]).toBe('"b1"');
  });

  it('records the verified read per target, so a later device does not inherit it', async () => {
    localStorage.setItem(LAST_SYNCED_KEY, SYNCED_BEFORE);
    const { engine, setDownload } = build();
    setDownload(remoteFile('"a1"'));
    await settle(engine.download());

    const recorded = JSON.parse(localStorage.getItem(VERIFIED_REMOTE_KEY));
    expect(recorded.etag).toBe('"a1"');
    expect(recorded.targetKey).toContain('dav-a.example.com');

    localStorage.setItem(CONFIG_KEY, JSON.stringify(serverB()));
    setDownload(remoteFile('"b1"'));
    await settle(engine.download());
    const afterB = JSON.parse(localStorage.getItem(VERIFIED_REMOTE_KEY));
    expect(afterB.etag).toBe('"b1"');
    expect(afterB.targetKey).toContain('dav-b.example.com');
  });
});

describe('the seed branch', () => {
  beforeEach(() => { store.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('still seeds a first run, with no validator (the file is believed absent)', async () => {
    const { engine, uploadSpy, calls } = build();

    await settle(engine.download());

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0][2]).toBeNull();
    expect(calls.errors).not.toContain('WRITE_UNVERIFIED');
  });

  it('still holds an eviction on a device that has synced before', async () => {
    localStorage.setItem(LAST_SYNCED_KEY, SYNCED_BEFORE);
    const { engine, uploadSpy, calls } = build();

    await settle(engine.download());

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(calls.errors).toContain('ABSENT_REMOTE_HOLD');
  });
});
