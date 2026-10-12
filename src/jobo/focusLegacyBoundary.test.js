import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFocusSession } from './focusSession.js';

// Run the real orchestration hook with stable ref slots and render-local state.
// Timer transitions and ledger writes use the real Focus session controller.
let refSlots, refCursor;
vi.mock('react', () => ({
  useRef: initial => refSlots[refCursor++] ??= { current: initial },
}));
vi.mock('../native.js', () => ({
  nativeEnterFocusMode: vi.fn(), nativeExitFocusMode: vi.fn(), triggerHaptic: vi.fn(),
}));
const { default: renderFocusOrchestration } = await import('../hooks/useFocusOrchestration.js');
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const start = Date.parse('2026-10-09T09:00:00Z');
const NativeDate = Date;
function setup(ids = ['a'], enabled = true) {
  let now = start, review = null, scope;
  const refs = [];
  vi.setSystemTime(now);
  class ClockDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const d = { Date: ClockDate, joboEnabled: enabled, showFocusMode: true, focusShowSettings: false, focusShowStats: false,
    focusEndedRef: { current: false }, focusExitBoundaryRef: { current: null }, focusPhase: 'work', focusTimerRunning: true,
    focusTimerSeconds: 1500, focusWorkMinutes: 25, focusBreakMinutes: 5, focusLongBreakMinutes: 15,
    focusCycleCount: 0, focusSessionStart: new ClockDate(), focusCompletedTasks: new Set(), focusTaskMinutes: {}, focusLog: {},
    focusTimerRef: { current: null }, wakeLockSentinel: { current: null }, FOCUS_SPANS_PER_DAY: 60,
    clearInterval() {}, playFocusSound() {}, triggerHaptic() {}, nativeExitFocusMode() {}, nativeEnterFocusMode() {},
    document: { documentElement: {} }, navigator: {}, onboardingProgress: { hasUsedFocusMode: true },
    dateToString: date => date.toISOString().slice(0, 10),
  };
  vi.stubGlobal('document', d.document);
  vi.stubGlobal('navigator', d.navigator);
  d.tasks = ids.map(id => ({ id, title: id, date: '2026-10-09', startTime: '09:00', duration: 60, completed: false, focusMinutes: 0 }));
  d.focusBlockTasks = d.tasks;
  d.computeFocusBlockTasks = d.getTasksForDate = () => d.tasks;
  for (const key of ['Tasks', 'FocusBlockTasks', 'ShowFocusMode', 'FocusShowSettings', 'FocusShowStats', 'FocusSessionStart', 'FocusCompletedTasks', 'FocusTaskMinutes', 'FocusLog', 'FocusTimerSeconds', 'FocusCycleCount', 'FocusWorkMinutes', 'FocusBreakMinutes', 'FocusLongBreakMinutes']) {
    const field = key[0].toLowerCase() + key.slice(1);
    d[`set${key}`] = value => { d[field] = typeof value === 'function' ? value(d[field]) : value; };
  }
  const complete = id => {
    d.tasks = d.tasks.map(task => task.id === id ? { ...task, completed: true } : task);
    d.focusCompletedTasks = new Set([...d.focusCompletedTasks, id]);
    return { allCompleted: d.focusBlockTasks.every(task => task.completed || d.focusCompletedTasks.has(task.id)), completedActionId: id };
  };
  const records = [];
  const state = { enabled, loaded: true, writable: true, records, resolveBlock: block => block, complete,
    recordJobo: async rows => { records.push(...rows); return { ok: true }; } };
  const session = createFocusSession({ getState: () => state, publish: value => { review = value; }, makeId: () => 's', now: () => now });
  d.focusDoRef = { current: session };
  for (const [field, setter] of [['phase', 'setFocusPhase'], ['running', 'setFocusTimerRunning']]) {
    d[setter] = value => {
      const before = { phase: d.focusPhase, running: d.focusTimerRunning }, after = { ...before, [field]: value };
      if (session.transition({ before, after, at: now }) !== false) d[field === 'phase' ? 'focusPhase' : 'focusTimerRunning'] = value;
    };
  }
  function render() {
    refSlots = refs; refCursor = 0;
    scope = renderFocusOrchestration({ ...d });
  }
  session.begin(d.focusBlockTasks);
  session.transition({ before: { phase: 'work', running: false }, after: { phase: 'work', running: true }, at: now });
  render();
  return { d, state, session, records, complete, review: () => review,
    at(minutes, seconds = 0) { now = start + minutes * 60000 + seconds * 1000; vi.setSystemTime(now); },
    call(name, ...args) { render(); return scope[name](...args); },
  };
}
const log = h => h.d.focusLog['2026-10-09'];
describe('Focus settlement preserves the legacy event boundary', () => {
  it('credits a naturally finished cycle before review completes the remaining task', async () => {
    const h = setup(['a', 'b']); h.complete('b'); h.at(25); h.d.focusTimerSeconds = 0; h.call('handleFocusTimerEnd');
    h.at(30); await h.session.save('a', true);
    expect(h.d.tasks[0].focusMinutes).toBe(25);
    expect(h.d.focusTaskMinutes).toEqual({ a: 25 });
    expect(h.d.focusCycleCount).toBe(1);
    expect(log(h)).toMatchObject({ totalMinutes: 30, cyclesCompleted: 1, tasksCompleted: 2 });
  });
  it('retains the old equal split when the new review completes one of two tasks', async () => {
    const h = setup(['a', 'b']); h.at(25); h.d.focusTimerSeconds = 0; h.call('handleFocusTimerEnd');
    expect(h.d.focusTaskMinutes).toEqual({ a: 12.5, b: 12.5 });
    await h.session.save('b', true);
    expect(h.d.focusTaskMinutes).toEqual({ a: 12.5, b: 12.5 });
    expect(h.d.focusPhase).toBe('shortBreak'); expect(h.d.focusTimerRunning).toBe(true);
  });
  it.each([false, true])('freezes early-exit time and recipients before review (complete=%s)', async completed => {
    const h = setup(); h.at(10); h.d.focusTimerSeconds = 900; h.call('exitFocusMode');
    h.at(15); await h.session.save('a', completed);
    expect(h.d.tasks[0].focusMinutes).toBe(10);
    expect(log(h)).toMatchObject({ totalMinutes: 10, cyclesCompleted: 0, spans: [{ start: 540, end: 550 }] });
  });
  it('retains paused-exit legacy countdown minutes and wall-time log', async () => {
    const h = setup(); h.at(8); h.d.focusTimerSeconds = 1020; h.d.setFocusTimerRunning(false);
    h.at(10); h.call('exitFocusMode'); h.at(15); await h.session.save('a', false);
    expect(h.d.tasks[0].focusMinutes).toBe(8); expect(log(h).totalMinutes).toBe(10);
  });
  it('keeps the old skip cycle without inventing legacy focusMinutes', async () => {
    const h = setup(['a', 'b']); h.complete('b'); h.at(10); h.d.focusTimerSeconds = 900; h.call('skipFocusPhase');
    h.at(15); await h.session.save('a', true);
    expect(h.d.tasks[0].focusMinutes).toBe(0); expect(h.d.focusCycleCount).toBe(1);
    expect(log(h)).toMatchObject({ totalMinutes: 15, cyclesCompleted: 1 });
  });
  it('a native exit during phase review uses that boundary without double credit', async () => {
    const h = setup(['a', 'b']); h.at(25); h.d.focusTimerSeconds = 0; h.call('handleFocusTimerEnd');
    h.at(27); h.call('exitFocusMode', false); h.at(30); await h.session.save('a', true);
    expect(h.d.tasks[0].focusMinutes).toBe(12.5); expect(log(h)).toMatchObject({ totalMinutes: 27, sessions: 1, cyclesCompleted: 1 });
    expect(h.d.showFocusMode).toBe(false);
  });
  it('freezes the work duration when repeated native Stop follows a duration change', async () => {
    const h = setup(); h.at(10); h.d.focusTimerSeconds = 900; h.call('exitFocusMode');
    h.at(12); h.d.focusWorkMinutes = 30; h.call('exitFocusMode', false);
    h.at(15); await h.session.save('a', false);
    expect(h.d.tasks[0].focusMinutes).toBe(10);
    expect(log(h)).toMatchObject({ totalMinutes: 10, sessions: 1 });
  });
  it('does not rewrite the old work-in-progress completion-before-exit allocation', () => {
    const h = setup(); h.at(10); h.d.focusTimerSeconds = 900; h.complete('a');
    h.d.focusBlockTasks = h.d.tasks; h.state.enabled = false; h.call('exitFocusMode');
    expect(h.d.tasks[0].focusMinutes).toBe(0);
  });
  it('JOBO off keeps natural expiry, early exit, skip and repeat start semantics', () => {
    const expiry = setup(['a', 'b'], false); expiry.at(25); expiry.d.focusTimerSeconds = 0; expiry.call('handleFocusTimerEnd');
    expect(expiry.d.focusTaskMinutes).toEqual({ a: 12.5, b: 12.5 }); expect(expiry.d.focusCycleCount).toBe(1); expect(expiry.review()).toBeNull();
    const exit = setup(['a'], false); exit.at(10); exit.d.focusTimerSeconds = 900; exit.call('exitFocusMode');
    expect(exit.d.tasks[0].focusMinutes).toBe(10); expect(log(exit).totalMinutes).toBe(10);
    const skip = setup(['a'], false); skip.at(10); skip.d.focusTimerSeconds = 900; skip.call('skipFocusPhase');
    expect(skip.d.focusTaskMinutes).toEqual({}); expect(skip.d.focusCycleCount).toBe(1);
    const restart = setup(['a'], false); restart.at(10); restart.d.focusTimerSeconds = 900; restart.call('startFocusTimer');
    expect(restart.d.focusTimerSeconds).toBe(1500);
  });
});


describe('automatic single-task phase orchestration', () => {
  it('runs four unattended work/break cycles and records each phase once', async () => {
    const h = setup();
    for (let cycle = 0; cycle < 4; cycle++) {
      h.at(cycle * 30 + 25); h.d.focusTimerSeconds = 0; h.call('handleFocusTimerEnd');
      expect(h.review()).toBeNull();
      await Promise.resolve();
      expect(h.d.focusTimerRunning).toBe(true);
      expect(h.d.focusPhase).toBe(cycle === 3 ? 'longBreak' : 'shortBreak');
      expect(h.d.focusTimerSeconds).toBe(cycle === 3 ? 900 : 300);
      expect(h.d.focusCycleCount).toBe(cycle + 1);
      expect(h.records).toHaveLength(cycle + 1);
      expect(h.d.focusTaskMinutes).toEqual({ a: (cycle + 1) * 25 });
      if (cycle < 3) {
        h.at(cycle * 30 + 30); h.d.focusTimerSeconds = 0; h.call('handleFocusTimerEnd');
        expect(h.d.focusPhase).toBe('work');
      }
    }
    expect(new Set(h.records.map(row => row.id)).size).toBe(4);
    expect(h.records.map(row => [row.startTime, row.endTime])).toEqual([
      ['09:00', '09:25'], ['09:30', '09:55'], ['10:00', '10:25'], ['10:30', '10:55'],
    ]);
    expect(h.d.tasks[0].completed).toBe(false);
  });
  it.each([true, false])('single-task skip preserves its running state (%s)', async running => {
    const h = setup(); h.at(10); h.d.focusTimerSeconds = 900;
    if (!running) h.d.setFocusTimerRunning(false);
    h.call('skipFocusPhase'); await Promise.resolve();
    expect(h.review()).toBeNull();
    expect(h.records).toHaveLength(1);
    expect(h.d.focusTimerRunning).toBe(running);
    expect(h.d.focusPhase).toBe('shortBreak');
    expect(h.d.focusTaskMinutes).toEqual({});
  });
  it('declining a multi-task phase starts the break without saving or completing', () => {
    const h = setup(['a', 'b']); h.at(25); h.d.focusTimerSeconds = 0; h.call('handleFocusTimerEnd');
    expect(h.review()).not.toBeNull(); expect(h.d.focusTimerRunning).toBe(false);
    h.session.dismiss();
    expect(h.records).toEqual([]); expect(h.d.tasks.every(task => !task.completed)).toBe(true);
    expect(h.d.focusPhase).toBe('shortBreak'); expect(h.d.focusTimerRunning).toBe(true);
    expect(h.d.focusTaskMinutes).toEqual({ a: 12.5, b: 12.5 });
  });
  it('declining an early exit leaves previous automatic records intact', async () => {
    const h = setup(); h.at(25); h.d.focusTimerSeconds = 0; h.call('handleFocusTimerEnd'); await Promise.resolve();
    h.at(30); h.d.focusTimerSeconds = 0; h.call('handleFocusTimerEnd');
    h.at(32); h.d.focusTimerSeconds = 1380; h.call('exitFocusMode', false);
    expect(h.review()).not.toBeNull(); h.session.dismiss();
    expect(h.records).toHaveLength(1); expect(h.d.showFocusMode).toBe(false);
    expect(log(h)).toMatchObject({ totalMinutes: 32, cyclesCompleted: 1, tasksCompleted: 0 });
  });
});

describe('extracted Focus entry and exit lifecycle', () => {
  it('resolves a named task outside the current block, then starts and settles it', async () => {
    const h = setup(); h.d.showFocusMode = false; h.d.computeFocusBlockTasks = () => [];
    h.call('enterFocusMode', 'a');
    expect(h.d.focusBlockTasks.map(task => task.id)).toEqual(['a']);
    expect(h.d.focusShowSettings).toBe(true); expect(h.d.focusTimerRunning).toBe(false);
    h.call('startFocusTimer');
    h.at(25); h.d.focusTimerSeconds = 0; h.call('handleFocusTimerEnd'); await Promise.resolve();
    expect(h.records).toHaveLength(1); expect(h.review()).toBeNull();
    expect(h.d.focusPhase).toBe('shortBreak'); expect(h.d.focusTimerRunning).toBe(true);
  });
  it('keeps exit idempotent across renders and resets the guard for a new session', () => {
    const h = setup(); h.at(2); h.d.focusTimerSeconds = 1380; h.call('exitFocusMode');
    h.session.dismiss();
    expect(log(h).sessions).toBe(1); expect(h.d.focusShowStats).toBe(true);
    h.call('exitFocusMode'); expect(h.d.showFocusMode).toBe(false); expect(log(h).sessions).toBe(1);
    h.call('enterFocusMode'); h.call('startFocusTimer');
    h.at(4); h.d.focusTimerSeconds = 1380; h.call('exitFocusMode', false); h.session.dismiss();
    expect(log(h).sessions).toBe(2); expect(h.d.showFocusMode).toBe(false);
  });
});
