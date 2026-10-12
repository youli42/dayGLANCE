/**
 * The identity of one sync target: which provider, which server, which account,
 * which folder. Everything a verified read is allowed to authorize is scoped to
 * this string.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 * The engine's "has this device synced before" stamp
 * (`${storageKeyPrefix}-cloud-sync-last-synced`) is global: it says nothing about
 * WHICH server or folder it came from. That makes it useless for two decisions
 * the write guard has to make:
 *
 *   • may this write reuse the ETag of an earlier read?  (same target only)
 *   • is an absent remote file "evicted from a target this device knows", or a
 *     first run against a target it has never seen?     (target-scoped)
 *
 * A wrong answer to the first re-introduces the overwrite; a wrong answer to the
 * second either stalls a fresh folder for the grace window or seeds over a remote
 * that a transport artifact hid. So the target is computed here, once, and
 * compared — never inferred from the global stamp.
 *
 * The password is deliberately NOT part of the key: rotating an app password
 * does not change which file lives on the server, and a read verified before the
 * rotation is still about that file.
 */

/**
 * Normalize one address component: trim, drop trailing slashes. Hosts are
 * case-insensitive and users routinely paste them with a trailing slash.
 */
const normalizeBase = (raw) => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    // Not a parseable URL (a bare host, or something mid-edit): compare the
    // trimmed form rather than throwing — the request will fail on its own.
    return value.replace(/\/+$/, '');
  }
};

/**
 * The folder as the providers join it into the URL
 * (`${base}/${folder}/${filename}`), normalized the same way the app normalizes
 * the Sync Folder setting.
 */
const normalizeFolder = (raw) =>
  String(raw ?? '')
    .split(/[/\\]+/)
    .map((part) => part.trim())
    .filter((part) => part && part !== '.')
    .join('/');

/**
 * @param {object|null|undefined} config  the saved provider config
 *   (`day-planner-cloud-sync-config`)
 * @param {string} folder                 the sync folder actually in use
 * @returns {{key:string, provider:string, base:string, username:string, folder:string}|null}
 *   null when there is no usable provider config — callers treat that as "no
 *   target", which never authorizes a write.
 */
export function resolveSyncTarget(config, folder) {
  const provider = typeof config?.provider === 'string' ? config.provider.trim() : '';
  if (!provider) return null;

  // Koofr is a fixed public host — the user supplies only credentials, so the
  // account field is what distinguishes one target from another.
  const rawBase =
    provider === 'nextcloud' ? config.nextcloudUrl
      : provider === 'webdav' ? config.webdavUrl
        : provider === 'koofr' ? 'https://app.koofr.net'
          : '';

  const base = normalizeBase(rawBase);
  const username = typeof config.username === 'string' ? config.username.trim() : '';
  const normalizedFolder = normalizeFolder(folder);

  // A provider with an address field but no address yet is not a target: it
  // cannot be read or written, and it must not match a previously verified one.
  if (!base && provider !== 'koofr') return null;

  return {
    key: JSON.stringify([provider, base, username, normalizedFolder]),
    provider,
    base,
    username,
    folder: normalizedFolder,
  };
}
