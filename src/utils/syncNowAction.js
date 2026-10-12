/**
 * What the ambient cloud-sync button does — one place, so the two headers cannot
 * drift apart.
 *
 * ── Why it is a full cycle, not an upload ──────────────────────────────────
 * The button used to call `engine.upload()`: a bare PUT of this device's state
 * with no read and no ETag. One click therefore replaced the remote file with
 * whatever this device held, which is how a device that had never read the remote
 * (a wrong server address, a proxy pointed at the wrong host) destroyed the other
 * devices' data. The settings page's "Sync now" has always been the full cycle
 * (`engine.sync()` = download → merge → upload) and that is what a user pressing a
 * sync button expects: read first, merge, then write.
 *
 * There is deliberately no upload parameter here — the signature is the
 * guarantee. The WebDAV file tier runs the cycle; GLANCEvault keeps its own.
 *
 * @param {object} io
 * @param {boolean} io.webdavOn        the file tier is enabled
 * @param {boolean} io.vaultEnabled    the GLANCEvault DB tier is enabled
 * @param {() => void} [io.cloudSyncDownload]  engine.download() (read → merge → write)
 * @param {() => void} [io.vaultSyncNow]       the vault's own cycle
 */
export function runSyncNow({ webdavOn, vaultEnabled, cloudSyncDownload, vaultSyncNow } = {}) {
  if (webdavOn) cloudSyncDownload?.();
  if (vaultEnabled) vaultSyncNow?.();
}
