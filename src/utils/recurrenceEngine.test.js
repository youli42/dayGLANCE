import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import i18next from 'i18next';
import en from '../../public/locales/en/translation.json';
import fr from '../../public/locales/fr/translation.json';
import {
  getOccurrencesInRange,
  getNextOccurrence,
  getRecurrencePresets,
  getSelectedWeekdays,
  toggleRecurrenceDay,
  setRecurrenceFrequency,
  weekdayOrder,
  editedSeriesStart,
} from './recurrenceEngine.js';

// The clock is frozen for the whole file. getNextOccurrence reads "today", and
// a suite that drifts with the calendar ages into failure — which is exactly
// how the sync-wiring tests went red on a Tuesday morning.
const NOW = new Date('2026-08-18T12:00:00');

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

const template = (recurrence, extra = {}) => ({ id: 't', recurrence, exceptions: {}, ...extra });

describe('getOccurrencesInRange', () => {
  it('walks a daily series across the whole window', () => {
    const t = template({ type: 'daily', startDate: '2026-08-01' });
    expect(getOccurrencesInRange(t, '2026-08-10', '2026-08-13'))
      .toEqual(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']);
  });

  it('hits every selected weekday of a multi-day weekly series', () => {
    // Mon/Wed/Fri. This is the shape the picker in #1404 will produce.
    const t = template({ type: 'weekly', daysOfWeek: [1, 3, 5], startDate: '2026-08-03' });
    expect(getOccurrencesInRange(t, '2026-08-03', '2026-08-09'))
      .toEqual(['2026-08-03', '2026-08-05', '2026-08-07']);
  });

  it('skips alternate weeks for biweekly', () => {
    const t = template({ type: 'biweekly', daysOfWeek: [1], startDate: '2026-08-03' });
    expect(getOccurrencesInRange(t, '2026-08-03', '2026-09-01'))
      .toEqual(['2026-08-03', '2026-08-17', '2026-08-31']);
  });

  it('clamps a monthly day-of-month to short months', () => {
    const t = template({ type: 'monthly', monthDay: 31, startDate: '2026-01-31' });
    expect(getOccurrencesInRange(t, '2026-02-01', '2026-02-28')).toEqual(['2026-02-28']);
  });

  it('honours endDate and maxOccurrences', () => {
    const ends = template({ type: 'daily', startDate: '2026-08-10', endDate: '2026-08-12' });
    expect(getOccurrencesInRange(ends, '2026-08-10', '2026-08-20'))
      .toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);

    const capped = template({ type: 'daily', startDate: '2026-08-10', maxOccurrences: 2 });
    expect(getOccurrencesInRange(capped, '2026-08-10', '2026-08-20'))
      .toEqual(['2026-08-10', '2026-08-11']);
  });

  it('omits dates the template marks deleted or skipped, without shifting the rest', () => {
    const t = template(
      { type: 'daily', startDate: '2026-08-10' },
      { exceptions: { '2026-08-11': { deleted: true }, '2026-08-12': { skipped: true } } },
    );
    expect(getOccurrencesInRange(t, '2026-08-10', '2026-08-13'))
      .toEqual(['2026-08-10', '2026-08-13']);
  });

  it('returns nothing for a template with no recurrence', () => {
    expect(getOccurrencesInRange({ id: 'x' }, '2026-08-10', '2026-08-20')).toEqual([]);
  });
});

describe('maxResults', () => {
  // The guarantee the early exit rests on: stopping early must not change WHICH
  // occurrence comes first, only how much work was done to find it.
  const cases = [
    ['daily', { type: 'daily', startDate: '2026-01-01' }],
    ['weekly, one day', { type: 'weekly', daysOfWeek: [3], startDate: '2026-01-01' }],
    ['weekly, three days', { type: 'weekly', daysOfWeek: [1, 3, 5], startDate: '2026-01-01' }],
    ['biweekly', { type: 'biweekly', daysOfWeek: [2], startDate: '2026-01-01' }],
    ['monthly by date', { type: 'monthly', monthDay: 15, startDate: '2026-01-15' }],
    ['monthly by weekday', { type: 'monthly', monthWeekday: { week: 2, day: 1 }, startDate: '2026-01-01' }],
    ['yearly', { type: 'yearly', startDate: '2026-03-01' }],
  ];

  it.each(cases)('%s: capped result is the prefix of the uncapped one', (_name, rec) => {
    const t = template(rec);
    const all = getOccurrencesInRange(t, '2026-08-18', '2028-08-18');
    expect(getOccurrencesInRange(t, '2026-08-18', '2028-08-18', 1)).toEqual(all.slice(0, 1));
    expect(getOccurrencesInRange(t, '2026-08-18', '2028-08-18', 3)).toEqual(all.slice(0, 3));
  });

  it('returns everything available when the cap exceeds the series', () => {
    const t = template({ type: 'daily', startDate: '2026-08-10', endDate: '2026-08-12' });
    expect(getOccurrencesInRange(t, '2026-08-10', '2026-08-20', 99))
      .toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
  });

  it('defaults to unbounded, so existing three-argument callers are unchanged', () => {
    const t = template({ type: 'daily', startDate: '2026-08-10' });
    expect(getOccurrencesInRange(t, '2026-08-10', '2026-08-20')).toHaveLength(11);
  });
});

describe('weekly occurrence limits after fast-forwarding', () => {
  it.each([
    ['weekly', '2026-08-24'],
    ['biweekly', '2026-09-14'],
  ])('%s: does not revive an exhausted series in a later window', (type, rangeStart) => {
    const t = template({ type, startDate: '2026-08-03', daysOfWeek: [1], maxOccurrences: 3 });
    expect(getOccurrencesInRange(t, '2026-08-03', '2026-09-30')).toHaveLength(3);
    expect(getOccurrencesInRange(t, rangeStart, '2026-09-30')).toEqual([]);
  });

  it.each([
    ['weekly', '2026-08-10'],
    ['biweekly', '2026-08-17'],
  ])('%s: counts only eligible weekdays in the first partial week', (type, rangeStart) => {
    const t = template({ type, startDate: '2026-08-05', daysOfWeek: [1, 3, 5], maxOccurrences: 3 });
    expect(getOccurrencesInRange(t, '2026-08-05', '2026-09-30'))
      .toEqual(['2026-08-05', '2026-08-07', rangeStart]);
    expect(getOccurrencesInRange(t, rangeStart, '2026-09-30')).toEqual([rangeStart]);
  });

  it('preserves occurrences when the first week has no eligible weekdays', () => {
    const t = template({ type: 'weekly', startDate: '2026-08-06', daysOfWeek: [1], maxOccurrences: 2 });
    expect(getOccurrencesInRange(t, '2026-08-10', '2026-09-30'))
      .toEqual(['2026-08-10', '2026-08-17']);
  });

  it.each(['deleted', 'skipped'])('still counts a %s occurrence in an earlier week', (exception) => {
    const t = template(
      { type: 'weekly', startDate: '2026-08-03', daysOfWeek: [1], maxOccurrences: 3 },
      { exceptions: { '2026-08-10': { [exception]: true } } },
    );
    expect(getOccurrencesInRange(t, '2026-08-03', '2026-09-30'))
      .toEqual(['2026-08-03', '2026-08-17']);
    expect(getOccurrencesInRange(t, '2026-08-17', '2026-09-30')).toEqual(['2026-08-17']);
  });

  it('honours the limit when the weekday defaults to the start date', () => {
    const t = template({ type: 'weekly', startDate: '2026-08-03', maxOccurrences: 1 });
    expect(getOccurrencesInRange(t, '2026-08-10', '2026-09-30')).toEqual([]);
  });

  it.each([
    ['2026-03-01', '2026-03-22', '2026-03-29'],
    ['2026-10-18', '2026-11-08', '2026-11-15'],
  ])('keeps the limit across the season starting %s', (startDate, rangeStart, rangeEnd) => {
    const t = template({ type: 'weekly', startDate, daysOfWeek: [0], maxOccurrences: 3 });
    expect(getOccurrencesInRange(t, startDate, rangeEnd)).toHaveLength(3);
    expect(getOccurrencesInRange(t, rangeStart, rangeEnd)).toEqual([]);
  });

  it.each(['weekly', 'biweekly'])('%s: has no next occurrence after its limit', (type) => {
    const t = template({ type, startDate: '2026-08-03', daysOfWeek: [1], maxOccurrences: 2 });
    expect(getNextOccurrence(t)).toBeNull();
  });
});

describe('getNextOccurrence', () => {
  it('returns today when the series occurs today', () => {
    expect(getNextOccurrence(template({ type: 'daily', startDate: '2026-01-01' })))
      .toBe('2026-08-18');
  });

  it('skips past a date the template deleted', () => {
    const t = template(
      { type: 'daily', startDate: '2026-01-01' },
      { exceptions: { '2026-08-18': { deleted: true } } },
    );
    expect(getNextOccurrence(t)).toBe('2026-08-19');
  });

  it('is null once the series has ended', () => {
    expect(getNextOccurrence(template({ type: 'daily', startDate: '2026-01-01', endDate: '2026-08-01' })))
      .toBeNull();
    expect(getNextOccurrence(template({ type: 'daily', startDate: '2026-01-01', maxOccurrences: 5 })))
      .toBeNull();
  });

  // The project views treat null as "ended" and hide the series, so a start
  // date beyond the old two-year horizon silently vanished from its project.
  it('finds a series that starts more than two years out', () => {
    expect(getNextOccurrence(template({ type: 'weekly', daysOfWeek: [1], startDate: '2029-06-01' })))
      .toBe('2029-06-04');
  });
});

// 2026-08-19 is a Wednesday (day 3) — the date the picker is editing in these.
const WED = '2026-08-19';

describe('getRecurrencePresets', () => {
  it('passes localized weekday and date values to translated labels', () => {
    const t = (key, values) => {
      if (key === 'recurrence.everyWeekOn') return `每周${values.day}`;
      if (key === 'recurrence.yearlyOn') return `每年${values.date}`;
      return values.defaultValue;
    };
    const presets = getRecurrencePresets(WED, t, 'zh-CN');
    expect(presets[3].label).toBe('每周星期三');
    expect(presets.at(-1).label).toBe('每年8月19日');
  });

  // A month day and an ordinal position are the same word in English and
  // diverge in French, which is why they read two different keys. Driven
  // through the real bundles so a regression in either shows up here.
  describe('ordinals through the shipped bundles', () => {
    const translator = (language, translation) => {
      const instance = i18next.createInstance();
      instance.init({
        lng: language,
        fallbackLng: false,
        resources: { [language]: { translation } },
        initImmediate: false,
        interpolation: { escapeValue: false },
      });
      return instance.t.bind(instance);
    };
    const label = (dateStr, language, bundle, index) =>
      getRecurrencePresets(dateStr, translator(language, bundle), language)[index].label;

    // 2026-08-01 is a Saturday, the 1st of the month and in its first week.
    const FIRST = '2026-08-01';
    // 2026-08-05 is a Wednesday, the 5th and in its first week.
    const FIFTH = '2026-08-05';

    it('keeps English ordinal suffixes on both the day and the position', () => {
      expect(label(FIRST, 'en', en, 5)).toBe('Monthly on the 1st');
      expect(label(FIFTH, 'en', en, 5)).toBe('Monthly on the 5th');
      expect(label(FIFTH, 'en', en, 6)).toBe('Monthly on the 1st Wednesday');
    });

    it('gives French an ordinal first and cardinal days after it', () => {
      expect(label(FIRST, 'fr', fr, 5)).toBe('Tous les mois le 1er');
      expect(label(FIFTH, 'fr', fr, 5)).toBe('Tous les mois le 5');
    });

    it('keeps the French ordinal position ordinal', () => {
      expect(label(FIFTH, 'fr', fr, 6)).toBe('Tous les mois le 1er mercredi');
    });
  });
});

describe('getSelectedWeekdays', () => {
  it('reads an explicit day set, sorted', () => {
    expect(getSelectedWeekdays({ type: 'weekly', daysOfWeek: [5, 1, 3] }, WED)).toEqual([1, 3, 5]);
  });

  it('falls back to the anchor weekday when the set is absent, matching the engine', () => {
    expect(getSelectedWeekdays({ type: 'weekly', startDate: WED }, null)).toEqual([3]);
    expect(getSelectedWeekdays({ type: 'biweekly' }, WED)).toEqual([3]);
  });

  it('is empty for recurrences with no weekday axis', () => {
    for (const rec of [null, { type: 'daily' }, { type: 'monthly', monthDay: 5 }, { type: 'yearly' }]) {
      expect(getSelectedWeekdays(rec, WED)).toEqual([]);
    }
  });

  it('does not mutate the recurrence it reads', () => {
    const rec = { type: 'weekly', daysOfWeek: [5, 1, 3] };
    getSelectedWeekdays(rec, WED);
    expect(rec.daysOfWeek).toEqual([5, 1, 3]);
  });
});

describe('toggleRecurrenceDay', () => {
  it('adds a day, keeping the set sorted', () => {
    expect(toggleRecurrenceDay({ type: 'weekly', daysOfWeek: [1] }, 5, WED))
      .toMatchObject({ type: 'weekly', daysOfWeek: [1, 5] });
  });

  it('removes a day', () => {
    expect(toggleRecurrenceDay({ type: 'weekly', daysOfWeek: [1, 3, 5] }, 3, WED).daysOfWeek)
      .toEqual([1, 5]);
  });

  it('refuses to remove the last day', () => {
    const rec = { type: 'weekly', daysOfWeek: [3] };
    expect(toggleRecurrenceDay(rec, 3, WED)).toBe(rec);
  });

  it('converts a non-weekly recurrence to weekly on that day', () => {
    expect(toggleRecurrenceDay(null, 1, WED)).toMatchObject({ type: 'weekly', daysOfWeek: [1] });
    expect(toggleRecurrenceDay({ type: 'daily' }, 1, WED)).toMatchObject({ type: 'weekly', daysOfWeek: [1] });
  });

  it('stays biweekly when it already was', () => {
    expect(toggleRecurrenceDay({ type: 'biweekly', daysOfWeek: [1] }, 4, WED))
      .toMatchObject({ type: 'biweekly', daysOfWeek: [1, 4] });
  });

  it('keeps end conditions and drops monthly-only fields', () => {
    const out = toggleRecurrenceDay(
      { type: 'monthly', monthDay: 19, monthWeekday: null, endDate: '2027-01-01', maxOccurrences: 12 }, 1, WED);
    expect(out).toMatchObject({ type: 'weekly', daysOfWeek: [1], endDate: '2027-01-01', maxOccurrences: 12 });
    expect(out).not.toHaveProperty('monthDay');
    expect(out).not.toHaveProperty('monthWeekday');
  });

  it('never mutates its input', () => {
    const rec = { type: 'weekly', daysOfWeek: [1] };
    toggleRecurrenceDay(rec, 5, WED);
    expect(rec.daysOfWeek).toEqual([1]);
  });
});

describe('setRecurrenceFrequency', () => {
  it('switches cadence and keeps the days', () => {
    expect(setRecurrenceFrequency({ type: 'weekly', daysOfWeek: [1, 4] }, 'biweekly', WED))
      .toMatchObject({ type: 'biweekly', daysOfWeek: [1, 4] });
  });

  it('seeds from the edited date when there are no days yet', () => {
    expect(setRecurrenceFrequency(null, 'weekly', WED)).toMatchObject({ type: 'weekly', daysOfWeek: [3] });
  });
});

describe('weekdayOrder', () => {
  it('rotates to the user first day of week', () => {
    expect(weekdayOrder(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
});

// The point of the whole feature: what the picker builds must actually fire on
// the days it shows.
describe('a multi-day set the picker can now build', () => {
  it('fires on exactly the chosen days', () => {
    let rec = null;
    for (const dow of [1, 3, 5]) rec = toggleRecurrenceDay(rec, dow, WED);
    const t = template({ ...rec, startDate: '2026-08-17' }); // Monday
    expect(getOccurrencesInRange(t, '2026-08-17', '2026-08-23'))
      .toEqual(['2026-08-17', '2026-08-19', '2026-08-21']);
  });

  it('halves them at biweekly cadence', () => {
    let rec = toggleRecurrenceDay(null, 1, WED);
    rec = toggleRecurrenceDay(rec, 3, WED);
    rec = setRecurrenceFrequency(rec, 'biweekly', WED);
    const t = template({ ...rec, startDate: '2026-08-17' });
    // Mon 17th and Wed 19th fire; the following week is skipped entirely.
    expect(getOccurrencesInRange(t, '2026-08-17', '2026-08-30'))
      .toEqual(['2026-08-17', '2026-08-19']);
  });
});

describe('editedSeriesStart — a pattern edit anchors on the edited occurrence', () => {
  const addDays = (dateStr, n) => {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const expand = (recurrence, startDate, from, to) =>
    getOccurrencesInRange({ recurrence: { ...recurrence, startDate } }, from, to);

  it('keeps the start for patterns that carry their own days', () => {
    for (const rec of [
      { type: 'daily' },
      { type: 'weekly', daysOfWeek: [1, 3, 5] },
      { type: 'monthly', monthDay: 20, monthWeekday: null },
      { type: 'monthly', monthDay: null, monthWeekday: { week: 3, day: 2 } },
    ]) {
      expect(editedSeriesStart(rec, '2026-10-15', '2026-10-20')).toBe('2026-10-15');
    }
  });

  it('starts at the edited date when the edit is made from before the start, or there is no start', () => {
    expect(editedSeriesStart({ type: 'daily' }, '2026-10-15', '2026-10-12')).toBe('2026-10-12');
    expect(editedSeriesStart({ type: 'yearly' }, undefined, '2026-10-12')).toBe('2026-10-12');
  });

  describe('yearly', () => {
    it('recurs on the edited date, not on the start date', () => {
      const start = editedSeriesStart({ type: 'yearly' }, '2026-10-15', '2026-10-20');
      expect(start).toBe('2026-10-20');
      expect(expand({ type: 'yearly' }, start, '2026-01-01', '2028-12-31'))
        .toEqual(['2026-10-20', '2027-10-20', '2028-10-20']);
    });

    it('takes the first year on or after the start, which can be before the edited one', () => {
      // Started Mar 2025, edited from the Feb 10 2027 occurrence: Feb 10 2026
      // is already inside the series.
      expect(editedSeriesStart({ type: 'yearly' }, '2025-03-01', '2027-02-10')).toBe('2026-02-10');
    });

    it('keeps a start that already falls on the edited date', () => {
      expect(editedSeriesStart({ type: 'yearly' }, '2024-10-20', '2026-10-20')).toBe('2024-10-20');
    });

    it('lands a 29 February on a leap year', () => {
      expect(editedSeriesStart({ type: 'yearly' }, '2025-01-01', '2028-02-29')).toBe('2028-02-29');
    });
  });

  describe('biweekly', () => {
    it('keeps the edited occurrence when the start week is off phase', () => {
      // Thu Oct 15 start, edited from Tue Oct 20 to every 2 weeks on Tuesday.
      // Keeping Oct 15 put the phase on Oct 27, skipping Oct 20 itself.
      const rec = { type: 'biweekly', daysOfWeek: [2] };
      const start = editedSeriesStart(rec, '2026-10-15', '2026-10-20');
      expect(start).toBe('2026-10-20');
      expect(expand(rec, start, '2026-10-01', '2026-11-30'))
        .toEqual(['2026-10-20', '2026-11-03', '2026-11-17']);
    });

    it('keeps the start when its week is already in phase', () => {
      expect(editedSeriesStart({ type: 'biweekly', daysOfWeek: [2] }, '2026-10-15', '2026-10-27')).toBe('2026-10-15');
    });

    it('starts on the first selected day of the next week, not on the edited day', () => {
      const rec = { type: 'biweekly', daysOfWeek: [1, 2, 4] };
      expect(editedSeriesStart(rec, '2026-10-15', '2026-10-20')).toBe('2026-10-19');
    });

    it('with no daysOfWeek, starts on the edited weekday, which the engine then falls back to', () => {
      const start = editedSeriesStart({ type: 'biweekly' }, '2026-10-15', '2026-10-20');
      expect(start).toBe('2026-10-20');
      expect(expand({ type: 'biweekly' }, start, '2026-10-01', '2026-11-05')).toEqual(['2026-10-20', '2026-11-03']);
    });
  });

  // The invariant, over many start/edit pairs: the series never starts earlier
  // than it did, always keeps the occurrence the edit was made from, and yields
  // exactly the new pattern anchored on that occurrence from the old start on.
  // The reference set expands from an in-phase anchor well before the start,
  // then drops everything before it.
  it.each([
    ['biweekly', { type: 'biweekly', daysOfWeek: [2] }, (d) => addDays(d, -14 * 60)],
    ['biweekly, several days', { type: 'biweekly', daysOfWeek: [0, 3, 6] }, (d) => addDays(d, -14 * 60)],
    ['yearly', { type: 'yearly' }, (d) => `${Number(d.slice(0, 4)) - 8}${d.slice(4)}`],
  ])('%s: same occurrences as the pattern anchored on the edit, from the old start on', (_label, rec, farAnchor) => {
    const origStarts = ['2026-01-01', '2026-02-26', '2026-03-08', '2026-06-30', '2026-10-15', '2026-11-01'];
    for (const origStart of origStarts) {
      for (let offset = 0; offset < 400; offset += 11) {
        const dateStr = addDays(origStart, offset);
        if (dateStr.endsWith('02-29')) continue;
        // Only an edit made from a day the new pattern itself produces.
        if (rec.daysOfWeek && !rec.daysOfWeek.includes(new Date(dateStr + 'T12:00:00').getDay())) continue;
        const start = editedSeriesStart(rec, origStart, dateStr);
        const to = addDays(dateStr, 800);
        const got = expand(rec, start, '2020-01-01', to);
        const want = expand(rec, farAnchor(dateStr), origStart, to);

        expect(start >= origStart).toBe(true);
        expect(got).toContain(dateStr);
        expect(got).toEqual(want);
      }
    }
  });

  it('counts maxOccurrences from the same first occurrence', () => {
    const rec = { type: 'biweekly', daysOfWeek: [2], maxOccurrences: 3 };
    const start = editedSeriesStart(rec, '2026-10-15', '2026-10-20');
    expect(expand(rec, start, '2026-01-01', '2027-12-31')).toEqual(['2026-10-20', '2026-11-03', '2026-11-17']);
  });
});

// A pattern that already produces the edited occurrence keeps its start. The
// mobile editor passes the unchanged pattern on every save (#2049), so this is
// what keeps an ordinary save from rewriting the series.
describe('editedSeriesStart — an occurrence the pattern already produces keeps the start', () => {
  const addDays = (dateStr, n) => {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  it('keeps a 29 February yearly series on its leap day when a 1 March occurrence is saved', () => {
    const rec = { type: 'yearly', startDate: '2024-02-29' };
    const shown = getOccurrencesInRange({ recurrence: rec }, '2025-01-01', '2025-12-31');
    expect(shown).toEqual(['2025-03-01']);
    expect(editedSeriesStart(rec, '2024-02-29', '2025-03-01')).toBe('2024-02-29');
  });

  it('still anchors a yearly edit on a day the pattern does not produce', () => {
    expect(editedSeriesStart({ type: 'yearly' }, '2026-10-15', '2026-10-20')).toBe('2026-10-20');
  });

  it('saving any real yearly or biweekly occurrence never moves the start', () => {
    const patterns = [
      { type: 'yearly' },
      { type: 'biweekly', daysOfWeek: [2] },
      { type: 'biweekly', daysOfWeek: [1, 3, 5] },
      { type: 'biweekly', daysOfWeek: [0, 6] },
      { type: 'biweekly', daysOfWeek: [] },
    ];
    const moved = [];
    let checked = 0;
    // Every third day across 2023-2024 (all weekday/phase alignments), plus
    // the leap day itself and its neighbours.
    const starts = [];
    for (let i = 0; i < 731; i += 3) starts.push(addDays('2023-01-01', i));
    starts.push('2024-02-28', '2024-02-29', '2024-03-01');
    for (const start of starts) {
      for (const p of patterns) {
        const rec = { ...p, startDate: start };
        for (const occ of getOccurrencesInRange({ recurrence: rec }, start, addDays(start, 3 * 366))) {
          checked++;
          if (editedSeriesStart(rec, start, occ) !== start) moved.push(`${p.type} ${start} @ ${occ}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
    expect(moved).toEqual([]);
  });
});

// Yearly dates come from the start's month and day. Stepping the previous
// occurrence forward carried 29 February's overflow on: 2024-02-29 became
// 2025-03-01 and then stayed on 1 March, leap years included.
describe('getOccurrencesInRange — yearly from a 29 February start', () => {
  const leap = { recurrence: { type: 'yearly', startDate: '2024-02-29' } };

  it('returns to 29 February in every leap year and keeps 1 March in the others', () => {
    expect(getOccurrencesInRange(leap, '2024-01-01', '2033-12-31')).toEqual([
      '2024-02-29', '2025-03-01', '2026-03-01', '2027-03-01',
      '2028-02-29', '2029-03-01', '2030-03-01', '2031-03-01',
      '2032-02-29', '2033-03-01',
    ]);
  });

  it('finds the leap-year occurrence from a range that starts inside that year', () => {
    expect(getOccurrencesInRange(leap, '2028-02-01', '2028-03-31')).toEqual(['2028-02-29']);
  });

  it('counts maxOccurrences and stops at endDate across the leap years', () => {
    const limited = { recurrence: { ...leap.recurrence, maxOccurrences: 5 } };
    expect(getOccurrencesInRange(limited, '2024-01-01', '2040-12-31'))
      .toEqual(['2024-02-29', '2025-03-01', '2026-03-01', '2027-03-01', '2028-02-29']);
    const ended = { recurrence: { ...leap.recurrence, endDate: '2028-02-29' } };
    expect(getOccurrencesInRange(ended, '2024-01-01', '2040-12-31').at(-1)).toBe('2028-02-29');
  });

  it('honours a deleted occurrence on the leap day', () => {
    const t = { ...leap, exceptions: { '2028-02-29': { deleted: true } } };
    expect(getOccurrencesInRange(t, '2028-01-01', '2028-12-31')).toEqual([]);
  });

  it('leaves every other start date on its own month and day, every year', () => {
    const moved = [];
    // Every start in 2023 (no 29 February), over 13 years spanning 2024, 2028
    // and 2032.
    for (let i = 0; i < 365; i++) {
      const d = new Date('2023-01-01T12:00:00');
      d.setDate(d.getDate() + i);
      const start = d.toISOString().slice(0, 10);
      const occ = getOccurrencesInRange({ recurrence: { type: 'yearly', startDate: start } }, start, `${2023 + 12}-12-31`);
      if (occ.length !== 13 || occ.some((o, k) => o !== `${2023 + k}${start.slice(4)}`)) moved.push(start);
    }
    expect(moved).toEqual([]);
  });
});
