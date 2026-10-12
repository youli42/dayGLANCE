// Localize cloud-sync errors.
//
// @glance-apps/sync already delivers BOTH a human-readable English `message`
// AND a structured `code` (SyncErrorCode) to onError(message, code, isHardStop)
// on both the file (WebDAV/iCloud) and DB (GLANCEvault) tiers. So localization is
// a client concern: key the display string off the typed `code`, and fall back
// to the engine's English `message` for any code we don't (yet) have a key for.
//
// Pass the caller's own `t` (from useTranslation) so the string honours the
// active language at the moment the error is rendered.
//
// NOTE: testConnection()/test() return only `{ success, error }` with NO code, so
// the "Test Connection" result is the one sync surface that stays English until
// the package grows a code there — handled at that call site, not here.

/**
 * @param {(key: string, opts?: object) => string} t  i18next translator
 * @param {string|null} message  engine-provided English message (fallback)
 * @param {string|null} [code]   SyncErrorCode, if any
 * @returns {string|null}  localized message, or null when there is no error
 *                          (a null message is the engine's "clear error" signal)
 */
export function syncErrorText(t, message, code) {
  if (!message) return null;
  // `detail` lets a code's string quote the engine's message (SYNC_FAILED does);
  // strings that don't reference it ignore it.
  if (code) return t(`sync.errors.${code}`, { defaultValue: message, detail: message });
  return message;
}

/**
 * The code a failed GLANCEvault cycle reports (#2035).
 *
 * The vault client codes every HTTP failure, so an error with no code either
 * came from the transport (no response at all: offline, DNS, refused, TLS) or
 * from this device (IndexedDB, the apply path, a bug). Only the first is a
 * network error. The old blanket NETWORK_ERROR fallback told people to check a
 * connection that was fine; SYNC_FAILED quotes the real message instead.
 *
 * @param {unknown} err  what the cycle threw
 * @param {WeakSet<object>} transportErrors  errors the transport itself threw
 * @returns {string}
 */
export function cycleErrorCode(err, transportErrors) {
  // A DOMException carries a legacy NUMERIC `code` (QuotaExceededError is 22),
  // which is not one of ours: only a string code is.
  if (err && typeof err.code === 'string' && err.code) return err.code;
  const isTransport = (e) => !!e && typeof e === 'object' && !!transportErrors?.has(e);
  if (isTransport(err) || isTransport(err?.cause)) return 'NETWORK_ERROR';
  return 'SYNC_FAILED';
}
