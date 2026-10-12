import { useRef } from 'react';
import { nativeEnterFocusMode, nativeExitFocusMode, triggerHaptic } from '../native.js';
import { dateToString } from '../utils/taskUtils.js';

// Focus entry, phase boundaries and settlement share the timer and ledger hooks.
// Keep legacy accounting frozen at its event boundary while a write is pending.
export default function useFocusOrchestration({
  joboEnabled, focusDoRef,
  showFocusMode, setShowFocusMode,
  focusPhase, setFocusPhase,
  focusTimerSeconds, setFocusTimerSeconds,
  focusCycleCount, setFocusCycleCount,
  focusSessionStart, setFocusSessionStart,
  focusWorkMinutes, setFocusWorkMinutes,
  focusBreakMinutes, setFocusBreakMinutes,
  focusLongBreakMinutes, setFocusLongBreakMinutes,
  focusCompletedTasks, setFocusCompletedTasks,
  setFocusShowStats, focusShowSettings, setFocusShowSettings,
  focusTimerRunning, setFocusTimerRunning,
  focusTaskMinutes, setFocusTaskMinutes,
  focusBlockTasks, setFocusBlockTasks, setFocusLog,
  focusTimerRef, wakeLockSentinel,
  setTasks, computeFocusBlockTasks, getTasksForDate,
  playFocusSound, onboardingProgress, setOnboardingProgress,
}) {
  const focusEndedRef = useRef(false);
  const focusExitBoundaryRef = useRef(null);

  // How many session spans one day keeps for the Day Dial's focus rail.
  // A day cannot hold many real sessions; this only bounds the pathological
  // open-and-close case.
  const FOCUS_SPANS_PER_DAY = 60;

  // `taskId` (optional): the task a request named — the Up Next widget's
  // Focus button (dayglance://startFocus?id=). It joins the session when the
  // block derived from NOW does not already hold it, and is the session on its
  // own when there is no block. Only a string counts: this is also a click
  // handler, and an event is not a task.
  const enterFocusMode = (taskId) => {
    if ((joboEnabled && showFocusMode) || focusDoRef.current?.isPending()) return;
    focusEndedRef.current = false;
    focusExitBoundaryRef.current = null;
    setShowFocusMode(true);
    setFocusShowSettings(true);
    setFocusShowStats(false);
    setFocusPhase('work');
    setFocusTimerSeconds(0);
    setFocusCycleCount(0);
    setFocusSessionStart(null);
    setFocusCompletedTasks(new Set());
    setFocusTimerRunning(false);
    setFocusTaskMinutes({});
    let block = computeFocusBlockTasks();
    if (typeof taskId === 'string' && taskId && !block.some(t => t.id === taskId)) {
      const named = getTasksForDate(new Date()).find(t => t.id === taskId && !t.completed);
      if (named) block = [named, ...block];
    }
    setFocusBlockTasks(block);
    focusDoRef.current?.begin(block);
    setFocusWorkMinutes(25);
    setFocusBreakMinutes(5);
    setFocusLongBreakMinutes(15);
    // Request fullscreen (web fallback; Android uses native immersive mode below)
    try { document.documentElement.requestFullscreen?.(); } catch (e) {}
    // Request wake lock
    (async () => {
      try {
        if (navigator.wakeLock) {
          wakeLockSentinel.current = await navigator.wakeLock.request('screen');
        }
      } catch (e) {}
    })();
    // Android: immersive mode + pause notifications + DND
    nativeEnterFocusMode();
  };

  const startFocusTimer = () => {
    if ((joboEnabled && !focusShowSettings) || focusDoRef.current?.isPending()) return;
    setFocusShowSettings(false);
    setFocusSessionStart(new Date());
    setFocusPhase('work');
    setFocusTimerSeconds(focusWorkMinutes * 60);
    setFocusTimerRunning(true);
    playFocusSound('work');
    triggerHaptic('medium');
    if (!onboardingProgress.hasUsedFocusMode) {
      setOnboardingProgress(prev => ({ ...prev, hasUsedFocusMode: true }));
    }
  };

  // Freeze legacy accounting at the event that used to run it. Do review may
  // complete a task or wait for storage, but cannot change those recipients.
  const captureFocusBoundary = () => ({
    endedAt: new Date(), phase: focusPhase, timerSeconds: focusTimerSeconds, workMinutes: focusWorkMinutes,
    cycleCount: focusCycleCount, taskMinutes: { ...focusTaskMinutes },
    completedTasks: new Set(focusCompletedTasks), blockTasks: focusBlockTasks,
    sessionStart: focusSessionStart,
  });
  const finishExitFocusMode = (showStats = true, completedActionId = null, boundary = captureFocusBoundary()) => {
    if (joboEnabled && focusEndedRef.current) return;
    focusEndedRef.current = joboEnabled;
    focusDoRef.current?.finish();
    setFocusTimerRunning(false);
    if (focusTimerRef.current) {
      clearInterval(focusTimerRef.current);
      focusTimerRef.current = null;
    }
    // Distribute partial work time for current in-progress work cycle
    const minutesCopy = { ...boundary.taskMinutes };
    if (boundary.phase === 'work' && boundary.timerSeconds < boundary.workMinutes * 60) {
      const elapsedMinutes = (boundary.workMinutes * 60 - boundary.timerSeconds) / 60;
      const activeTasks = boundary.blockTasks.filter(t => !t.completed && !boundary.completedTasks.has(t.id));
      if (activeTasks.length > 0) {
        const perTask = elapsedMinutes / activeTasks.length;
        activeTasks.forEach(t => {
          minutesCopy[t.id] = (minutesCopy[t.id] || 0) + perTask;
        });
      }
    }
    if (Object.keys(minutesCopy).length > 0) {
      setTasks(prev => prev.map(t => {
        if (minutesCopy[t.id]) {
          return { ...t, focusMinutes: (t.focusMinutes || 0) + minutesCopy[t.id] };
        }
        return t;
      }));
    }
    // Record session in daily focus log
    if (boundary.sessionStart) {
      const sessionMinutes = Math.round((boundary.endedAt - boundary.sessionStart) / 60000);
      if (sessionMinutes > 0) {
        const sessionDateStr = dateToString(new Date(boundary.sessionStart));
        // WHEN the session ran, not just how long — the Day Dial places it
        // against the block it happened in. Minutes-of-day from the start,
        // with the end left unwrapped past 1440 when a session crosses
        // midnight (the log is keyed by the date the session STARTED).
        const startMin = boundary.sessionStart.getHours() * 60 + boundary.sessionStart.getMinutes();
        const span = { start: startMin, end: startMin + sessionMinutes };
        setFocusLog(prev => {
          const existing = prev[sessionDateStr] || { totalMinutes: 0, sessions: 0, cyclesCompleted: 0, tasksCompleted: 0 };
          const updated = {
            ...existing,
            totalMinutes: existing.totalMinutes + sessionMinutes,
            sessions: existing.sessions + 1,
            cyclesCompleted: existing.cyclesCompleted + boundary.cycleCount,
            tasksCompleted: existing.tasksCompleted + new Set([...boundary.completedTasks, ...(completedActionId != null ? [completedActionId] : [])]).size,
            // Bounded so that repeatedly opening and closing focus mode can't
            // grow one day's entry without limit; the newest are kept, and
            // totalMinutes above stays complete either way.
            spans: [...(existing.spans || []), span].slice(-FOCUS_SPANS_PER_DAY),
          };
          return { ...prev, [sessionDateStr]: updated };
        });
      }
    }
    if (showStats) {
      setFocusShowStats(true);
    } else {
      // Exit fullscreen and release wake lock only when closing entirely
      try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch (e) {}
      try { wakeLockSentinel.current?.release(); wakeLockSentinel.current = null; } catch (e) {}
      // Android: restore system bars + DND + reschedule notifications
      nativeExitFocusMode();
      setShowFocusMode(false);
    }
  };
  const exitFocusMode = (showStats = true) => {
    if (joboEnabled && focusEndedRef.current) { dismissFocusStats(); return; }
    const boundary = focusExitBoundaryRef.current ?? captureFocusBoundary();
    setFocusTimerRunning(false);
    if (focusDoRef.current?.settle(({ completedActionId }) => finishExitFocusMode(showStats, completedActionId, boundary), { exiting: true })) {
      focusExitBoundaryRef.current = boundary;
      return;
    }
    finishExitFocusMode(showStats, null, boundary);
  };

  const dismissFocusStats = () => {
    if (focusDoRef.current?.isPending()) return;
    try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch (e) {}
    try { wakeLockSentinel.current?.release(); wakeLockSentinel.current = null; } catch (e) {}
    // Android: restore system bars + DND + reschedule notifications
    nativeExitFocusMode();
    setFocusShowStats(false);
    setShowFocusMode(false);
  };

  const advanceFocusPhase = () => {
    const boundary = captureFocusBoundary();
    if (focusPhase === 'work') {
      boundary.cycleCount = focusCycleCount + 1;
      boundary.phase = boundary.cycleCount % 4 === 0 ? 'longBreak' : 'shortBreak';
      boundary.timerSeconds = (boundary.phase === 'longBreak' ? focusLongBreakMinutes : focusBreakMinutes) * 60;
      setFocusCycleCount(boundary.cycleCount);
    } else {
      boundary.phase = 'work';
      boundary.timerSeconds = focusWorkMinutes * 60;
    }
    setFocusPhase(boundary.phase);
    setFocusTimerSeconds(boundary.timerSeconds);
    return boundary;
  };

  const skipFocusPhase = () => {
    if (focusDoRef.current?.isPending() || (joboEnabled && focusEndedRef.current)) return;
    const wasRunning = focusTimerRunning;
    if (focusPhase === 'work') {
      setFocusTimerRunning(false);
      const boundary = advanceFocusPhase();
      const next = ({ allCompleted, completedActionId } = {}) => {
        if (allCompleted) {
          finishExitFocusMode(true, completedActionId, { ...boundary, endedAt: new Date() });
          return;
        }
        setFocusTimerRunning(wasRunning);
      };
      if (!focusDoRef.current?.settle(next, { autoRecordSingle: true })) next();
    } else advanceFocusPhase();
  };

  const advanceFocusTimerEnd = () => {
    const boundary = advanceFocusPhase();
    if (focusPhase === 'work') {
      // Keep the original equal split at expiry, before Do attribution or completion.
      const activeTasks = focusBlockTasks.filter(t => !t.completed && !focusCompletedTasks.has(t.id));
      if (activeTasks.length > 0) {
        const perTask = focusWorkMinutes / activeTasks.length;
        activeTasks.forEach(t => {
          boundary.taskMinutes[t.id] = (boundary.taskMinutes[t.id] || 0) + perTask;
        });
        setFocusTaskMinutes(boundary.taskMinutes);
      }
      playFocusSound('break');
    } else playFocusSound('work');
    return boundary;
  };
  const handleFocusTimerEnd = () => {
    if (focusDoRef.current?.isPending() || (joboEnabled && focusEndedRef.current)) return;
    setFocusTimerRunning(false);
    const boundary = advanceFocusTimerEnd();
    const next = ({ allCompleted, completedActionId } = {}) => {
      if (allCompleted) finishExitFocusMode(true, completedActionId, { ...boundary, endedAt: new Date() });
      else setFocusTimerRunning(true);
    };
    if (focusPhase !== 'work' || !focusDoRef.current?.settle(next, { autoRecordSingle: true })) next();
  };

  return { enterFocusMode, startFocusTimer, exitFocusMode, dismissFocusStats, skipFocusPhase, handleFocusTimerEnd };
}
