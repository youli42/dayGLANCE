import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// #2048: WebDAV on the native shells goes app -> @glance-apps/sync webdavFetch
// -> nativeHttpRequest (src/native.js). nativeHttpRequest is async now, and only
// @glance-apps/sync >= 2.1.2 awaits it; with 2.1.1 every native WebDAV request
// read a Promise as the response. This walks the app's own wiring
// (cloudSyncProviders.js) against an async Android bridge.

describe('WebDAV through the async native bridge', () => {
  let calls;
  let webdavFetch;

  beforeAll(async () => {
    calls = [];
    globalThis.window = {
      location: { hostname: 'appassets.androidplatform.net' },
      DayGlanceNative: {
        httpRequest: () => { throw new Error('the blocking call must not be used'); },
        httpRequestAsync: (id, method, url, headersJson, body) => {
          calls.push({ id, method, url, headers: JSON.parse(headersJson), body });
        },
        supportsAsyncHttp: () => true,
      },
    };
    vi.resetModules();
    ({ webdavFetch } = await import('./cloudSyncProviders.js'));
  });
  afterAll(() => { delete globalThis.window; });

  it('resolves the response the shell delivers, without blocking on the request', async () => {
    const pending = webdavFetch('GET', 'https://dav.example/GLANCE/dayglance/dayglance-sync.json', { 'X-WebDAV-Auth': 'Basic dTpw' });
    // The request went out through the async bridge, mapped the way the
    // package maps it for a native transport.
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://dav.example/GLANCE/dayglance/dayglance-sync.json',
      headers: { Authorization: 'Basic dTpw' },
    });

    window.__dgNativeHttpDone({
      id: calls[0].id,
      result: { status: 200, ok: true, body: '{"data":{}}', headers: { etag: '"v7"' } },
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get('etag')).toBe('"v7"');
    expect(await res.json()).toEqual({ data: {} });
  });
});
