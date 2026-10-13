import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// End-to-end pin for the mid-cycle edit guard (sync/midCyclePayloadEdits.js,
// wired in sync/adapter.js): a task completed while the WebDAV/file-tier cycle
// is uploading must not be erased by that cycle's commit.
//
// The cycle reads this device ONCE (`buildPayload` at the head of the merge),
// then AWAITS the upload, then calls `applyPayload(mergedData)` — App.jsx's
// applyEngineData, a whole-state replace. An edit made during the upload exists
// only in live state, so before the guard it was silently lost: the checkbox
// ticked and jumped back, and the reverted copy was PUT to the server too. The
// GLANCEvault tier guards its own cycle with mergeMidCycleEdits; this suite
// holds the file tier to the same outcome, over the real engine factory.

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

const CONFIG_KEY = 'day-planner-cloud-sync-config';
const LAST_SYNCED_KEY = 'day-planner-cloud-sync-last-synced';
const SYNCED_BEFORE = '2026-10-10T00:00:00.000Z';

const T1_INCOMPLETE = {
  id: 't1', title: 'mine', duration: 30, color: 'bg-blue-500', completed: false,
  notes: '', subtasks: [], lastModified: '2026-10-09T00:00:00.000Z',
};
const T1_COMPLETED = {
  ...T1_INCOMPLETE, completed: true, completedAt: '2026-10-12T12:00:01+02:00', transitionId: 'tr-1',
  // Deliberately the SAME stamp: a click landing inside applyEngineData's
  // suppressTimestampRef window leaves the completion unstamped, which is the
  // shape the report hit. The guard must not depend on the stamp advancing.
};

// A remote copy carrying a task this device does not have, so the merge reports
// localChanged and the cycle therefore applies.
const remoteWithNewTask = () => ({
  data: {
    tasks: [...JSON.parse(JSON.stringify([T1_INCOMPLETE])), {
      id: 'remote-1', title: 'theirs', duration: 30, color: 'bg-blue-500', completed: false,
      notes: '', subtasks: [], lastModified: '2026-10-11T00:00:00.000Z',
    }],
    unscheduledTasks: [],
  },
});

function build() {
  let live = [T1_INCOMPLETE];
  let applied = null;
  const puts = [];
  let releaseUpload = null;
  const uploadGate = new Promise((r) => { releaseUpload = r; });
  let uploads = 0;

  const engine = createDayGlanceEngine({
    buildPayload: async () => {
      localStorage.setItem('day-planner-tasks', JSON.stringify(live));
      return { data: { tasks: live, unscheduledTasks: [] }, lastModified: '2026-10-09T00:00:00.000Z' };
    },
    buildBackupPayload: async () => ({}),
    // applyEngineData: replaces task state (and storage) with the applied payload.
    applyPayload: async (data) => { applied = data; live = data.tasks; localStorage.setItem('day-planner-tasks', JSON.stringify(data.tasks)); },
    onStatusChange: () => {}, onError: () => {}, onLastSyncedChange: () => {},
    onConflict: () => {}, onPassphraseRequired: () => {}, onFirstSyncReload: () => {},
    getSyncRetentionDays: () => 90,
  }, {
    appFolderName: 'GLANCE/dayglance',
    providers: {
      webdav: {
        name: 'fake', configFields: [], test: async () => true,
        download: async () => ({ payload: remoteWithNewTask(), etag: '"s1"' }),
        upload: async (_cfg, envelope) => {
          uploads += 1;
          puts.push(JSON.parse(JSON.stringify(envelope.data.tasks)));
          if (uploads === 1) await uploadGate; // hold the network window open
          return { etag: `"s${uploads + 1}"` };
        },
      },
    },
  });
  return {
    engine,
    puts,
    /** Resolve the cycle's in-flight upload (the user's click has happened by now). */
    releaseUpload: () => releaseUpload(),
    /** The window is open when the first upload has been entered. */
    uploadsEntered: () => uploads,
    setLive: (tasks) => { live = tasks; },
    applied: () => applied,
    live: () => live,
  };
}

describe('a completion made during the cycle’s upload window', () => {
  beforeEach(() => {
    store.clear();
    localStorage.setItem(CONFIG_KEY, JSON.stringify({
      enabled: true, provider: 'webdav', webdavUrl: 'https://dav.example.com',
      username: 'me', appPassword: 'p', syncFolder: 'GLANCE/dayglance',
    }));
    localStorage.setItem(LAST_SYNCED_KEY, SYNCED_BEFORE);
    localStorage.setItem('day-planner-tasks', JSON.stringify([T1_INCOMPLETE]));
  });

  /** Real timers here on purpose: the cycle is deliberately parked on the upload. */
  const until = async (predicate) => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
    return predicate();
  };

  it('is not erased by the cycle it raced, and reaches the server', async () => {
    const h = build();
    const cycle = h.engine.download();

    // Wait until the cycle has entered its upload (the network window).
    expect(await until(() => h.uploadsEntered() === 1)).toBe(true);

    // The click, inside the window — no stamp advance (the suppress-window shape).
    h.setLive([T1_COMPLETED]);
    h.releaseUpload();
    await cycle;

    // The commit kept the completion...
    expect(h.applied()).not.toBeNull();
    expect(h.applied().tasks.find((t) => t.id === 't1').completed).toBe(true);
    expect(h.live().find((t) => t.id === 't1').completed).toBe(true);
    // ...and the pulled peer task still landed (the guard does not swallow remote work).
    expect(h.live().some((t) => t.id === 'remote-1')).toBe(true);

    // The PUT that was already in flight carried the pre-click copy — the guard
    // is at the commit, downstream of it (the same snapshot contract the vault
    // tier documents: the survivor is pushed by the NEXT cycle).
    expect(h.puts[0].find((t) => t.id === 't1').completed).toBe(false);

    // Next cycle: the surviving completion is no longer absent from the pushed
    // copy — it reaches the server instead of being lost forever.
    await h.engine.download();
    expect(h.puts[h.puts.length - 1].find((t) => t.id === 't1').completed).toBe(true);
  }, 20000);
});
