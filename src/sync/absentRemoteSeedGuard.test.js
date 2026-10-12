import { describe, expect, it } from 'vitest';
import {
  ABSENT_REMOTE_REASON,
  createAbsentRemoteSeedGuard,
  installAbsentRemoteSeedGuard,
  MISSING_GRACE_MS,
} from './absentRemoteSeedGuard.js';

const T0 = Date.parse('2026-10-11T12:00:00.000Z');

const guard = (hasSyncedBefore = true, now = () => T0) =>
  createAbsentRemoteSeedGuard({ hasSyncedBefore: () => hasSyncedBefore, now });

describe('the file tier seed guard', () => {
  it('allows the write when the read found a file', () => {
    const g = guard();
    g.observeRead({ payload: { tasks: [] }, etag: '"e1"' });
    expect(g.decideUpload()).toEqual({ allowed: true, missingSince: 0, absence: false });
  });

  it('seeds immediately on a device that has never synced', () => {
    const g = guard(false);
    g.observeRead(null);
    expect(g.decideUpload()).toEqual({ allowed: true, missingSince: 0, absence: true });
  });

  it('holds the first absent read on a device that has synced before, and starts the clock', () => {
    const g = guard();
    g.observeRead(null);
    const decision = g.decideUpload();
    expect(decision.allowed).toBe(false);
    expect(decision.absence).toBe(true);
    expect(decision.reason).toBe(ABSENT_REMOTE_REASON);
    expect(g.state().missingSince).toBe(T0);
  });

  it('measures the whole streak, so cycles inside the window do not push the deadline out', () => {
    let now = T0;
    const g = createAbsentRemoteSeedGuard({ hasSyncedBefore: () => true, now: () => now });
    g.observeRead(null);
    g.decideUpload();
    now = T0 + 60_000;
    g.observeRead(null);
    expect(g.decideUpload().allowed).toBe(false);
    expect(g.state().missingSince).toBe(T0);
  });

  it('seeds once the absence outlasts the window, and clears the streak', () => {
    let now = T0;
    const g = createAbsentRemoteSeedGuard({ hasSyncedBefore: () => true, now: () => now });
    g.observeRead(null);
    g.decideUpload();
    now = T0 + MISSING_GRACE_MS;
    g.observeRead(null);
    expect(g.decideUpload()).toEqual({ allowed: true, missingSince: 0, absence: true });
    // The next absence starts its own window rather than inheriting this one.
    g.observeRead(null);
    expect(g.decideUpload().allowed).toBe(false);
    expect(g.state().missingSince).toBe(now);
  });

  it('a real read ends the streak, so a later absence starts its own window', () => {
    let now = T0;
    const g = createAbsentRemoteSeedGuard({ hasSyncedBefore: () => true, now: () => now });
    g.observeRead(null);
    g.decideUpload();
    now = T0 + MISSING_GRACE_MS - 1;
    g.observeRead({ payload: { tasks: [] } }); // the file is back
    expect(g.state().missingSince).toBe(0);
    now = T0 + MISSING_GRACE_MS + 1;
    g.observeRead(null);
    expect(g.decideUpload().allowed).toBe(false);
  });

  it('is one-shot: an upload no read preceded is never judged by an earlier absence', () => {
    // App.jsx's "sync now" and both conflict-dialog branches call
    // engine.upload() with no read of their own. The first decision consumes the
    // observation, so the second — the manual one — is allowed.
    const g = guard();
    g.observeRead(null);
    expect(g.decideUpload().allowed).toBe(false);
    expect(g.decideUpload().allowed).toBe(true);
    expect(g.state().absencePending).toBe(false);
  });

  it("uses the engine's own falsy test for \"absent\"", () => {
    for (const falsy of [null, undefined]) {
      const g = guard();
      g.observeRead(falsy);
      expect(g.state().absencePending, String(falsy)).toBe(true);
    }
    const g = guard();
    g.observeRead({ payload: { tasks: [] } });
    expect(g.state().absencePending).toBe(false);
  });
});

describe('installAbsentRemoteSeedGuard', () => {
  it('observes a read and passes the resolved value through', async () => {
    const provider = {
      name: 'generic',
      getFileUrl: () => 'https://dav.example.com/GLANCE/dayglance/x.json',
      async download() { return { url: this.getFileUrl() }; },
    };
    const g = guard();
    installAbsentRemoteSeedGuard({ webdav: provider }, g);
    // `this` survives the wrapper: the providers call this.getFileUrl(...).
    expect(await provider.download({})).toEqual({ url: 'https://dav.example.com/GLANCE/dayglance/x.json' });
    expect(g.state().absencePending).toBe(false);
  });

  it('observes an absent read', async () => {
    const provider = { async download() { return null; } };
    const g = guard();
    installAbsentRemoteSeedGuard({ webdav: provider }, g);
    await provider.download({});
    expect(g.state().absencePending).toBe(true);
  });

  it('is idempotent, and skips providers without a download', () => {
    const provider = { async download() { return null; } };
    const banner = { name: 'not-a-provider' };
    const g = guard();
    installAbsentRemoteSeedGuard({ webdav: provider, banner }, g);
    const once = provider.download;
    installAbsentRemoteSeedGuard({ webdav: provider, banner }, g);
    expect(provider.download).toBe(once);
    expect(banner.download).toBeUndefined();
  });

  it('tolerates a missing providers map', () => {
    expect(() => installAbsentRemoteSeedGuard(undefined, guard())).not.toThrow();
  });
});
