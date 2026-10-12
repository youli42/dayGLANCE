import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeHttpRequest } from './native.js';

// #2048: the native HTTP bridge was synchronous, so the WebView's JS thread
// (input and rendering) waited for every request. nativeHttpRequest must take
// the async path on every shell that has one, and only fall back to the
// blocking call on an Android shell that predates httpRequestAsync.

const OK = { status: 200, ok: true, body: '{"a":1}', headers: { etag: '"e1"' } };

describe('nativeHttpRequest', () => {
  beforeEach(() => {
    globalThis.window = {};
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.window;
    delete globalThis.XMLHttpRequest;
  });

  it('returns null without a native bridge', async () => {
    expect(await nativeHttpRequest('GET', 'https://h/f')).toBe(null);
  });

  describe('Android with httpRequestAsync', () => {
    let calls;
    beforeEach(() => {
      calls = [];
      window.DayGlanceNative = {
        httpRequest: vi.fn(() => { throw new Error('the blocking call must not be used'); }),
        httpRequestAsync: vi.fn((id, method, url, headersJson, body) => {
          calls.push({ id, method, url, headers: JSON.parse(headersJson), body });
        }),
        supportsAsyncHttp: () => true,
      };
    });

    it('does not block: the call returns before the shell answers, then resolves with its result', async () => {
      let settled = false;
      const p = nativeHttpRequest('PUT', 'https://h/f', { 'If-Match': '"e0"' }, 'payload')
        .then((r) => { settled = true; return r; });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: 'PUT', url: 'https://h/f', headers: { 'If-Match': '"e0"' }, body: 'payload' });
      expect(window.DayGlanceNative.httpRequest).not.toHaveBeenCalled();

      // MainActivity delivers the result through evaluateJavascript.
      window.__dgNativeHttpDone({ id: calls[0].id, result: OK });
      expect(await p).toEqual(OK);
    });

    it('routes concurrent results to their own callers by id', async () => {
      const a = nativeHttpRequest('GET', 'https://h/a');
      const b = nativeHttpRequest('GET', 'https://h/b');
      const [ca, cb] = calls;
      expect(ca.id).not.toBe(cb.id);
      window.__dgNativeHttpDone({ id: cb.id, result: { ...OK, body: 'b' } });
      window.__dgNativeHttpDone({ id: ca.id, result: { ...OK, body: 'a' } });
      expect((await a).body).toBe('a');
      expect((await b).body).toBe('b');
    });

    it('ignores a result for an unknown or already-settled id', async () => {
      const p = nativeHttpRequest('GET', 'https://h/f');
      const { id } = calls[0];
      window.__dgNativeHttpDone({ id: 'nope', result: OK });
      window.__dgNativeHttpDone({ id, result: OK });
      expect(() => window.__dgNativeHttpDone({ id, result: { ...OK, body: 'late' } })).not.toThrow();
      expect((await p).body).toBe(OK.body);
    });

    it('resolves null when the result never comes back, instead of hanging', async () => {
      const p = nativeHttpRequest('GET', 'https://h/f');
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(await p).toBe(null);
    });

    it('resolves null when the bridge call itself throws', async () => {
      window.DayGlanceNative.httpRequestAsync = () => { throw new Error('bridge gone'); };
      expect(await nativeHttpRequest('GET', 'https://h/f')).toBe(null);
    });
  });

  it('a shell that has httpRequestAsync but cannot deliver results keeps the blocking call', async () => {
    window.DayGlanceNative = {
      httpRequest: vi.fn(() => JSON.stringify(OK)),
      httpRequestAsync: vi.fn(),
      supportsAsyncHttp: () => false,
    };
    expect(await nativeHttpRequest('GET', 'https://h/f')).toEqual(OK);
    expect(window.DayGlanceNative.httpRequestAsync).not.toHaveBeenCalled();
  });

  it('an older Android shell without httpRequestAsync still uses the blocking call', async () => {
    window.DayGlanceNative = { httpRequest: vi.fn(() => JSON.stringify(OK)) };
    expect(await nativeHttpRequest('GET', 'https://h/f', { A: 'b' })).toEqual(OK);
    expect(window.DayGlanceNative.httpRequest).toHaveBeenCalledWith('GET', 'https://h/f', '{"A":"b"}', '');
  });

  describe('iOS', () => {
    let xhrs;
    beforeEach(() => {
      xhrs = [];
      window.DayGlanceIOS = true;
      // The injected shim's Proxy: every method "exists", and its httpRequest
      // is the synchronous XHR this must not use.
      window.DayGlanceNative = new Proxy({}, {
        get: () => () => { throw new Error('the synchronous shim must not be used'); },
      });
      globalThis.XMLHttpRequest = class {
        open(method, url, async) { Object.assign(this, { method, url, async }); }
        send() { xhrs.push(this); }
      };
    });

    it('makes an asynchronous dgbridge:// call with the shim\'s argument encoding', async () => {
      const p = nativeHttpRequest('GET', 'https://h/f', { A: 'b' }, '');
      expect(xhrs).toHaveLength(1);
      const [x] = xhrs;
      expect(x.async).toBe(true);
      expect(x.url.startsWith('dgbridge://native_httpRequest?args=')).toBe(true);
      const args = JSON.parse(decodeURIComponent(x.url.split('?args=')[1]));
      expect(args).toEqual(['GET', 'https://h/f', '{"A":"b"}', '']);

      x.status = 200;
      x.responseText = JSON.stringify(OK);
      x.onload();
      expect(await p).toEqual(OK);
    });

    it('resolves null when the handler answers with an error status or the XHR fails', async () => {
      const p1 = nativeHttpRequest('GET', 'https://h/1');
      xhrs[0].status = 500; xhrs[0].onload();
      expect(await p1).toBe(null);
      const p2 = nativeHttpRequest('GET', 'https://h/2');
      xhrs[1].onerror();
      expect(await p2).toBe(null);
    });
  });
});
