// The three 8-hour columns DAY draws, and how its arrows step through them.
//
// 'calendar-day': fixed 00-08 / 08-16 / 16-24 for selectedDate.
// 'rolling-24': leftmost column is the current 8-hour block; columns that
// cross midnight carry the next calendar day's date. It only applies while
// the user is looking at today, and not while it is paused for today.
//
// A rolling page starts at the current block, so once 08:00 has passed the
// earlier hours of today are on no page if the arrows step whole days: Back
// goes straight to yesterday (#2045). Paging therefore passes through today
// twice, as two pages in sequence:
//
//   yesterday ← today (calendar day, rolling paused) ← today (rolling) ← tomorrow
//
// `rollingPausedOn` is the date string the pause applies to, so a pause left
// over from an earlier day lapses on its own.

import { dateToString } from './taskUtils.js';

const BLOCK_HOURS = 8;

const atNoon = (d) => { const n = new Date(d); n.setHours(12, 0, 0, 0); return n; };
const currentBlockStart = (now) => Math.floor(now.getHours() / BLOCK_HOURS) * BLOCK_HOURS;

/** Whether the rolling-24 layout is the one on screen. */
export function isRollingDayActive({ selectedDate, dayViewMode, rollingPausedOn = null, now = new Date() }) {
  const todayStr = dateToString(now);
  return dayViewMode === 'rolling-24'
    && dateToString(selectedDate) === todayStr
    && rollingPausedOn !== todayStr;
}

/**
 * @returns {{ startHour: number, endHour: number, date: Date, dateStr: string }[]}
 */
export function dayViewColumnsFor({ selectedDate, dayViewMode, rollingPausedOn = null, now = new Date() }) {
  const base = new Date(selectedDate);
  base.setHours(0, 0, 0, 0);
  const nextDay = new Date(base);
  nextDay.setDate(nextDay.getDate() + 1);
  const baseStr = dateToString(base);
  const nextStr = dateToString(nextDay);

  if (isRollingDayActive({ selectedDate, dayViewMode, rollingPausedOn, now })) {
    const blockStart = currentBlockStart(now);
    return [0, 1, 2].map(i => {
      const absStart = blockStart + i * BLOCK_HOURS;
      const crossesMidnight = absStart >= 24;
      const startHour = absStart % 24;
      const endHour = startHour + BLOCK_HOURS;
      const date = crossesMidnight ? nextDay : base;
      const dateStr = crossesMidnight ? nextStr : baseStr;
      return { startHour, endHour, date, dateStr };
    });
  }
  return [0, 1, 2].map(i => ({
    startHour: i * BLOCK_HOURS, endHour: (i + 1) * BLOCK_HOURS, date: base, dateStr: baseStr,
  }));
}

/**
 * One arrow press in DAY.
 *
 * @param opts.direction -1 (back) or 1 (forward).
 * @returns {{ selectedDate: Date, rollingPausedOn: string | null }}
 */
export function stepDayView({ direction, selectedDate, dayViewMode, rollingPausedOn = null, now = new Date() }) {
  const todayStr = dateToString(now);
  // Before 08:00 the rolling page starts at midnight, so it already shows
  // every hour of today and needs no second page.
  const splitsToday = dayViewMode === 'rolling-24' && currentBlockStart(now) > 0;
  const onToday = dateToString(selectedDate) === todayStr;

  if (splitsToday && onToday) {
    const rolling = rollingPausedOn !== todayStr;
    if (direction < 0 && rolling) return { selectedDate: atNoon(selectedDate), rollingPausedOn: todayStr };
    if (direction > 0 && !rolling) return { selectedDate: atNoon(selectedDate), rollingPausedOn: null };
  }

  const next = atNoon(selectedDate);
  next.setDate(next.getDate() + direction);
  // Arriving on today from yesterday shows the calendar day first, so its
  // earliest hours are not stepped over; arriving from tomorrow shows rolling.
  const pause = splitsToday && direction > 0 && dateToString(next) === todayStr;
  return { selectedDate: next, rollingPausedOn: pause ? todayStr : null };
}
