import { describe, it, expect } from 'vitest';
import { instanceEditChanges, applyRecurringInstanceEdit } from './recurringInstanceEdit.js';
import { recurringTaskInstance } from './expandRecurringTasks.js';
import { getOccurrencesInRange } from './recurrenceEngine.js';

const DATE = '2026-10-14';
const NOW = '2026-10-11T12:00:00.000Z';

const template = (over = {}) => ({
  id: 't1',
  title: 'Standup',
  startTime: '09:00',
  duration: 15,
  isAllDay: false,
  color: 'bg-blue-500',
  recurrence: { type: 'daily', startDate: '2026-10-01' },
  completedDates: [],
  exceptions: {},
  ...over,
});

// The editor's save, as App.jsx normalizes it: the occurrence as shown, plus overrides.
const editOf = (tmpl, over = {}) => {
  const { title, startTime, duration, isAllDay, color, assignedUserSyncIds } = recurringTaskInstance(tmpl, DATE);
  return { title, startTime, duration, isAllDay, color, assignedUserSyncIds, ...over };
};

const save = (tmpl, edit, scope) => applyRecurringInstanceEdit(tmpl, {
  dateStr: DATE, edit, scope, projectId: tmpl.projectId, recurrence: tmpl.recurrence, now: NOW,
});

describe('instanceEditChanges', () => {
  it('reports nothing when the occurrence is saved unchanged', () => {
    const tmpl = template({ exceptions: { [DATE]: { startTime: '10:00' } } });
    expect(instanceEditChanges(tmpl, DATE, editOf(tmpl)).any).toBe(false);
  });

  it('reports only the changed fields', () => {
    const tmpl = template();
    const changes = instanceEditChanges(tmpl, DATE, editOf(tmpl, { color: 'bg-red-500' }));
    expect(changes.fields).toEqual({ color: 'bg-red-500' });
    expect(changes.assignmentChanged).toBe(false);
    expect(changes.any).toBe(true);
  });

  it('does not read the editor default colour as a change for a series with none', () => {
    const tmpl = template({ color: undefined });
    const edit = editOf(tmpl, { color: 'bg-blue-500' });
    expect(instanceEditChanges(tmpl, DATE, edit, { defaultColor: 'bg-blue-500' }).any).toBe(false);
  });

  it('ignores the start time of an occurrence that stays all-day', () => {
    const tmpl = template({ isAllDay: true, startTime: '09:00' });
    expect(instanceEditChanges(tmpl, DATE, editOf(tmpl, { startTime: '00:00' })).any).toBe(false);
  });

  it('compares assignment as a set', () => {
    const tmpl = template({ assignedUserSyncIds: ['a', 'b'] });
    expect(instanceEditChanges(tmpl, DATE, editOf(tmpl, { assignedUserSyncIds: ['b', 'a'] })).any).toBe(false);
    expect(instanceEditChanges(tmpl, DATE, editOf(tmpl, { assignedUserSyncIds: ['a'] })).assignmentChanged).toBe(true);
  });
});

describe('applyRecurringInstanceEdit', () => {
  it("'this' writes the change to that date's exception only", () => {
    const tmpl = template();
    const next = save(tmpl, editOf(tmpl, { color: 'bg-red-500' }), 'this');
    expect(next.color).toBe('bg-blue-500');
    expect(next.exceptions[DATE]).toEqual({ color: 'bg-red-500' });
    expect(recurringTaskInstance(next, DATE).color).toBe('bg-red-500');
    expect(recurringTaskInstance(next, '2026-10-15').color).toBe('bg-blue-500');
    expect(next.lastModified).toBe(NOW);
  });

  it("'all' writes the change to the series, and every occurrence shows it (#2042)", () => {
    const tmpl = template({ exceptions: { '2026-10-20': { color: 'bg-green-500' } } });
    const next = save(tmpl, editOf(tmpl, { color: 'bg-red-500', title: 'Daily sync' }), 'all');
    expect(next.color).toBe('bg-red-500');
    expect(next.title).toBe('Daily sync');
    for (const d of [DATE, '2026-10-15', '2026-10-20']) {
      expect(recurringTaskInstance(next, d)).toMatchObject({ color: 'bg-red-500', title: 'Daily sync' });
    }
  });

  it("'all' leaves fields it did not change on other occurrences' exceptions", () => {
    const tmpl = template({ exceptions: { '2026-10-20': { startTime: '11:00', color: 'bg-green-500' } } });
    const next = save(tmpl, editOf(tmpl, { color: 'bg-red-500' }), 'all');
    expect(next.exceptions['2026-10-20']).toEqual({ startTime: '11:00' });
    expect(recurringTaskInstance(next, '2026-10-20').startTime).toBe('11:00');
  });

  it("'all' keeps an exception's key when clearing empties it", () => {
    const tmpl = template({ exceptions: { '2026-10-20': { color: 'bg-green-500' } } });
    const next = save(tmpl, editOf(tmpl, { color: 'bg-red-500' }), 'all');
    expect(Object.hasOwn(next.exceptions, '2026-10-20')).toBe(true);
    expect(next.exceptions['2026-10-20']).toEqual({});
  });

  it("'all' does not touch deletion and skip markers", () => {
    const tmpl = template({ exceptions: { '2026-10-20': { deleted: true }, '2026-10-21': { skipped: true, title: 'x' } } });
    const next = save(tmpl, editOf(tmpl, { title: 'Daily sync' }), 'all');
    expect(next.exceptions['2026-10-20']).toEqual({ deleted: true });
    expect(next.exceptions['2026-10-21']).toEqual({ skipped: true });
  });

  it("'all' from an occurrence that was moved applies the edited time to the series", () => {
    const tmpl = template({ exceptions: { [DATE]: { startTime: '10:00' } } });
    const next = save(tmpl, editOf(tmpl, { startTime: '08:30' }), 'all');
    expect(next.startTime).toBe('08:30');
    expect(next.exceptions[DATE]).toEqual({});
  });

  it("'all' from a moved occurrence keeps its own time when only the colour changed", () => {
    const tmpl = template({ exceptions: { [DATE]: { startTime: '10:00' } } });
    const next = save(tmpl, editOf(tmpl, { color: 'bg-red-500' }), 'all');
    expect(next.startTime).toBe('09:00');
    expect(next.exceptions[DATE]).toEqual({ startTime: '10:00' });
  });

  it('assignment follows the scope', () => {
    const tmpl = template({ assignedUserSyncIds: ['a'], exceptions: { '2026-10-20': { assignedUserSyncIds: ['c'] } } });
    const one = save(tmpl, editOf(tmpl, { assignedUserSyncIds: ['b'] }), 'this');
    expect(one.assignedUserSyncIds).toEqual(['a']);
    expect(one.exceptions[DATE]).toEqual({ assignedUserSyncIds: ['b'] });

    const all = save(tmpl, editOf(tmpl, { assignedUserSyncIds: ['b'] }), 'all');
    expect(all.assignedUserSyncIds).toEqual(['b']);
    expect(all.exceptions['2026-10-20']).toEqual({});
  });

  it('writes no exception when nothing scoped changed', () => {
    const tmpl = template();
    const next = save(tmpl, editOf(tmpl), 'this');
    expect(next.exceptions).toEqual({});
  });

  it('project and recurrence are series-level whatever the scope', () => {
    const tmpl = template();
    const next = applyRecurringInstanceEdit(tmpl, {
      dateStr: DATE, edit: editOf(tmpl), scope: 'this', projectId: 'p1',
      recurrence: { type: 'weekly', days: [1] }, now: NOW,
    });
    expect(next.projectId).toBe('p1');
    expect(next.recurrence).toEqual({ type: 'weekly', days: [1], startDate: '2026-10-01' });
  });

  it('a template with no start takes the edited date, never the 1st of its month', () => {
    const tmpl = template({ recurrence: { type: 'daily' } });
    const next = save(tmpl, editOf(tmpl), 'this');
    expect(next.recurrence.startDate).toBe(DATE);
  });

  // Yearly and biweekly take part of their pattern from startDate, so a
  // pattern change made here anchors on the edited occurrence (Wed Oct 14).
  const changePattern = (tmpl, recurrence) => applyRecurringInstanceEdit(tmpl, {
    dateStr: DATE, edit: editOf(tmpl), scope: 'this', projectId: tmpl.projectId, recurrence, now: NOW,
  });

  it('changing to yearly recurs on the edited date, not on the start date', () => {
    const next = changePattern(template(), { type: 'yearly' });
    expect(getOccurrencesInRange(next, '2026-01-01', '2027-12-31')).toEqual([DATE, '2027-10-14']);
  });

  it('changing to biweekly keeps the edited occurrence when the start week is off phase', () => {
    const tmpl = template({ recurrence: { type: 'daily', startDate: '2026-10-08' } });
    const next = changePattern(tmpl, { type: 'biweekly', daysOfWeek: [3] });
    expect(getOccurrencesInRange(next, '2026-10-01', '2026-11-30')).toEqual([DATE, '2026-10-28', '2026-11-11', '2026-11-25']);
  });

  it('an ordinary save of a biweekly occurrence leaves the start alone', () => {
    const tmpl = template({ recurrence: { type: 'biweekly', daysOfWeek: [3], startDate: '2026-09-30' } });
    expect(save(tmpl, editOf(tmpl, { title: 'Retro' }), 'this').recurrence.startDate).toBe('2026-09-30');
  });

  it('an ordinary save of a 29 February series\' 1 March occurrence keeps it on its leap day', () => {
    // The engine shows a 29 February yearly series on 1 March in other years.
    const tmpl = template({ recurrence: { type: 'yearly', startDate: '2024-02-29' } });
    const dateStr = '2025-03-01';
    expect(getOccurrencesInRange(tmpl, '2025-01-01', '2025-12-31')).toEqual([dateStr]);
    const { title, startTime, duration, isAllDay, color } = recurringTaskInstance(tmpl, dateStr);
    const next = applyRecurringInstanceEdit(tmpl, {
      dateStr, edit: { title, startTime: '10:00', duration, isAllDay, color }, scope: 'this',
      projectId: tmpl.projectId, recurrence: tmpl.recurrence, now: NOW,
    });
    expect(next.recurrence.startDate).toBe('2024-02-29');
    expect(getOccurrencesInRange(next, '2024-01-01', '2024-12-31')).toEqual(['2024-02-29']);
  });
});
