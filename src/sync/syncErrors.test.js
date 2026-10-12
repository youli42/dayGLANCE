import { describe, it, expect } from 'vitest';
import { syncErrorText } from './syncErrors.js';

// A fake i18next translator: returns a known string for mapped keys, otherwise
// honours { defaultValue } the way i18next does.
const KNOWN = { 'sync.errors.KEY_MISMATCH': 'Wrong sync passphrase.' };
const t = (key, opts = {}) => KNOWN[key] ?? (opts.defaultValue ?? key);

describe('syncErrorText', () => {
  it('returns null for a null/empty message (the engine "clear error" signal)', () => {
    expect(syncErrorText(t, null, 'NETWORK_ERROR')).toBe(null);
    expect(syncErrorText(t, '', 'NETWORK_ERROR')).toBe(null);
  });

  it('maps a known code to its localized string', () => {
    expect(syncErrorText(t, 'raw decrypt error', 'KEY_MISMATCH')).toBe('Wrong sync passphrase.');
  });

  it('falls back to the engine message when the code has no key', () => {
    expect(syncErrorText(t, 'Server exploded', 'SOME_FUTURE_CODE')).toBe('Server exploded');
  });

  it('returns the raw message when there is no code', () => {
    expect(syncErrorText(t, 'Plain message', null)).toBe('Plain message');
    expect(syncErrorText(t, 'Plain message', undefined)).toBe('Plain message');
  });
});

// The two DB-tier codes @glance-apps/sync 1.9.0/1.10.0 introduced. Wording is
// copied verbatim from what lastGLANCE/lifeGLANCE shipped, with the two
// constraints that shaped it: the quota message gives NO deletion advice
// (deletes leave tombstones and reclaim is an operator action, so no user
// action reduces usage) and points at whoever runs the server; the credential
// message avoids "password"/"passphrase" (the passphrase prompt is the wrong
// fix) and leads with local data being safe rather than with sync stopping.
import en from '../../public/locales/en/translation.json';
import fr from '../../public/locales/fr/translation.json';

describe('locale coverage for the 1.10.0 engine codes', () => {
  const realT = (locale) => (key, opts = {}) => {
    const value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), locale);
    return typeof value === 'string' ? value : (opts.defaultValue ?? key);
  };

  it.each([
    ['QUOTA_EXCEEDED'],
    ['CREDENTIAL_INVALID'],
  ])('%s renders from both locales through syncErrorText', (code) => {
    for (const locale of [en, fr]) {
      const rendered = syncErrorText(realT(locale), 'engine fallback message', code);
      expect(rendered, `missing sync.errors.${code}`).not.toBe('engine fallback message');
      expect(rendered.length).toBeGreaterThan(20);
    }
  });

  it('the quota message contains no deletion advice and points at the operator', () => {
    expect(en.sync.errors.QUOTA_EXCEEDED).not.toMatch(/delete|remove|free up/i);
    expect(en.sync.errors.QUOTA_EXCEEDED).toMatch(/whoever runs your sync server/);
    expect(en.sync.errors.QUOTA_EXCEEDED).toMatch(/saved on this device/);
  });

  it('the credential message avoids passphrase language and reassures first', () => {
    expect(en.sync.errors.CREDENTIAL_INVALID).not.toMatch(/password|passphrase/i);
    expect(en.sync.errors.CREDENTIAL_INVALID).toMatch(/^The sync server no longer accepts/);
    expect(en.sync.errors.CREDENTIAL_INVALID).toMatch(/saved on this device/);
  });
});

// #2035: a code-less cycle error was always reported as NETWORK_ERROR, so a
// local failure (IndexedDB, the apply path) told people to check a connection
// that was fine.
import { cycleErrorCode } from './syncErrors.js';

describe('cycleErrorCode', () => {
  it('keeps a string code the vault client or engine assigned', () => {
    const err = Object.assign(new Error('get row failed: 500'), { code: 'VAULT_ERROR' });
    expect(cycleErrorCode(err, new WeakSet())).toBe('VAULT_ERROR');
  });

  it('reports NETWORK_ERROR only for an error the transport threw', () => {
    const transport = new WeakSet();
    const offline = new TypeError('Failed to fetch');
    transport.add(offline);
    expect(cycleErrorCode(offline, transport)).toBe('NETWORK_ERROR');
    // Re-wrapped by the package with the original on `cause`.
    expect(cycleErrorCode(new Error('verifier: Failed to fetch', { cause: offline }), transport)).toBe('NETWORK_ERROR');
  });

  it('reports SYNC_FAILED for a local failure, not NETWORK_ERROR', () => {
    expect(cycleErrorCode(new TypeError("Cannot read properties of undefined (reading 'id')"), new WeakSet())).toBe('SYNC_FAILED');
    expect(cycleErrorCode('boom', new WeakSet())).toBe('SYNC_FAILED');
    expect(cycleErrorCode(undefined, new WeakSet())).toBe('SYNC_FAILED');
  });

  it("ignores a DOMException's numeric legacy code", () => {
    const quota = { name: 'QuotaExceededError', message: 'quota exceeded', code: 22 };
    expect(cycleErrorCode(quota, new WeakSet())).toBe('SYNC_FAILED');
  });
});

describe('SYNC_FAILED quotes the real message', () => {
  const realT = (bundle) => (key, opts = {}) => {
    const v = key.split('.').reduce((o, k) => o?.[k], bundle);
    return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, k) => opts[k] ?? '') : opts.defaultValue;
  };
  it('interpolates the engine message into the localized string', () => {
    expect(syncErrorText(realT(en), 'snapshot write failed', 'SYNC_FAILED'))
      .toBe("Sync didn't finish: snapshot write failed. It will try again automatically.");
    expect(syncErrorText(realT(fr), 'snapshot write failed', 'SYNC_FAILED')).toContain('snapshot write failed');
  });
});
