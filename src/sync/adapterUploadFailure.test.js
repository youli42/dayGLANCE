import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// #2037: a WebDAV cycle whose upload failed still stamped "Last synced" and
// reported success, so a device whose writes never reached the server looked
// synced forever. Fixed in @glance-apps/sync 2.1.1; this walks dayGLANCE's own
// engine factory (adapter.js, the one App.jsx builds) so a later package bump
// cannot quietly bring the masking back.

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

const LAST_SYNCED_KEY = 'day-planner-cloud-sync-last-synced';

function build({ download, uploadError }) {
  const calls = { status: [], lastSynced: [], errors: [] };
  const uploadSpy = vi.fn(async () => { throw uploadError; });
  const provider = {
    name: 'fake', configFields: [],
    download: vi.fn(async () => download),
    upload: uploadSpy,
    test: vi.fn(),
  };
  // Injected through the engine's own transport seam, so the production guards
  // (absent-remote + verified write) wrap the transport under test. A provider
  // assigned onto engine.providers afterwards would bypass them and this test
  // would be exercising a path the app never runs.
  const engine = createDayGlanceEngine({
    buildPayload: async () => ({ data: { tasks: [], unscheduledTasks: [] }, lastModified: '2026-10-01T00:00:00.000Z' }),
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
  localStorage.setItem('day-planner-cloud-sync-config', JSON.stringify({ enabled: true, provider: 'fake' }));
  return { engine, provider, uploadSpy, calls };
}

describe('WebDAV cycle with a failing upload (#2037)', () => {
  beforeEach(() => { store.clear(); vi.useFakeTimers(); });

  it('seeding an empty remote: a failed upload is reported and "Last synced" is not stamped', async () => {
    const { engine, uploadSpy, calls } = build({ download: null, uploadError: new Error('Upload failed: 409 Conflict') });
    const p = engine.download();
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    vi.useRealTimers();
    expect(uploadSpy).toHaveBeenCalled();
    expect(localStorage.getItem(LAST_SYNCED_KEY)).toBe(null);
    expect(calls.lastSynced).toEqual([]);
    expect(calls.status).toContain('error');
    expect(calls.status).not.toContain('success');
    expect(calls.errors.length).toBeGreaterThan(0);
  });
});
