// Transport-security hint for the file tier's server URL (WebDAV, Nextcloud).
//
// The vault form BLOCKS public http:// (vaultUrlPolicy.js). The file tier only
// warns: WebDAV over public http:// has always been accepted on desktop and web,
// and refusing to save would break setups that work today. Both cases are named
// plainly, though, because the password travels with every request. The Android
// app refuses public http:// outright (LanHostPolicy.kt), so the warning says so.

import { isLocalOrLanHost } from './vaultUrlPolicy.js';

/**
 * @param {string} rawUrl the server URL as typed
 * @returns {{level: 'warning'|'danger', messageKey: string} | null}
 *   null when there is nothing to say (https://, empty, or not a URL yet).
 */
export function classifyWebdavUrl(rawUrl) {
  const url = (rawUrl || '').trim();
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol.toLowerCase() !== 'http:') return null;
  return isLocalOrLanHost(parsed.hostname)
    ? { level: 'warning', messageKey: 'sync.webdavUrl.insecureLanWarning' }
    : { level: 'danger', messageKey: 'sync.webdavUrl.insecurePublicWarning' };
}
