import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WELCOME_DISMISSED_KEY, isWelcomeDismissed, markWelcomeDismissed, shouldShowWelcomeAtBoot,
} from './welcomeTour.js';

describe('shouldShowWelcomeAtBoot (#2034)', () => {
  it('offers the tour to an empty device that has never closed it', () => {
    expect(shouldShowWelcomeAtBoot({ hasZeroRealTasks: true, dismissed: false })).toBe(true);
  });

  it('does not re-offer it once closed, even with an empty task list', () => {
    expect(shouldShowWelcomeAtBoot({ hasZeroRealTasks: true, dismissed: true })).toBe(false);
  });

  it('never offers it to a device with real tasks', () => {
    expect(shouldShowWelcomeAtBoot({ hasZeroRealTasks: false, dismissed: false })).toBe(false);
  });
});

describe('welcomeDismissed persistence', () => {
  let store;
  const original = globalThis.localStorage;
  beforeEach(() => {
    store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    };
  });
  afterEach(() => { globalThis.localStorage = original; });

  it('round-trips through localStorage under the key local backups carry', () => {
    expect(isWelcomeDismissed()).toBe(false);
    markWelcomeDismissed();
    expect(store.get(WELCOME_DISMISSED_KEY)).toBe('true');
    expect(isWelcomeDismissed()).toBe(true);
  });

  it('treats unreadable storage as not dismissed rather than throwing', () => {
    globalThis.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(isWelcomeDismissed()).toBe(false);
    expect(() => markWelcomeDismissed()).not.toThrow();
  });
});
