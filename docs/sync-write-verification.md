# Verified writes for the file sync tier

A write to the shared sync file may only go out on knowledge this device actually
has. The rules below are load-bearing: each one is the fix for a shipped data-loss
path, and each is covered by a test that fails when the rule is removed.

## What went wrong

The file engine's cycle is download → merge → upload, and the upload is
conditional (it echoes the ETag it just read in `If-Match`). But two writers never
read anything first:

- `App.jsx`'s 5-second debounced "upload on data changes", and
- the header/desktop cloud button, which called `engine.upload()` — an
  unconditional `PUT` with no `If-Match` (`providers.js`, `if (etag)`).

Both therefore replace the whole remote snapshot with this device's local copy.
After a misconfiguration (a wrong server address, a proxy pointed at the wrong
host) the device has never read the remote, so that write lands on top of whatever
the other devices had written and nothing on either side can notice. The absent
remote seed guard (`absentRemoteSeedGuard.js`) closed one of these doors — the
404 branch — and explicitly not the other two.

## The rules

1. **A write must be backed by a read.** `src/sync/verifiedWriteGuard.js` records
   what every provider `download` resolved to, and `validateUploadPayload`
   refuses any upload that has neither a read in this cycle nor a verified read of
   the *current* target. Refusal is not silent: the hold/refusal is reported with
   a code the UI can localize.
   "In this cycle" is timed, in both directions: a read older than
   `CYCLE_READ_TTL_MS` no longer authorizes the cycle's write, and a *stale
   absence* — a cycle that read nothing and then never reached its upload, so
   nothing consumed the observation — cannot authorize a later, unrelated write
   as if it were a seed.
2. **A write that no read backed carries a validator.** When the engine does not
   supply an ETag (the debounced upload, the button), the guard injects the ETag
   of the last verified read of the same target, so the server can refuse a write
   built on stale knowledge. A cycle read that returned no ETag leaves the write
   unconditional — as the engine always did — because refusing it would stop
   syncing on servers that send no ETag.
3. **The target is part of the knowledge.** A target is
   `provider + server + account + folder` (`src/sync/syncTarget.js`). A verified
   read of one target never authorizes a write to another: change the server or
   the folder and the next write is refused until a read of the new target
   succeeds. `App.jsx` also cancels any armed debounce and clears a hard stop left
   by the old target, then reads the new target once.
4. **The absent-remote hold is scoped to the target.** `hasSyncedBefore` is
   "this device synced *this* target", persisted with the verified record
   (`day-planner-cloud-sync-verified-remote`), falling back to the engine's global
   `-cloud-sync-last-synced` stamp only while no target record exists (upgrade
   path). Without this, pointing at a new empty folder produced a false ten-minute
   hold, and switching servers carried a stale absence streak to the new one.
5. **The ambient sync button runs the full cycle.** It calls `download()`, never
   `upload()`: one click must read, merge and then write, not push local state
   over the remote. `src/utils/syncNowAction.js` owns that decision so both
   headers share it and it cannot regress into an upload.
6. **Reported means visible.** The refusal/hold message renders whenever
   `cloudSyncError` is non-null. Gating it on `status === 'error'` hid it, because
   the engine settles the status back to `idle` on the next line.

## Not covered here

- **The Test Connection button is a reachability probe, by design.** The providers
  count 200 *and* 404 as success (`providers.js`: a 404 means the server answered),
  so a green test is not evidence that the sync file exists, nor that the path or
  the folder is the right one. It gates nothing — a write is authorized by the read
  this guard records, never by the test. Working out whether a particular 404 is
  "the server has no such file" or "the configured address/path is wrong" is a
  manual procedure against the target server itself (list the parent folder with
  PROPFIND, read the target's own access log); the app deliberately does not try to
  infer it.
- **`If-None-Match: *` on the seed write.** The right primitive for "create only
  if absent" — the server refuses atomically, with no time window. It needs a seam
  in `@glance-apps/sync` (`provider.upload(config, data, etag)` has no place for
  it); the hosted proxy already forwards the header (`api/webdav-proxy.js`), so
  the change is small but upstream. Until then the seed write stays guarded by the
  timed hold in `absentRemoteSeedGuard.js`.
- **The absence streak is in memory.** It resets on reload, so a genuinely deleted
  remote file only re-seeds inside a session that stays open past the grace
  window. Persisting `missingSince` next to the verified record is the next step.
