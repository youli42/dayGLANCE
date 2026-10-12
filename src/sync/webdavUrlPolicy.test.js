import { describe, it, expect } from 'vitest';
import { classifyWebdavUrl } from './webdavUrlPolicy.js';

describe('classifyWebdavUrl', () => {
  it('says nothing for https, empty, or a URL still being typed', () => {
    expect(classifyWebdavUrl('https://dav.example.com')).toBe(null);
    expect(classifyWebdavUrl('https://10.10.10.2:18800/webdav/')).toBe(null);
    expect(classifyWebdavUrl('')).toBe(null);
    expect(classifyWebdavUrl('   ')).toBe(null);
    expect(classifyWebdavUrl('dav.exam')).toBe(null);
  });

  it('warns for http:// on loopback or a LAN address', () => {
    for (const u of ['http://10.10.10.2', 'http://192.168.1.5:8080/dav', 'http://nas.local/', 'http://localhost:8080', 'HTTP://172.16.0.4']) {
      expect(classifyWebdavUrl(u), u).toEqual({ level: 'warning', messageKey: 'sync.webdavUrl.insecureLanWarning' });
    }
  });

  it('flags http:// to a public host as dangerous', () => {
    for (const u of ['http://dav.example.com', 'http://8.8.8.8/dav', 'http://172.32.0.1']) {
      expect(classifyWebdavUrl(u), u).toEqual({ level: 'danger', messageKey: 'sync.webdavUrl.insecurePublicWarning' });
    }
  });
});
