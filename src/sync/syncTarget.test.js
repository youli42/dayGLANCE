import { describe, expect, it } from 'vitest';
import { resolveSyncTarget } from './syncTarget.js';

const nextcloud = (over = {}) => ({
  provider: 'nextcloud', nextcloudUrl: 'https://cloud.example.com', username: 'me', appPassword: 'p', ...over,
});
const webdav = (over = {}) => ({
  provider: 'webdav', webdavUrl: 'https://dav.example.com', username: 'me', appPassword: 'p', ...over,
});

describe('resolveSyncTarget', () => {
  it('identifies a target by provider, server, account and folder', () => {
    const t = resolveSyncTarget(nextcloud(), 'GLANCE/dayglance');
    expect(t).toEqual({
      key: JSON.stringify(['nextcloud', 'https://cloud.example.com', 'me', 'GLANCE/dayglance']),
      provider: 'nextcloud',
      base: 'https://cloud.example.com',
      username: 'me',
      folder: 'GLANCE/dayglance',
    });
  });

  it('ignores the trailing slash and surrounding whitespace a user pastes', () => {
    const clean = resolveSyncTarget(nextcloud(), 'GLANCE/dayglance');
    const messy = resolveSyncTarget(
      nextcloud({ nextcloudUrl: '  https://cloud.example.com/  ' }),
      '/GLANCE//dayglance/',
    );
    expect(messy.key).toBe(clean.key);
  });

  it('treats the host case-insensitively but the path case-sensitively', () => {
    expect(resolveSyncTarget(nextcloud({ nextcloudUrl: 'https://CLOUD.example.com' }), 'a').key)
      .toBe(resolveSyncTarget(nextcloud(), 'a').key);
    expect(resolveSyncTarget(nextcloud({ nextcloudUrl: 'https://cloud.example.com/Nextcloud' }), 'a').key)
      .not.toBe(resolveSyncTarget(nextcloud(), 'a').key);
  });

  it('separates targets that differ in folder, account or server', () => {
    const base = resolveSyncTarget(nextcloud(), 'GLANCE/dayglance').key;
    expect(resolveSyncTarget(nextcloud(), 'dayglance').key).not.toBe(base);
    expect(resolveSyncTarget(nextcloud({ username: 'someone-else' }), 'GLANCE/dayglance').key).not.toBe(base);
    expect(resolveSyncTarget(nextcloud({ nextcloudUrl: 'https://other.example.com' }), 'GLANCE/dayglance').key).not.toBe(base);
    expect(resolveSyncTarget(webdav(), 'GLANCE/dayglance').key).not.toBe(base);
  });

  it('leaves the password out: rotating an app password is not a new target', () => {
    expect(resolveSyncTarget(nextcloud({ appPassword: 'rotated' }), 'f').key)
      .toBe(resolveSyncTarget(nextcloud(), 'f').key);
  });

  it('normalizes Windows-style and duplicated folder separators', () => {
    expect(resolveSyncTarget(nextcloud(), 'GLANCE\\dayglance').key)
      .toBe(resolveSyncTarget(nextcloud(), 'GLANCE/dayglance').key);
  });

  it('has no target without a provider or without the provider address', () => {
    expect(resolveSyncTarget(null, 'f')).toBeNull();
    expect(resolveSyncTarget({}, 'f')).toBeNull();
    expect(resolveSyncTarget({ provider: 'nextcloud', username: 'me' }, 'f')).toBeNull();
    expect(resolveSyncTarget(webdav({ webdavUrl: '   ' }), 'f')).toBeNull();
  });

  it('gives Koofr its fixed public host, since the user supplies only credentials', () => {
    const t = resolveSyncTarget({ provider: 'koofr', username: 'me@example.com', appPassword: 'p' }, 'GLANCE/dayglance');
    expect(t.base).toBe('https://app.koofr.net');
    expect(resolveSyncTarget({ provider: 'koofr', username: 'other@example.com' }, 'GLANCE/dayglance').key).not.toBe(t.key);
  });

  it('falls back to a trimmed string for an address that is not a parseable URL', () => {
    const t = resolveSyncTarget(webdav({ webdavUrl: 'dav.example.com/dav/' }), 'f');
    expect(t.base).toBe('dav.example.com/dav');
  });
});
