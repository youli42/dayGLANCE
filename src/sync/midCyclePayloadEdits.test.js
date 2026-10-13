import { describe, it, expect } from 'vitest';
import { mergeMidCyclePayloadEdits } from './midCyclePayloadEdits.js';

// The file-tier cycle reads this device's payload at the head of its merge and
// commits that merge only after the upload (the network window), replacing task
// state wholesale. These cases pin the pass that folds a mid-cycle local edit
// back in, so a completion (above all) is never erased by the cycle it raced.
const task = (id, extra = {}) => ({
  id, title: `task ${id}`, duration: 30, color: 'bg-blue-500', completed: false,
  notes: '', subtasks: [], lastModified: '2026-10-01T10:00:00.000Z', ...extra,
});

describe('mergeMidCyclePayloadEdits', () => {
  it('leaves an untouched cycle alone (same object, no churn)', () => {
    const tasks = [task('a')];
    const data = { tasks, unscheduledTasks: [] };
    const snapshot = { tasks: [task('a')], unscheduledTasks: [] };
    const live = { tasks: [task('a')], unscheduledTasks: [] };
    expect(mergeMidCyclePayloadEdits(data, snapshot, live)).toBe(data);
  });

  it('keeps a completion made while the cycle was uploading', () => {
    // Cycle start: the task is incomplete. The user completes it during the
    // upload; the merged payload (built from the cycle-start copy) says
    // incomplete, and the stamp has NOT advanced (the persist pass ran inside
    // applyEngineData's suppress window) — the exact tie the report hit.
    const snapshot = { tasks: [task('a')], unscheduledTasks: [] };
    const incoming = { tasks: [task('a')], unscheduledTasks: [] };
    const live = {
      tasks: [task('a', { completed: true, completedAt: '2026-10-12T12:00:01+02:00', transitionId: 't1' })],
      unscheduledTasks: [],
    };
    const out = mergeMidCyclePayloadEdits(incoming, snapshot, live);
    expect(out.tasks[0].completed).toBe(true);
    expect(out.tasks[0].completedAt).toBe('2026-10-12T12:00:01+02:00');
    expect(out).not.toBe(incoming);
  });

  it('inbox completions are the same case', () => {
    const snapshot = { tasks: [], unscheduledTasks: [task('i')] };
    const incoming = { tasks: [], unscheduledTasks: [task('i')] };
    const live = { tasks: [], unscheduledTasks: [task('i', { completed: true, completedAt: '2026-10-12T12:00:01Z' })] };
    expect(mergeMidCyclePayloadEdits(incoming, snapshot, live).unscheduledTasks[0].completed).toBe(true);
  });

  it('keeps a strictly newer PULLED row over an older mid-cycle local copy', () => {
    const snapshot = { tasks: [task('a', { title: 'mine', lastModified: '2026-10-01T10:00:00.000Z' })], unscheduledTasks: [] };
    // The cycle pulled a strictly newer copy of the same row from the peer.
    const incoming = { tasks: [task('a', { title: 'theirs', lastModified: '2026-10-11T10:00:00.000Z' })], unscheduledTasks: [] };
    const live = { tasks: [task('a', { title: 'mine, edited mid-cycle', lastModified: '2026-10-01T10:00:00.000Z' })], unscheduledTasks: [] };
    expect(mergeMidCyclePayloadEdits(incoming, snapshot, live).tasks[0].title).toBe('theirs');
  });

  it('appends a task created during the cycle', () => {
    const snapshot = { tasks: [task('a')], unscheduledTasks: [] };
    const incoming = { tasks: [task('a')], unscheduledTasks: [] };
    const live = { tasks: [task('a'), task('new', { lastModified: '2026-10-12T12:00:02.000Z' })], unscheduledTasks: [] };
    const out = mergeMidCyclePayloadEdits(incoming, snapshot, live);
    expect(out.tasks.map((t) => t.id)).toEqual(['a', 'new']);
  });

  it('never resurrects a task the user deleted during the cycle', () => {
    const snapshot = { tasks: [task('a'), task('b')], unscheduledTasks: [] };
    const incoming = { tasks: [task('a'), task('b')], unscheduledTasks: [] };
    const live = { tasks: [task('a')], unscheduledTasks: [] }; // b removed mid-cycle
    expect(mergeMidCyclePayloadEdits(incoming, snapshot, live).tasks.map((t) => t.id)).toEqual(['a']);
  });

  it('honours a cross-list move: dropped from the source, appended to the destination', () => {
    const snapshot = { tasks: [task('a')], unscheduledTasks: [] };
    const incoming = { tasks: [task('a')], unscheduledTasks: [] };
    const live = { tasks: [], unscheduledTasks: [task('a')] };
    const out = mergeMidCyclePayloadEdits(incoming, snapshot, live);
    expect(out.tasks).toEqual([]);
    expect(out.unscheduledTasks.map((t) => t.id)).toEqual(['a']);
  });

  it('writes a changed map/singleton key through from live', () => {
    const snapshot = { tasks: [], unscheduledTasks: [], dailyNotes: { '2026-10-01': { text: 'old' } }, goalsProjectsEnabled: false };
    const incoming = { tasks: [], unscheduledTasks: [], dailyNotes: { '2026-10-01': { text: 'old' } }, goalsProjectsEnabled: false };
    const live = { tasks: [], unscheduledTasks: [], dailyNotes: { '2026-10-01': { text: 'typed mid-cycle' } }, goalsProjectsEnabled: true };
    const out = mergeMidCyclePayloadEdits(incoming, snapshot, live);
    expect(out.dailyNotes['2026-10-01'].text).toBe('typed mid-cycle');
    expect(out.goalsProjectsEnabled).toBe(true);
  });

  it('never adds or drops a top-level key', () => {
    const snapshot = { tasks: [task('a')], unscheduledTasks: [] };
    const incoming = { tasks: [task('a')], unscheduledTasks: [] };
    const live = { tasks: [task('a'), task('new')], unscheduledTasks: [], obsidianCompletionDates: true };
    const out = mergeMidCyclePayloadEdits(incoming, snapshot, live);
    expect('obsidianCompletionDates' in out).toBe(false);
  });

  it('a list with a row that has no id falls back to live wholesale', () => {
    const snapshot = { icsCalendars: [{ id: 'c1', name: 'Work' }] };
    const incoming = { icsCalendars: [{ id: 'c1', name: 'Work' }] };
    const live = { icsCalendars: [{ name: 'no id here' }] };
    expect(mergeMidCyclePayloadEdits(incoming, snapshot, live).icsCalendars).toEqual([{ name: 'no id here' }]);
  });

  it('is a no-op with a missing snapshot or live payload', () => {
    const incoming = { tasks: [task('a')] };
    expect(mergeMidCyclePayloadEdits(incoming, null, { tasks: [] })).toBe(incoming);
    expect(mergeMidCyclePayloadEdits(incoming, { tasks: [] }, null)).toBe(incoming);
  });
});
