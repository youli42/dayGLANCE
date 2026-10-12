import { useCallback } from 'react';
import { dateToString } from '../utils/taskUtils.js';
import { getNextOccurrence } from '../utils/recurrenceEngine.js';
import { shiftDateByMonths } from '../utils/monthGrid.js';
import { shiftWeekStripDate } from '../utils/weekViewDates.js';
import { stepDayView } from '../utils/dayViewColumns.js';

export default function useNavigation({
  visibleDays,
  effectiveViewMode,
  monthViewActive = false,
  weekViewMode = 'strict',
  weekStartDay = 0,
  dayViewMode = 'calendar-day',
  rollingDayPausedOn = null,
  setRollingDayPausedOn = () => {},
  selectedDate,
  setSelectedDate,
  setShowMonthView,
  setShowSpotlight,
  isMobile,
  setMobileActiveTab,
  setTabletActiveTab,
  setInboxProjectFilter,
  setInboxArchivedExpanded,
  setDailyNotesModalDate,
  calendarRef,
}) {
  const changeDate = useCallback((direction) => {
    // MONTH: the chrome's arrows page whole months, keeping the day of the
    // month where it exists (Jan 31 → Feb 28, not Mar 3).
    if (monthViewActive) {
      setSelectedDate(prev => shiftDateByMonths(prev, direction));
      return;
    }
    // WEEK / SCHED: page to the strip adjacent to the one on screen, which a
    // plain seven-day shift misses around a rolling strip (#2045).
    if (effectiveViewMode === 'week' || effectiveViewMode === 'sched') {
      setSelectedDate(prev => shiftWeekStripDate({
        direction, selectedDate: prev, viewMode: effectiveViewMode, weekViewMode, weekStartDay,
      }));
      return;
    }
    // DAY: rolling-24 hides today's earlier hours, so today is two pages
    // (#2045). Both values change together, so this reads the rendered ones.
    if (effectiveViewMode === 'day') {
      const step = stepDayView({ direction, selectedDate, dayViewMode, rollingPausedOn: rollingDayPausedOn });
      setRollingDayPausedOn(step.rollingPausedOn);
      setSelectedDate(step.selectedDate);
      return;
    }
    const stride = effectiveViewMode === 'jobo' ? 1 : visibleDays;
    setSelectedDate(prev => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() + (direction * stride));
      newDate.setHours(12, 0, 0, 0);
      return newDate;
    });
  }, [setSelectedDate, visibleDays, effectiveViewMode, monthViewActive, weekViewMode, weekStartDay,
    dayViewMode, rollingDayPausedOn, setRollingDayPausedOn, selectedDate]);

  const goToToday = useCallback(() => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    setSelectedDate(today);
    setRollingDayPausedOn(null);
  }, [setSelectedDate, setRollingDayPausedOn]);

  const goToDate = useCallback((date) => {
    let newDate;
    if (typeof date === 'string') {
      const [y, m, d] = date.split('-').map(Number);
      newDate = new Date(y, m - 1, d, 12, 0, 0, 0);
    } else {
      newDate = new Date(date);
      newDate.setHours(12, 0, 0, 0);
    }
    setSelectedDate(newDate);
    setShowMonthView(false);
  }, [setSelectedDate, setShowMonthView]);

  const handleSpotlightSelect = useCallback((result) => {
    setShowSpotlight(false);
    const { task, source } = result;

    const scrollAndHighlight = (selector, delay = 300) => {
      setTimeout(() => {
        const el = document.querySelector(selector);
        if (el && calendarRef.current) {
          const container = calendarRef.current;
          const elTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
          const scrollTarget = Math.max(0, elTop - container.clientHeight / 2 + el.offsetHeight / 2);
          container.scrollTo({ top: scrollTarget, behavior: 'smooth' });
          el.classList.add('ring-2', 'ring-blue-400');
          setTimeout(() => el.classList.remove('ring-2', 'ring-blue-400'), 2000);
        }
      }, delay);
    };

    if (source === 'scheduled' || source === 'event') {
      if (isMobile) {
        setMobileActiveTab('timeline');
      }
      goToDate(task.date);
      // Native calendar events are fetched per-date, so the card may not exist
      // until the timeline re-fetches the target day — give it a little longer.
      scrollAndHighlight(`[data-task-id="${task.id}"]`, source === 'event' ? 600 : 300);
    } else if (source === 'inbox') {
      if (isMobile) {
        setMobileActiveTab('inbox');
      } else {
        setTabletActiveTab('inbox');
      }
      // Apply project filter for project tasks; clear it for plain inbox tasks
      setInboxProjectFilter(task.projectId ? [task.projectId] : []);
      scrollAndHighlight(`[data-task-id="${task.id}"]`);
    } else if (source === 'archived') {
      if (isMobile) {
        setMobileActiveTab('inbox');
      } else {
        setTabletActiveTab('inbox');
      }
      setInboxArchivedExpanded(true);
      scrollAndHighlight(`[data-task-id="${task.id}"]`, 500);
    } else if (source === 'recurring') {
      const date = getNextOccurrence(task) || task.recurrence?.startDate || dateToString(new Date());
      if (isMobile) {
        setMobileActiveTab('timeline');
      }
      goToDate(date);
      scrollAndHighlight(`[data-task-id="recurring-${task.id}-${date}"]`);
    } else if (source === 'deleted') {
      scrollAndHighlight(`[data-task-id="bin-${task.id}"]`);
    } else if (source === 'dailynote') {
      // A daily-note hit opens that day's note on top of the day it belongs to.
      if (isMobile) {
        setMobileActiveTab('timeline');
      }
      goToDate(result.date);
      setDailyNotesModalDate?.(result.date);
    }
  }, [setShowSpotlight, isMobile, setMobileActiveTab, setTabletActiveTab, setInboxProjectFilter, setInboxArchivedExpanded, setDailyNotesModalDate, calendarRef, goToDate]);

  return { changeDate, goToToday, goToDate, handleSpotlightSelect };
}
