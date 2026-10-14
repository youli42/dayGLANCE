import { describe, it, expect } from 'vitest';
import {
  defaultSyncProxyConfig,
  parseSyncProxyConfig,
  parseSyncProxySettingsFile,
  proxyRulesFor,
  bypassRulesFor,
  snapshotFor,
  type SyncProxyConfig,
} from './syncProxySettings.js';

// The sync proxy's rules under test: a malformed payload fails CLOSED (the
// caller keeps the previous config), a corrupt settings file yields the
// DISABLED default (never an invented proxy), and the Chromium rules compiled
// from a valid config bracket `<local>` while carrying no credentials.

const valid = (over: Partial<SyncProxyConfig> = {}): SyncProxyConfig => ({
  enabled: true,
  scheme: 'http',
  host: 'proxy.example.com',
  port: 8080,
  username: '',
  password: '',
  bypassRules: [],
  ...over,
});

describe('parseSyncProxyConfig', () => {
  it('accepts a valid http config and normalises the host', () => {
    const parsed = parseSyncProxyConfig({ ...valid(), host: ' Proxy.Example.COM ' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.host).toBe('proxy.example.com');
      expect(parsed.config.enabled).toBe(true);
    }
  });

  it('accepts the three schemes and nothing else', () => {
    for (const scheme of ['http', 'https', 'socks5']) {
      expect(parseSyncProxyConfig(valid({ scheme })).ok).toBe(true);
    }
    expect(parseSyncProxyConfig(valid({ scheme: 'socks4' })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ scheme: 'ftp' })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ scheme: 5 })).ok).toBe(false);
  });

  it('rejects a non-object payload', () => {
    expect(parseSyncProxyConfig(null).ok).toBe(false);
    expect(parseSyncProxyConfig('proxy').ok).toBe(false);
    expect(parseSyncProxyConfig(undefined).ok).toBe(false);
  });

  it('rejects a host that is empty, spaced, or implausibly long', () => {
    expect(parseSyncProxyConfig(valid({ host: '' })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ host: 'proxy example.com' })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ host: 'a'.repeat(254) })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ host: 'a'.repeat(253) })).ok).toBe(true);
  });

  it('rejects ports outside 1-65535, in both number and numeric-string form', () => {
    expect(parseSyncProxyConfig(valid({ port: 0 })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ port: 65536 })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ port: 3.5 })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ port: '8080' })).ok).toBe(true);
    expect(parseSyncProxyConfig(valid({ port: 'eight' })).ok).toBe(false);
  });

  it('tolerates absent credentials but bounds their length', () => {
    const parsed = parseSyncProxyConfig(valid());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.username).toBe('');
      expect(parsed.config.password).toBe('');
    }
    expect(parseSyncProxyConfig(valid({ username: 'u'.repeat(257) })).ok).toBe(true);
  });

  it('validates bypass rules and rejects list-shaped garbage', () => {
    const parsed = parseSyncProxyConfig(valid({ bypassRules: ['192.168.0.0/24', '*.internal'] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.bypassRules).toEqual(['192.168.0.0/24', '*.internal']);
    expect(parseSyncProxyConfig(valid({ bypassRules: '192.168.0.0/24' })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ bypassRules: [''] })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ bypassRules: ['x'.repeat(201)] })).ok).toBe(false);
    expect(parseSyncProxyConfig(valid({ bypassRules: Array(21).fill('a') })).ok).toBe(false);
  });
});

describe('parseSyncProxySettingsFile', () => {
  it('round-trips a written config', () => {
    const config = valid({ username: 'user', password: 'pass', bypassRules: ['10.0.0.0/8'] });
    const parsed = parseSyncProxySettingsFile(JSON.stringify(config));
    expect(parsed).toEqual(config);
  });

  it('yields the DISABLED default for a corrupt file', () => {
    const parsed = parseSyncProxySettingsFile('{ not json');
    expect(parsed).toEqual(defaultSyncProxyConfig());
    expect(parsed.enabled).toBe(false);
  });

  it('yields the DISABLED default for a structurally wrong file', () => {
    expect(parseSyncProxySettingsFile('[]')).toEqual(defaultSyncProxyConfig());
    expect(parseSyncProxySettingsFile(JSON.stringify({ enabled: true }))).toEqual(defaultSyncProxyConfig());
  });
});

describe('proxyRulesFor', () => {
  it('formats each scheme with its port', () => {
    expect(proxyRulesFor(valid())).toBe('http://proxy.example.com:8080');
    expect(proxyRulesFor(valid({ scheme: 'https', port: 443 }))).toBe('https://proxy.example.com:443');
    expect(proxyRulesFor(valid({ scheme: 'socks5', host: 'proxy.example.com', port: 1080 })))
      .toBe('socks5://proxy.example.com:1080');
  });

  it('brackets IPv6 literals, which Chromium requires', () => {
    expect(proxyRulesFor(valid({ host: '::1', port: 8080 }))).toBe('http://[::1]:8080');
  });

  it('never embeds credentials in the rules string', () => {
    const rules = proxyRulesFor(valid({ username: 'user', password: 'pass' }));
    expect(rules).toBe('http://proxy.example.com:8080');
    expect(rules).not.toContain('user');
  });
});

describe('bypassRulesFor', () => {
  it('always brackets <local> first and joins the user rules', () => {
    expect(bypassRulesFor(valid({ bypassRules: ['192.168.0.0/24', '*.internal'] })))
      .toBe('<local>,192.168.0.0/24,*.internal');
    expect(bypassRulesFor(valid())).toBe('<local>');
  });
});

describe('snapshotFor', () => {
  it('exposes active state and reduces credentials to a boolean', () => {
    expect(snapshotFor(valid({ username: 'user', password: 'pass' }))).toEqual({
      active: true,
      scheme: 'http',
      host: 'proxy.example.com',
      port: 8080,
      username: 'user',
      hasCredentials: true,
      bypassRules: [],
    });
  });

  it('echoes the username but never the password', () => {
    const snapshot = snapshotFor(valid({ username: 'user', password: 'hunter2' }));
    // The key names contain "pass" (bypassRules, hasCredentials), so the
    // assertion targets the VALUE: the secret itself and its field.
    expect(snapshot.password).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('hunter2');
    expect(snapshot.username).toBe('user');
  });

  it('copies the bypass rules so a caller cannot mutate the config', () => {
    const config = valid({ bypassRules: ['10.0.0.0/8'] });
    const snapshot = snapshotFor(config);
    snapshot.bypassRules.push('*.evil');
    expect(config.bypassRules).toEqual(['10.0.0.0/8']);
  });
});
