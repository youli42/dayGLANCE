import { describe, it, expect } from 'vitest';
import { normalizeSyncFolder, DEFAULT_SYNC_FOLDER } from './syncFolder.js';

describe('normalizeSyncFolder (#2037)', () => {
  it('strips the leading slash that produced //webdav/... URLs', () => {
    expect(normalizeSyncFolder('/webdav/GLANCE/dayglance')).toBe('webdav/GLANCE/dayglance');
  });

  it('strips trailing and repeated slashes', () => {
    expect(normalizeSyncFolder('GLANCE/dayglance/')).toBe('GLANCE/dayglance');
    expect(normalizeSyncFolder('GLANCE//dayglance')).toBe('GLANCE/dayglance');
    expect(normalizeSyncFolder('  /GLANCE/ dayglance /  ')).toBe('GLANCE/dayglance');
  });

  it('treats backslashes and "." segments as separators/noise', () => {
    expect(normalizeSyncFolder('GLANCE\\dayglance')).toBe('GLANCE/dayglance');
    expect(normalizeSyncFolder('./GLANCE/./dayglance')).toBe('GLANCE/dayglance');
  });

  it('leaves an already-clean folder untouched', () => {
    expect(normalizeSyncFolder('dayglance')).toBe('dayglance');
    expect(normalizeSyncFolder('GLANCE/dayglance')).toBe('GLANCE/dayglance');
  });

  it('falls back when nothing usable is left', () => {
    expect(normalizeSyncFolder('/')).toBe(DEFAULT_SYNC_FOLDER);
    expect(normalizeSyncFolder('')).toBe(DEFAULT_SYNC_FOLDER);
    expect(normalizeSyncFolder(undefined)).toBe(DEFAULT_SYNC_FOLDER);
  });
});
