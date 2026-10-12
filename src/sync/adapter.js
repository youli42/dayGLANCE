// dayGLANCE adapter for @glance-apps/sync.
//
// Pins every dayGLANCE-specific engine config (storage prefixes, file names,
// app identity, native bridge wiring) and the two safety validators that
// previously lived inline in App.jsx (the upload guard and the empty-merge apply
// guard). The four data callbacks (buildPayload, buildBackupPayload,
// applyPayload) plus all event callbacks come from App.jsx — they close over
// React state that this module deliberately does not see.
//
// The upload guard has two rules, both of them refusals of a write:
//
//   • an EMPTY payload over a populated localStorage store is a stale-state race
//     that would wipe the remote;
//   • a write with no read behind it for the CURRENT target is the overwrite that
//     shipped: App.jsx's 5-second debounced upload and the header button both
//     reach the provider without reading anything, so after a misconfigured
//     server they replace the remote with this device's copy. See
//     `verifiedWriteGuard.js` and docs/sync-write-verification.md.

import { createSyncEngine } from '@glance-apps/sync';
import { mergeSyncData } from '../mergeSync.js';
import { nativeHttpRequest } from '../native.js';
import { createAbsentRemoteSeedGuard } from './absentRemoteSeedGuard.js';
import {
  createVerifiedWriteGuard,
  installVerifiedWriteGuard,
  targetScopedHasSyncedBefore,
} from './verifiedWriteGuard.js';
import { resolveSyncTarget } from './syncTarget.js';

const isNativeApp =
  typeof window !== 'undefined' &&
  !!window.DayGlanceNative?.httpRequest;

const electronProxyFetch =
  typeof window !== 'undefined' && window.electronAPI?.isElectron
    ? (...args) => window.electronAPI.proxyFetch(...args)
    : null;

const DAYGLANCE_CONFIG = {
  storageKeyPrefix:     'day-planner',
  cryptoDBName:         'dayglance-crypto',
  autoBackupDBName:     'dayglance-auto-backups',
  syncFilename:         'dayglance-sync.json',
  backupFilenamePrefix: 'dayglance-backup-',
  appId:                'dayglance',
  appName:              'dayGLANCE',

  nativeHttpRequest: isNativeApp ? nativeHttpRequest : null,
  electronProxyFetch,
  proxyUrl: import.meta.env.VITE_WEBDAV_PROXY_URL ?? '',

  nativeGetSyncKey:
    isNativeApp && window?.DayGlanceNative?.getSyncKey
      ? () => window.DayGlanceNative.getSyncKey()
      : null,
  nativeStoreSyncKey:
    isNativeApp && window?.DayGlanceNative?.storeSyncKey
      ? (val) => window.DayGlanceNative.storeSyncKey(val)
      : null,
};

// The engine's own keys, derived from the prefix so they cannot drift.
const CONFIG_KEY = `${DAYGLANCE_CONFIG.storageKeyPrefix}-cloud-sync-config`;
const LAST_SYNCED_KEY = `${DAYGLANCE_CONFIG.storageKeyPrefix}-cloud-sync-last-synced`;

/** The saved provider config, or null. The engine reads it the same way. */
const readSyncConfig = () => {
  try {
    const saved = localStorage.getItem(CONFIG_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
};

/**
 * Mirrors App.jsx 4799-4806 pre-extraction, extended by the verified-write rule.
 *
 * The read this device made (or did not make) is consumed for THIS upload
 * whatever the verdict, so a read can never be judged against a later upload it
 * did not precede.
 *
 * @param {object} envelope
 * @param {object} writeGuard  see verifiedWriteGuard.js
 * @param {{block?: (reason: string, code: string) => void}} [report]
 */
const validateUploadPayload = (envelope, writeGuard, report) => {
  const decision = writeGuard.decideWrite();

  const localTaskCount   = JSON.parse(localStorage.getItem('day-planner-tasks')        || '[]').length;
  const localInboxCount  = JSON.parse(localStorage.getItem('day-planner-unscheduled')  || '[]').length;
  const payloadTaskCount = (envelope.data?.tasks?.length || 0) + (envelope.data?.unscheduledTasks?.length || 0);
  if (localTaskCount + localInboxCount > 0 && payloadTaskCount === 0) {
    // This upload will not happen, so its validator plan must not survive to the
    // next one.
    writeGuard.discardWritePlan();
    return {
      valid: false,
      reason: `payload has 0 tasks but localStorage has ${localTaskCount + localInboxCount}`,
    };
  }

  if (!decision.allowed) {
    // Reported, never silent: a refused upload is a quiet non-success inside the
    // engine, and the user's next question is whether anything was written.
    report?.block?.(decision.reason, decision.code);
    return { valid: false, reason: decision.reason };
  }
  return { valid: true };
};

// Mirrors App.jsx 4858-4864 pre-extraction. Refuses to apply an empty merge
// result when local has data unless the remote claimed a real lastModified
// (an intentional "delete everything" propagation, allowEmpty:true).
const validateApplyPayload = async (envelope) => {
  const localTaskCount  = JSON.parse(localStorage.getItem('day-planner-tasks')       || '[]').length;
  const localInboxCount = JSON.parse(localStorage.getItem('day-planner-unscheduled') || '[]').length;
  const remoteTaskCount = (envelope.data?.tasks?.length || 0) + (envelope.data?.unscheduledTasks?.length || 0);
  if (!envelope.lastModified && localTaskCount + localInboxCount > 0 && remoteTaskCount === 0) {
    return {
      valid: false,
      reason: `remote has 0 tasks but local has ${localTaskCount + localInboxCount}`,
    };
  }
  return { valid: true };
};

/**
 * Build the dayGLANCE sync engine.
 *
 * @param {object} callbacks - data + event callbacks from App.jsx
 * @param {() => object|Promise<object>}          callbacks.buildPayload
 * @param {() => object|Promise<object>}          callbacks.buildBackupPayload
 * @param {(data, opts) => void|Promise<void>}    callbacks.applyPayload
 * @param {(status) => void}                      callbacks.onStatusChange
 * @param {(msg, code, isHardStop) => void}       callbacks.onError
 * @param {(iso) => void}                         callbacks.onLastSyncedChange
 * @param {(remoteData, remoteMod, etag) => void} callbacks.onConflict
 * @param {() => void}                            callbacks.onPassphraseRequired
 * @param {() => void}                            callbacks.onFirstSyncReload
 * @param {() => number}                          callbacks.getSyncRetentionDays
 * @param {object} [options]
 * @param {string} [options.appFolderName]        the sync folder in the server
 * @param {Record<string, object>} [options.providers]  transport override, for
 *   tests that script a provider; the engine builds its own when unset
 */
export const createDayGlanceEngine = (callbacks, { appFolderName = 'GLANCE/dayglance', providers: providerOverrides } = {}) => {
  // Which server, account and folder this engine would write to RIGHT NOW. It is
  // recomputed per decision, so a configuration change (or a wrong address the
  // user is about to fix) is never judged with the previous target's knowledge.
  const targetKey = () => resolveSyncTarget(readSyncConfig(), appFolderName)?.key ?? null;

  // One guard per engine: the absence streak belongs to the configured target,
  // and App.jsx rebuilds the engine when the folder changes.
  const absentRemoteSeedGuard = createAbsentRemoteSeedGuard({
    // Target-scoped: "this device synced before" is only evidence about the
    // target it synced. The engine's global stamp is the upgrade fallback.
    hasSyncedBefore: () => targetScopedHasSyncedBefore({ targetKey, legacyLastSyncedKey: LAST_SYNCED_KEY }),
  });

  const verifiedWriteGuard = createVerifiedWriteGuard({
    seedGuard: absentRemoteSeedGuard,
    targetKey,
  });

  const engine = createSyncEngine({
    ...DAYGLANCE_CONFIG,
    appFolderName,
    buildPayload:        callbacks.buildPayload,
    buildBackupPayload:  callbacks.buildBackupPayload,
    applyPayload:        callbacks.applyPayload,
    mergePayloads:       (local, remote) => mergeSyncData(local, remote, callbacks.getSyncRetentionDays()),
    validateUploadPayload: (envelope) => validateUploadPayload(envelope, verifiedWriteGuard, {
      // The engine reports a refused upload as a quiet non-success — status
      // 'idle', nothing surfaced — and App.jsx drops an 'idle' that arrives while
      // the status still reads 'downloading'/'uploading', which would otherwise
      // leave the UI on "syncing…" indefinitely. Move the status off the
      // in-flight pair first; the engine's own 'idle' then lands on top of it.
      block: (reason, code) => {
        callbacks.onStatusChange?.('error');
        callbacks.onError?.(reason, code, false);
      },
    }),
    validateApplyPayload,
    onStatusChange:      callbacks.onStatusChange,
    onError:             callbacks.onError,
    onLastSyncedChange:  (iso) => {
      // The target a cycle succeeded against is what makes "this device has
      // synced before" target-scoped.
      verifiedWriteGuard.recordLastSyncedTarget();
      callbacks.onLastSyncedChange?.(iso);
    },
    onConflict:          callbacks.onConflict,
    onPassphraseRequired: callbacks.onPassphraseRequired,
    onFirstSyncReload:   callbacks.onFirstSyncReload,
    retentionDays:       callbacks.getSyncRetentionDays(),
  });

  // Transport override — a scripted provider injected by tests, the same seam
  // dbEngine.js takes as `callbacks.fetchImpl`. Applied BEFORE the guards are
  // installed so the production path wraps the injected transport too, rather
  // than the test wrapping it on its own and proving nothing. The engine builds
  // its own providers when this is unset, and `engine.providers` IS the map the
  // engine reads (the package returns it by reference).
  if (providerOverrides && engine.providers) Object.assign(engine.providers, providerOverrides);

  // Wraps `download` (absent-remote rule + verified-read record) and `upload`
  // (validator injection) on the map the engine itself reads.
  installVerifiedWriteGuard(engine.providers, verifiedWriteGuard);
  return engine;
};
