import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { deriveIntentsRootKey } from '@glance-apps/intents';
import {
  vaultDeliverer,
  webdavDeliverer,
  icloudDeliverer,
  directAccessDeliverer,
  DELIVERED,
  TRANSIENT,
  PERMANENT,
} from './deliverers.js';
import { HELD_NO_KEY_REASON } from './outbox.js';
import { resetVaultDiagnostics } from '@glance-apps/sync';

// ─────────────────────────────────────────────────────────────────────────────
// Intents deliverers (stage 2a). These exercise the REAL deliverers and the REAL
// @glance-apps/intents codec (deriveIntentsRootKey / buildEncryptedEnvelope /
// buildIntentRow) with all transport I/O injected — no network, no IndexedDB.
//
// The vault deliverer is ALWAYS encrypted: with a key it builds ciphertext and
// POSTs; with no key it returns 'transient' and sends/builds nothing.
// ─────────────────────────────────────────────────────────────────────────────

function memLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}
beforeEach(() => { global.localStorage = memLocalStorage(); resetVaultDiagnostics(); });
afterAll(() => { delete global.localStorage; });

const CONN = { vaultUrl: 'https://vault.example.com', vaultToken: 'tok-123', accountId: 'acct-1' };

// A schema-valid notify payload (buildEnvelope validates the plaintext payload).
function validPayload(title = 'SECRET-TITLE') {
  return {
    event_id: 'evt-1',
    source_app: 'app.testglance',
    source_entity_id: 'se-1',
    event: 'completed',
    task_id: 'task-1',
    title,
    timestamp: '2026-01-01T00:00:00.000Z',
    entity_type: 'task',
  };
}

// A raw outbox intent (NOT an envelope): action + payload + emit metadata, keyed
// by event_id. emitted_by is a FOREIGN app so nothing is treated as loopback.
function makeIntent(eventId = '20260101T000000Z-aaa111', title = 'SECRET-TITLE') {
  return {
    event_id: eventId,
    action: 'notify',
    emitted_by: 'app.testglance',
    payload: validPayload(title),
  };
}

function decodeRowEnvelope(b64) {
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

async function aRootKey(seed = 1) {
  return deriveIntentsRootKey('pw', new Uint8Array(16).fill(seed));
}

// ─── 1. VAULT deliverer ───────────────────────────────────────────────────────

describe('vault deliverer', () => {
  // (a) WITH a cached key → builds an ENCRYPTED envelope and POSTs.
  it('(a) with a cached key builds ciphertext and POSTs /intents/batch', async () => {
    const captured = [];
    const vaultFetch = vi.fn(async (method, url, headers, body) => {
      captured.push({ method, url, headers, body });
      return { status: 200, ok: true, body: JSON.stringify({ written: 1, maxSeq: 7 }) };
    });
    const rootKey = await aRootKey();

    const result = await vaultDeliverer(makeIntent(), {
      connection: CONN, config: { ttlMs: 1000 }, vaultFetch, loadKey: async () => rootKey,
    });

    expect(result).toBe(DELIVERED);
    expect(vaultFetch).toHaveBeenCalledTimes(1);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].url).toBe('https://vault.example.com/intents/batch');
    expect(captured[0].headers.Authorization).toBe('Bearer tok-123');

    const sent = JSON.parse(captured[0].body);
    expect(sent.accountId).toBe('acct-1');
    expect(sent.events).toHaveLength(1);

    // The row envelope must be CIPHERTEXT, not plaintext.
    const env = decodeRowEnvelope(sent.events[0].envelope);
    expect(env.encrypted).toBe(true);
    expect(env.payload_ciphertext).toBeDefined();
    expect(env).not.toHaveProperty('payload');     // no plaintext payload
    expect(env).not.toHaveProperty('action');      // encrypted envelope hides action too
    // And the secret never appears anywhere in the wire bytes.
    expect(Buffer.from(sent.events[0].envelope, 'base64').toString('utf8')).not.toContain('SECRET-TITLE');
  });

  // (b) NO cached key → held (transient) tagged with the key-not-ready reason,
  //     sends nothing, builds nothing.
  it('(b) with no cached key returns transient (held: key not ready) and sends nothing', async () => {
    const vaultFetch = vi.fn();
    const result = await vaultDeliverer(makeIntent(), {
      connection: CONN, vaultFetch, loadKey: async () => null,
    });
    expect(result).toEqual({ status: TRANSIENT, reason: HELD_NO_KEY_REASON });
    expect(vaultFetch).not.toHaveBeenCalled();
  });

  it('(b2) with no vault connection returns transient and sends nothing', async () => {
    const vaultFetch = vi.fn();
    const result = await vaultDeliverer(makeIntent(), {
      connection: null, vaultFetch, loadKey: async () => 'should-not-be-loaded',
    });
    expect(result).toBe(TRANSIENT);
    expect(vaultFetch).not.toHaveBeenCalled();
  });

  // (c) NEVER produces a plaintext envelope under any condition — including when
  //     the WebDAV-style encryptionEnabled flag is false/absent (vault ignores it).
  it('(c) always encrypts even when encryptionEnabled is false; never plaintext', async () => {
    const captured = [];
    const vaultFetch = async (m, u, h, body) => { captured.push(body); return { status: 200, ok: true, body: '{}' }; };
    const rootKey = await aRootKey(2);

    // encryptionEnabled deliberately false — vault must STILL encrypt.
    const result = await vaultDeliverer(makeIntent(), {
      connection: CONN, config: { ttlMs: 1000, encryptionEnabled: false }, vaultFetch, loadKey: async () => rootKey,
    });
    expect(result).toBe(DELIVERED);
    const env = decodeRowEnvelope(JSON.parse(captured[0]).events[0].envelope);
    expect(env.encrypted).toBe(true);
    expect(env).not.toHaveProperty('payload');
  });

  // Outcome mapping for the vault POST.
  it('maps 5xx → transient, 4xx → permanent, network throw → transient', async () => {
    const rootKey = await aRootKey(3);
    const run = (fetchImpl) => vaultDeliverer(makeIntent(), {
      connection: CONN, config: { ttlMs: 1000 }, vaultFetch: fetchImpl, loadKey: async () => rootKey,
    });

    expect(await run(async () => ({ status: 503, ok: false, body: '' }))).toBe(TRANSIENT);
    expect(await run(async () => ({ status: 429, ok: false, body: '' }))).toBe(TRANSIENT);
    resetVaultDiagnostics(); // the 429 armed the device-wide brake — clear it so the next run reaches the wire
    expect(await run(async () => ({ status: 400, ok: false, body: '' }))).toBe(PERMANENT);
    expect(await run(async () => { throw new TypeError('Failed to fetch'); })).toBe(TRANSIENT);
  });

  it('429 arms the DEVICE-WIDE brake: held transient, and further flush attempts make NO network request until it lifts', async () => {
    const rootKey = await aRootKey(4);
    const limited = vi.fn(async () => ({ status: 429, ok: false, body: '' }));
    const run = () => vaultDeliverer(makeIntent(), {
      connection: CONN, config: { ttlMs: 1000 }, vaultFetch: limited, loadKey: async () => rootKey,
    });

    expect(await run()).toBe(TRANSIENT);
    expect(limited).toHaveBeenCalledTimes(1);
    // Every subsequent flush trigger (emit, mount, focus, interval) used to
    // re-POST against the same saturated window. Under the brake the intent
    // stays held WITHOUT touching the network — the pacing the outbox lacked.
    expect(await run()).toBe(TRANSIENT);
    expect(await run()).toBe(TRANSIENT);
    expect(limited).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. WEBDAV deliverer ───────────────────────────────────────────────────────

describe('webdav deliverer', () => {
  const WEBDAV = { webdavUrl: 'https://dav.example.com', username: 'u', appPassword: 'p' };

  it('(e) success → delivered; 5xx → transient; 4xx → permanent; throw → transient', async () => {
    const run = (writeImpl, config = WEBDAV) =>
      webdavDeliverer(makeIntent(), { config, writeEventFile: writeImpl });

    expect(await run(async () => ({ ok: true, status: 201 }))).toBe(DELIVERED);
    expect(await run(async () => ({ ok: false, status: 502 }))).toBe(TRANSIENT);
    expect(await run(async () => ({ ok: false, status: 400 }))).toBe(PERMANENT);
    expect(await run(async () => { throw new TypeError('Failed to fetch'); })).toBe(TRANSIENT);
  });

  it('(e) not configured → permanent (won\'t self-heal on retry)', async () => {
    const write = vi.fn();
    const result = await webdavDeliverer(makeIntent(), { config: null, writeEventFile: write });
    expect(result).toBe(PERMANENT);
    expect(write).not.toHaveBeenCalled();
  });

  it('preserves WebDAV policy: plaintext when encryptionEnabled is false', async () => {
    let sentEnvelope;
    const write = async (config, envelope) => { sentEnvelope = envelope; return { ok: true, status: 201 }; };
    const result = await webdavDeliverer(makeIntent(), { config: { ...WEBDAV, encryptionEnabled: false }, writeEventFile: write });
    expect(result).toBe(DELIVERED);
    expect(sentEnvelope.encrypted).toBeUndefined();   // plaintext, per existing WebDAV policy
    expect(sentEnvelope.payload).toBeDefined();
  });

  it('preserves WebDAV policy: encrypted when encryptionEnabled and key present', async () => {
    let sentEnvelope;
    const write = async (config, envelope) => { sentEnvelope = envelope; return { ok: true, status: 201 }; };
    const rootKey = await aRootKey(4);
    const result = await webdavDeliverer(makeIntent(), {
      config: { ...WEBDAV, encryptionEnabled: true }, loadWebdavKey: async () => rootKey, writeEventFile: write,
    });
    expect(result).toBe(DELIVERED);
    expect(sentEnvelope.encrypted).toBe(true);
    expect(sentEnvelope).not.toHaveProperty('payload');
  });

  it('writes plaintext whatever the WebDAV encryption flag says: the iCloud poll refuses a sealed envelope', async () => {
    const written = [];
    const write = vi.fn(async (config, envelope) => { written.push(envelope); return true; });
    expect(await icloudDeliverer(makeIntent(), { config: { encryptionEnabled: true }, isAvailable: () => true, writeEventFileICloud: write })).toBe(DELIVERED);
    expect(written[0].encrypted).toBeUndefined();
    expect(written[0]).toMatchObject({ event_id: '20260101T000000Z-aaa111', action: 'notify' });
    expect(JSON.stringify(written[0])).toContain('SECRET-TITLE');
  });
});

// ─── 4. DIRECT ACCESS deliverer (Phase 7) ────────────────────────────────────

describe('direct access deliverer', () => {
  const transport = (available = true) => ({ isAvailable: () => available, isSupported: () => true, isConnected: () => available });
  const base = () => ({ transport: transport(), isEnabled: () => true, encrypts: () => false, config: {}, now: () => Date.now() });

  it('delivers once the file has been read back with the event (publish true), transient otherwise', async () => {
    const published = [];
    const publish = vi.fn(async (t, envelope) => { published.push(envelope); return true; });
    expect(await directAccessDeliverer(makeIntent(), { ...base(), publish })).toBe(DELIVERED);
    expect(published[0]).toMatchObject({ event_id: '20260101T000000Z-aaa111', action: 'notify', emitted_by: 'app.testglance' });
    expect(published[0].encrypted).toBeUndefined();
    expect(await directAccessDeliverer(makeIntent(), { ...base(), publish: async () => false })).toBe(TRANSIENT);
    expect(await directAccessDeliverer(makeIntent(), { ...base(), publish: async () => { throw new Error('fs'); } })).toBe(TRANSIENT);
  });

  it('holds (transient, nothing written) while the opt-in is off or the folder is away', async () => {
    const publish = vi.fn();
    expect(await directAccessDeliverer(makeIntent(), { ...base(), isEnabled: () => false, publish })).toBe(TRANSIENT);
    expect(await directAccessDeliverer(makeIntent(), { ...base(), transport: transport(false), publish })).toBe(TRANSIENT);
    expect(publish).not.toHaveBeenCalled();
  });

  it('encrypts under the key for the salt the event set names when the encrypt switch is on; held without one, never plaintext; the salt rides along', async () => {
    const publish = vi.fn(async () => true);
    const held = await directAccessDeliverer(makeIntent(), { ...base(), encrypts: () => true, resolveKey: async () => ({ salt: 'c2FsdA==', key: null }), publish });
    expect(held).toEqual({ status: TRANSIENT, reason: HELD_NO_KEY_REASON });
    expect(publish).not.toHaveBeenCalled();
    const key = await aRootKey();
    expect(await directAccessDeliverer(makeIntent(), { ...base(), encrypts: () => true, resolveKey: async () => ({ salt: 'c2FsdA==', key }), publish })).toBe(DELIVERED);
    const [, envelope, io] = publish.mock.calls[0];
    expect(envelope.encrypted).toBe(true);
    expect(envelope.event_id).toBe('20260101T000000Z-aaa111');
    expect(JSON.stringify(envelope)).not.toContain('SECRET-TITLE');
    expect(io.salt).toBe('c2FsdA==');
  });

  it('is in the deliverer map under the outbox target name', async () => {
    const { deliverers } = await import('./deliverers.js');
    expect(deliverers.directAccess).toBe(directAccessDeliverer);
  });
});
