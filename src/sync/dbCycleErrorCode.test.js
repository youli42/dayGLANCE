import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { setSyncPassphrase } from '@glance-apps/sync';
import { createDbEngine } from './dbEngine.js';
import { setVaultConfig } from './vaultConfig.js';

// #2035: a failed GLANCEvault cycle reported every code-less error as
// NETWORK_ERROR ("Check your connection"), including failures that never
// touched the network. These walk the real engine: a transport throw must still
// read as a network error, a local throw must not.

function memLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

const EMPTY = {
  tasks: [], unscheduledTasks: [], recurringTasks: [], recycleBin: [], todayRoutines: [],
  habits: [], goals: [], projects: [], gtdFrames: [], users: [], dailyNotes: {},
  completedTaskUids: [], deletedTaskIds: {},
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const openBreaker = { beforeCycle: () => ({ allowed: true }), onSuccess() {}, onFailure() { return 0; } };

function makeEngine(name, overrides) {
  let data = clone(EMPTY);
  let nativeKey = null;
  const errors = [];
  const engine = createDbEngine({
    storageKeyPrefix: `dev-${name}`,
    deviceId: `device-${name}`,
    nativeGetSyncKey: () => nativeKey,
    nativeStoreSyncKey: (v) => { nativeKey = v; },
    getData: () => clone(data),
    commitData: (d) => { data = d; },
    onError: (msg, code) => { if (msg) errors.push({ msg, code }); },
    cycleBreaker: openBreaker,
    ...overrides,
  });
  return { engine, errors };
}

function memVault() {
  const salts = new Map();
  return {
    async getSalt(a) { return salts.get(a) || null; },
    async putSalt(a, s) { if (!salts.has(a)) salts.set(a, s); return salts.get(a); },
    async batch() { return { maxSeq: 1 }; },
    async deleteRow() { return { seq: 1 }; },
    async list() { return { rows: [], hasMore: false }; },
    async device() { return { updated: true }; },
  };
}

afterAll(() => { delete global.localStorage; });

describe('failed vault cycle error code (#2035)', () => {
  beforeEach(() => {
    global.localStorage = memLocalStorage();
    setVaultConfig({ enabled: true, vaultUrl: 'https://vault.test', vaultToken: 't', accountId: 'acct' });
    setSyncPassphrase('cycle-error-code-passphrase');
  });

  it('reports NETWORK_ERROR when the transport itself failed', async () => {
    const { engine, errors } = makeEngine('offline', {
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    const res = await engine.dbSyncCycle();
    expect(res.code).toBe('NETWORK_ERROR');
    expect(errors.at(-1)?.code).toBe('NETWORK_ERROR');
  });

  it('reports SYNC_FAILED, not NETWORK_ERROR, when the failure was local', async () => {
    // The snapshot write is IndexedDB: a quota or blocked-store failure there
    // happens after the vault already acked the push, and has nothing to do
    // with the connection.
    const { engine, errors } = makeEngine('local', {
      vaultClient: memVault(),
      snapshotStore: {
        async get() { return undefined; },
        async set() { throw new Error('snapshot write failed'); },
      },
    });
    const res = await engine.dbSyncCycle();
    expect(res.error).toMatch(/snapshot write failed/);
    expect(res.code).toBe('SYNC_FAILED');
    expect(errors.at(-1)).toEqual({ msg: 'snapshot write failed', code: 'SYNC_FAILED' });
  });
});
