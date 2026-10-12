import { describe, it, expect } from 'vitest';
import useTaskActions from './useTaskActions.js';
import { getOccurrencesInRange, getRecurrencePresets } from '../utils/recurrenceEngine.js';

// updateRecurrencePattern is what EditRecurrenceModal calls when a preset is
// picked from an occurrence. These walk the edit through to the engine, since
// the bug was never in the stored value alone: it was the occurrences the
// engine expanded from it.

// useTaskActions is a plain factory (no React hooks in its body), so it can be
// called directly with a setter that applies the updater to a held list.
const editPattern = (template, dateStr, newRecurrence) => {
  let list = [template];
  const setRecurringTasks = (updater) => { list = updater(list); };
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { updateRecurrencePattern } = useTaskActions({ setRecurringTasks });
  updateRecurrencePattern(template.id, dateStr, newRecurrence);
  return list[0];
};

// The preset the modal offers for that occurrence, picked by its type.
const preset = (dateStr, match) =>
  getRecurrencePresets(dateStr).find(p => p.value && match(p.value)).value;

const dailyFromOct15 = () => ({
  id: 'tpl-1',
  title: 'Stretch',
  startTime: '08:00',
  duration: 15,
  recurrence: { type: 'daily', startDate: '2026-10-15' },
  completedDates: [],
  exceptions: {},
});

describe('updateRecurrencePattern — never earlier than the start, anchored on the edit', () => {
  it('a daily series has no occurrences before it was created', () => {
    expect(getOccurrencesInRange(dailyFromOct15(), '2026-10-01', '2026-10-14')).toEqual([]);
  });

  it('editing to weekly Mon/Wed/Fri from a later occurrence invents nothing before the start', () => {
    const edited = editPattern(dailyFromOct15(), '2026-10-20', { type: 'weekly', daysOfWeek: [1, 3, 5] });

    expect(edited.recurrence.startDate).toBe('2026-10-15');
    expect(getOccurrencesInRange(edited, '2026-10-01', '2026-10-14')).toEqual([]);
    expect(getOccurrencesInRange(edited, '2026-10-01', '2026-10-23'))
      .toEqual(['2026-10-16', '2026-10-19', '2026-10-21', '2026-10-23']);
  });

  it('editing to monthly on a day before the start date skips the start month rather than inventing it', () => {
    // "Monthly on the 5th", picked from Nov 5. Oct 5 is before the series
    // existed: the old snap to Oct 1 put an occurrence there.
    const edited = editPattern(dailyFromOct15(), '2026-11-05', preset('2026-11-05', v => v.type === 'monthly' && v.monthDay));

    expect(edited.recurrence.startDate).toBe('2026-10-15');
    expect(getOccurrencesInRange(edited, '2026-10-01', '2026-12-31')).toEqual(['2026-11-05', '2026-12-05']);
  });

  it('keeps end conditions passed through by the modal', () => {
    const edited = editPattern(dailyFromOct15(), '2026-10-20', { type: 'weekly', daysOfWeek: [2], endDate: '2026-12-31' });
    expect(edited.recurrence).toEqual({ type: 'weekly', daysOfWeek: [2], endDate: '2026-12-31', startDate: '2026-10-15' });
  });

  it('an edit from a date before the start moves the start to that date, not to the 1st', () => {
    const edited = editPattern(dailyFromOct15(), '2026-10-12', { type: 'daily' });

    expect(edited.recurrence.startDate).toBe('2026-10-12');
    expect(getOccurrencesInRange(edited, '2026-10-01', '2026-10-14')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
  });

  it('"Yearly on Oct 20", picked from Oct 20, recurs on Oct 20 and not on the start date', () => {
    const edited = editPattern(dailyFromOct15(), '2026-10-20', preset('2026-10-20', v => v.type === 'yearly'));

    // Moved forward, never back: Oct 15 to 19 were never Oct 20 occurrences.
    expect(edited.recurrence.startDate).toBe('2026-10-20');
    expect(getOccurrencesInRange(edited, '2026-01-01', '2028-12-31'))
      .toEqual(['2026-10-20', '2027-10-20', '2028-10-20']);
  });

  it('"Every 2 weeks on Tuesday", picked from Tue Oct 20, keeps Oct 20', () => {
    const edited = editPattern(dailyFromOct15(), '2026-10-20', preset('2026-10-20', v => v.type === 'biweekly'));

    expect(getOccurrencesInRange(edited, '2026-10-01', '2026-11-30'))
      .toEqual(['2026-10-20', '2026-11-03', '2026-11-17']);
  });

  it('leaves other templates alone', () => {
    let list = [dailyFromOct15(), { ...dailyFromOct15(), id: 'tpl-2' }];
    const setRecurringTasks = (updater) => { list = updater(list); };
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { updateRecurrencePattern } = useTaskActions({ setRecurringTasks });
    const other = list[1];
    updateRecurrencePattern('tpl-1', '2026-10-20', { type: 'weekly', daysOfWeek: [1] });
    expect(list[1]).toBe(other);
  });
});
