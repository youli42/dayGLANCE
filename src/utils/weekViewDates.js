// The seven dates the week strip covers.
//
// Extracted from App.jsx because two things need it and they sit ~2400 lines
// apart: the WEEK columns / SCHED date navigation, and the device-calendar
// fetch window (utils/nativeFetchWindow.js), which has to cover every day a
// mounted view renders or events on those days never load.
//
// 'rolling' means today + 6 days, and only while the user is actually looking
// at today — paging to another date falls back to that date's calendar week,
// because a rolling strip anchored anywhere but today is just a confusing
// week. 'strict' is the calendar week containing the selected date, starting
// on weekStartDay.

import { dateToString } from './taskUtils.js';

export const WEEK_VIEW_DAYS = 7;

/** The view modes whose strip is the week; every other mode has none. */
const WEEK_STRIP_MODES = new Set(['week', 'sched']);

const runOfDays = (start, length) => Array.from({ length }, (_, i) => {
  const d = new Date(start);
  d.setDate(d.getDate() + i);
  return d;
});

/**
 * @param opts.viewMode      the effective view mode ('week' and 'sched' have a strip).
 * @param opts.selectedDate  Date the user has navigated to.
 * @param opts.weekViewMode  'rolling' | 'strict'.
 * @param opts.weekStartDay  0 (Sunday) … 6, for the strict week.
 * @param opts.today         Date (local); defaults to now.
 * @returns {Date[]} seven local midnights, or [] when the mode has no strip.
 */
export function weekViewDatesFor({ viewMode, selectedDate, weekViewMode, weekStartDay = 0, today = new Date() }) {
  if (!WEEK_STRIP_MODES.has(viewMode)) return [];
  const base = new Date(selectedDate);
  base.setHours(0, 0, 0, 0);

  if (weekViewMode === 'rolling' && dateToString(base) === dateToString(today)) {
    return runOfDays(base, WEEK_VIEW_DAYS);
  }

  const diff = (base.getDay() - weekStartDay + 7) % 7;
  const weekStart = new Date(base);
  weekStart.setDate(weekStart.getDate() - diff);
  return runOfDays(weekStart, WEEK_VIEW_DAYS);
}

/**
 * The date one week-strip page away from `selectedDate`, for the arrows.
 *
 * Moving the selected date by seven days is right while every strip is a
 * calendar week, but a rolling strip (today + 6) is not aligned to
 * weekStartDay, so paging onto or off it can jump past a whole week: on a
 * Sunday with weeks starting Monday, the rolling strip is Sun–Sat, and today
 * − 7 lands on the last day of the calendar week two weeks back (#2045).
 * The page must show the day just past the current strip's edge; when the
 * seven-day shift does not, select that day instead.
 *
 * @param opts           as weekViewDatesFor, plus
 * @param opts.direction -1 (previous) or 1 (next).
 * @returns {Date} the new selected date, at local noon.
 */
export function shiftWeekStripDate({ direction, selectedDate, today = new Date(), ...opts }) {
  const atNoon = (d) => { const n = new Date(d); n.setHours(12, 0, 0, 0); return n; };
  const current = weekViewDatesFor({ ...opts, selectedDate, today });
  const candidate = atNoon(selectedDate);
  candidate.setDate(candidate.getDate() + direction * WEEK_VIEW_DAYS);
  if (current.length === 0) return candidate;

  const edge = atNoon(direction < 0 ? current[0] : current[current.length - 1]);
  edge.setDate(edge.getDate() + direction);
  const next = weekViewDatesFor({ ...opts, selectedDate: candidate, today });
  return next.some(d => dateToString(d) === dateToString(edge)) ? candidate : edge;
}
