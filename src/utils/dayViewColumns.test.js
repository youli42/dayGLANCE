import { describe, it, expect } from 'vitest';
import { dayViewColumnsFor, stepDayView } from './dayViewColumns.js';
import { dateToString } from './taskUtils.js';

const at = (y, m, d, h = 12) => new Date(y, m, d, h);
// A column as 'YYYY-MM-DD@HH', one per 8-hour block it covers.
const blocks = (cols) => cols.map(c => `${c.dateStr}@${String(c.startHour).padStart(2, '0')}`);

describe('dayViewColumnsFor', () => {
  it('calendar-day: 00 / 08 / 16 of the selected date', () => {
    expect(blocks(dayViewColumnsFor({ selectedDate: at(2026, 9, 11), dayViewMode: 'calendar-day', now: at(2026, 9, 11, 14) })))
      .toEqual(['2026-10-11@00', '2026-10-11@08', '2026-10-11@16']);
  });

  it('rolling-24 on today starts at the current block and crosses midnight', () => {
    expect(blocks(dayViewColumnsFor({ selectedDate: at(2026, 9, 11), dayViewMode: 'rolling-24', now: at(2026, 9, 11, 14) })))
      .toEqual(['2026-10-11@08', '2026-10-11@16', '2026-10-12@00']);
  });

  it('rolling-24 falls back to the calendar day on other dates and while paused for today', () => {
    const now = at(2026, 9, 11, 14);
    expect(blocks(dayViewColumnsFor({ selectedDate: at(2026, 9, 10), dayViewMode: 'rolling-24', now })))
      .toEqual(['2026-10-10@00', '2026-10-10@08', '2026-10-10@16']);
    expect(blocks(dayViewColumnsFor({ selectedDate: at(2026, 9, 11), dayViewMode: 'rolling-24', now, rollingPausedOn: '2026-10-11' })))
      .toEqual(['2026-10-11@00', '2026-10-11@08', '2026-10-11@16']);
  });

  it('a pause left from another day does not apply', () => {
    expect(blocks(dayViewColumnsFor({ selectedDate: at(2026, 9, 11), dayViewMode: 'rolling-24', now: at(2026, 9, 11, 14), rollingPausedOn: '2026-10-10' }))[0])
      .toBe('2026-10-11@08');
  });
});

describe('stepDayView', () => {
  // Walk the arrows from today's live page and collect every block shown.
  const walk = (dayViewMode, now, direction, presses) => {
    let state = { selectedDate: at(now.getFullYear(), now.getMonth(), now.getDate()), rollingPausedOn: null };
    const pages = [blocks(dayViewColumnsFor({ ...state, dayViewMode, now }))];
    for (let i = 0; i < presses; i++) {
      state = stepDayView({ ...state, direction, dayViewMode, now });
      pages.push(blocks(dayViewColumnsFor({ ...state, dayViewMode, now })));
    }
    return pages;
  };

  it('back from rolling today shows today\'s earlier hours before yesterday (#2045)', () => {
    const pages = walk('rolling-24', at(2026, 9, 11, 14), -1, 2);
    expect(pages[1]).toEqual(['2026-10-11@00', '2026-10-11@08', '2026-10-11@16']);
    expect(pages[2]).toEqual(['2026-10-10@00', '2026-10-10@08', '2026-10-10@16']);
  });

  it('forward retraces the same pages', () => {
    const now = at(2026, 9, 11, 14);
    let state = { selectedDate: at(2026, 9, 10), rollingPausedOn: null };
    const pages = [];
    for (let i = 0; i < 3; i++) {
      state = stepDayView({ ...state, direction: 1, dayViewMode: 'rolling-24', now });
      pages.push(blocks(dayViewColumnsFor({ ...state, dayViewMode: 'rolling-24', now })));
    }
    expect(pages).toEqual([
      ['2026-10-11@00', '2026-10-11@08', '2026-10-11@16'],
      ['2026-10-11@08', '2026-10-11@16', '2026-10-12@00'],
      ['2026-10-12@00', '2026-10-12@08', '2026-10-12@16'],
    ]);
  });

  it('no block is ever stepped over, either direction, at any hour', () => {
    for (const dayViewMode of ['rolling-24', 'calendar-day']) {
      for (let hour = 0; hour < 24; hour++) {
        const now = at(2026, 9, 11, hour);
        for (const direction of [-1, 1]) {
          const pages = walk(dayViewMode, now, direction, 4);
          for (let i = 1; i < pages.length; i++) {
            const seen = new Set([...pages[i - 1], ...pages[i]]);
            // Consecutive pages cover a contiguous run of blocks: no gap between them.
            const ordered = [...seen].sort();
            const asHours = ordered.map(b => new Date(`${b.slice(0, 10)}T${b.slice(11)}:00`).getTime());
            for (let j = 1; j < asHours.length; j++) {
              expect(asHours[j] - asHours[j - 1], `${dayViewMode} ${hour}h dir ${direction}: ${ordered}`).toBe(8 * 3600 * 1000);
            }
          }
        }
      }
    }
  });

  it('before 08:00 the rolling page already shows all of today, so back goes straight to yesterday', () => {
    const state = stepDayView({ direction: -1, selectedDate: at(2026, 9, 11), dayViewMode: 'rolling-24', now: at(2026, 9, 11, 6) });
    expect(dateToString(state.selectedDate)).toBe('2026-10-10');
  });

  it('calendar-day steps one day', () => {
    const state = stepDayView({ direction: -1, selectedDate: at(2026, 9, 11), dayViewMode: 'calendar-day', now: at(2026, 9, 11, 14) });
    expect(dateToString(state.selectedDate)).toBe('2026-10-10');
    expect(state.rollingPausedOn).toBeNull();
  });
});
