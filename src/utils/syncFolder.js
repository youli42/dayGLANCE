// The WebDAV / Nextcloud / Koofr providers in @glance-apps/sync join the sync
// folder into the URL as `${base}/${folder}/${file}` without normalizing it, so
// a folder typed as "/webdav/GLANCE/dayglance" produced
// "https://host//webdav/GLANCE/dayglance/dayglance-sync.json" (#2037). Some
// servers resolve the doubled slash; others 404 every request and refuse the
// MKCOL, so nothing was ever written.

export const DEFAULT_SYNC_FOLDER = 'GLANCE/dayglance';

/**
 * Strip leading/trailing slashes and empty or "." segments from a sync folder.
 * Backslashes count as separators, for paths pasted from Windows.
 * @param {unknown} raw  the folder as typed or stored
 * @param {string} [fallback]  used when nothing is left
 * @returns {string}
 */
export function normalizeSyncFolder(raw, fallback = DEFAULT_SYNC_FOLDER) {
  if (typeof raw !== 'string') return fallback;
  const parts = raw.split(/[/\\]+/).map((p) => p.trim()).filter((p) => p && p !== '.');
  return parts.length ? parts.join('/') : fallback;
}
