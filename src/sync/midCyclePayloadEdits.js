// Fold edits the user made DURING a sync cycle's network window back into the
// payload that cycle is about to apply.
//
// THE HAZARD (file tier / WebDAV): the cycle snapshots this device's payload at
// the head of its merge and then awaits the upload of the merged result before
// committing it (`@glance-apps/sync` engine.js: `buildPayload()` → merge →
// `await upload(...)` → `applyPayload(mergedData)`). `applyPayload` is
// App.jsx's applyEngineData, which REPLACES the task lists. So any edit made in
// the user's hands while that upload is in flight — completing a task above all
// — exists only in live state, is absent from the merged payload, and is
// silently erased when the cycle commits. The user sees the checkbox tick and
// then jump back, and a second click (landing outside the window) sticks.
//
// The GLANCEvault DB tier fixed this same hazard for its own cycle with
// `mergeMidCycleEdits` (sync/commitMerge.js, called from sync/dbEngine.js): the
// commit re-reads live state and folds mid-cycle changes into the mirror before
// committing. The file tier is a package cycle with no such pass, so dayGLANCE
// supplies one at its own seam (sync/adapter.js). The rule is deliberately the
// same one, so the two tiers cannot drift:
//
//   • A key whose live value EQUALS its cycle-start value was untouched
//     mid-cycle → whatever the cycle pulled/merged stands.
//   • A key the live side changed mid-cycle, holding id-keyed rows → per row:
//       – a row created or changed mid-cycle is injected when its live
//         lastModified is at least the incoming copy's (ties prefer LIVE — the
//         user's in-hand edit, never a fabricated stamp);
//       – a row the local side REMOVED mid-cycle is dropped rather than
//         resurrected from the pulled copy;
//       – a row created mid-cycle and absent from the incoming data is appended.
//   • Any other changed key (a map, a scalar, a singleton bundle) → the live
//     value is written through. Device-local keys are local by construction, so
//     writing them through matches what the merge already decided.
//   • A key absent from `incoming` is left absent: this pass never adds or drops
//     a top-level key, so the apply's own rules still govern the payload shape.
//
// FAIL-SAFE DIRECTION: a snapshot that is too old makes MORE keys look changed
// mid-cycle, which resolves toward live. That can only over-preserve the local
// side — never fabricate a remote win and never lose a user edit.
import { canonicalJson } from './snapshotMergeExplain.js';

/** Parse a row's own timestamp; absent/unparseable reads as 0 (the epoch). */
const ts = (value) => {
  if (typeof value !== 'string' || !value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
};

const same = (a, b) => canonicalJson(a) === canonicalJson(b);

const byId = (list) => new Map((list || []).filter((r) => r && r.id !== undefined).map((r) => [String(r.id), r]));

/** A list of id-keyed rows — the shape the per-row rule applies to. */
const isIdKeyedList = (value) =>
  Array.isArray(value) && value.every((r) => r && typeof r === 'object' && r.id !== undefined);

/**
 * Per-row merge for one list that the live side changed mid-cycle.
 * `incoming` is the cycle's merged copy, `snapshot` the cycle-start copy,
 * `live` the current one.
 */
function mergeRowList(incoming, snapshot, live) {
  const snap = byId(snapshot);
  const liveMap = byId(live);
  const out = [];
  let changed = false;

  for (const row of incoming || []) {
    if (!row || row.id === undefined) { out.push(row); continue; }
    const id = String(row.id);
    const now = liveMap.get(id);
    if (!now) {
      // Present at cycle start but gone from live: the local side removed it
      // (delete, or a cross-list move — the destination list carries it, since
      // that list is in `live` too). Resurrecting the pulled copy is the bug.
      if (snap.has(id)) { changed = true; continue; }
      out.push(row); // the merge's own copy of a row this device never had
      continue;
    }
    if (same(now, snap.get(id))) { out.push(row); continue; } // untouched mid-cycle
    // Changed mid-cycle: LWW, ties to live (commitMerge.js's rule).
    if (ts(now.lastModified) >= ts(row.lastModified)) {
      changed = true;
      out.push(now);
    } else {
      out.push(row); // a strictly newer pulled write wins
    }
  }

  // Rows CREATED locally mid-cycle (absent at cycle start, absent from the
  // merged copy): the apply would drop them, so append them.
  for (const [id, row] of liveMap) {
    if (snap.has(id)) continue;                        // not new
    if ((incoming || []).some((r) => r && String(r.id) === id)) continue; // already there
    changed = true;
    out.push(row);
  }
  return { value: out, changed };
}

/**
 * @param {object} incoming  the payload `.data` the cycle is about to apply
 * @param {object} snapshot  the `.data` this cycle built before its network window
 * @param {object} live      the `.data` read from the app now
 * @returns {object} `incoming` with mid-cycle local edits folded in (the same
 *   object when nothing was edited mid-cycle).
 */
export function mergeMidCyclePayloadEdits(incoming, snapshot, live) {
  if (!incoming || !snapshot || !live) return incoming;
  const snapData = snapshot;
  const liveData = live;
  const keys = new Set([...Object.keys(snapData), ...Object.keys(liveData)]);
  let out = incoming;
  let touched = false;

  for (const key of keys) {
    if (!(key in incoming)) continue; // never add/drop a top-level key
    const start = snapData[key];
    const now = liveData[key];
    if (same(now, start)) continue;   // untouched mid-cycle
    const pulled = incoming[key];

    let next;
    if (isIdKeyedList(start) && isIdKeyedList(now) && isIdKeyedList(pulled)) {
      const r = mergeRowList(pulled, start, now);
      next = r.value;
      if (!r.changed) continue;
    } else {
      if (same(now, pulled)) continue; // the merge already carries the live value
      next = now;                      // maps, scalars, singletons: live wins
    }
    if (!touched) { out = { ...incoming }; touched = true; }
    out[key] = next;
  }
  return out;
}
